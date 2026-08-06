"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const {
    app,
    BrowserWindow,
    dialog,
    globalShortcut,
    ipcMain,
    Menu,
    nativeImage,
    net,
    shell,
    Tray,
    screen
} = require("electron");
const { agentDataDirectory: platformAgentDataDirectory, approvalDirectory: platformApprovalDirectory, platformLabel, stateDirectory: platformStateDirectory } = require("../bridge/platform-paths");
const { installLocalAi } = require("./ai-setup");
const { ApprovalStore } = require("./approval-store");
const { KeyboardActivityMonitor } = require("./keyboard-activity");
const { importImageFiles, versionedImageFileUrl } = require("./custom-assets");
const {
    findHardwareMascotSource,
    HARDWARE_MASCOT_MAX_BYTES,
    isFirmwareCompatibleMascot,
    prepareHardwareMascot
} = require("./hardware-image");
const { extractForegroundBitmap } = require("./foreground-extractor");
const { importStickerAnimation } = require("./sticker-importer");
const { shouldIgnoreMouse } = require("./interaction-policy");
const { downloadRelease, fetchLatestRelease } = require("./release-updater");
const { ResourceMonitor } = require("./resource-monitor");
const { SettingsStore } = require("./settings-store");
const { StateStore } = require("./state-store");
const { launchDownloadedUpdate: launchDownloadedApplication } = require("./update-launcher");
const { createTrayBitmap, TRAY_ICON_SIZE } = require("./tray-icon");

let mainWindow = null;
let tray = null;
let stateStore = null;
let approvalStore = null;
let keyboardMonitor = null;
let resourceMonitor = null;
let settingsStore = null;
let settings = null;
let latestApproval = null;
let latestApprovals = [];
let latestSnapshot = { state: "idle", sessions: [], counts: {} };
let typingActive = false;
let latestResources = null;
let sessionDetailsOpen = false;
let isQuitting = false;
let setupRunning = false;
let updateChecking = false;
let positionAdjusting = false;
let positionAdjustTimer = null;
let moveSaveTimer = null;
let suppressMoveSaveUntil = 0;
let rendererHitActive = false;
let bluetoothSelectionTimer = null;
let bluetoothSelectionCallback = null;

const BLUETOOTH_SELECTION_TIMEOUT_MS = 15000;

const BASE_SIZES = Object.freeze({
    pet: { width: 300, height: 350 },
    traffic: { width: 104, height: 236 }
});

function agentDataDirectory()
{
    return platformAgentDataDirectory();
}

function stateDirectory()
{
    return platformStateDirectory();
}

function approvalDirectory()
{
    return platformApprovalDirectory();
}

function customAssetDirectory()
{
    return path.join(app.getPath("userData"), "custom-assets");
}

function imageFileUrl(filePath)
{
    return versionedImageFileUrl(filePath);
}

function extractMascotImage(filePath)
{
    if (".gif" === path.extname(filePath).toLowerCase())
    {
        return filePath;
    }
    const sourceImage = nativeImage.createFromPath(filePath);
    const size = sourceImage.getSize();
    if (sourceImage.isEmpty() || 1 > size.width || 1 > size.height)
    {
        return filePath;
    }
    const result = extractForegroundBitmap(sourceImage.toBitmap(), size.width, size.height);
    if (!result.changed)
    {
        return filePath;
    }
    const processedImage = nativeImage.createFromBitmap(result.bitmap, {
        width: size.width,
        height: size.height,
        scaleFactor: 1
    }).crop(result.bounds);
    if (processedImage.isEmpty())
    {
        return filePath;
    }
    const outputPath = filePath.replace(/\.[^.]+$/, "-extracted.png");
    fs.writeFileSync(outputPath, processedImage.toPNG());
    return outputPath;
}

function publicWindowSettings()
{
    const windowsMetrics = "win32" === process.platform;
    return {
        ...settings,
        keyboardAnimation: windowsMetrics && settings.keyboardAnimation,
        animation: {
            ...settings.animation,
            mascotUrl: imageFileUrl(settings.animation.mascotPath),
            hoverFrameUrls: settings.animation.hoverFrames.map(imageFileUrl).filter(Boolean)
        },
        resources: {
            ...settings.resources,
            gpu: windowsMetrics && settings.resources.gpu,
            network: windowsMetrics && settings.resources.network
        }
    };
}
async function hardwareMascotPayload()
{
    if (!settings.hardware.enabled)
    {
        return { revision: "disabled", data: null };
    }

    let mascotPath = settings.animation.mascotPath;

    if (!mascotPath || !fs.existsSync(mascotPath))
    {
        return { revision: "default", data: null };
    }

    let hardwarePath = path.join(customAssetDirectory(), "mascot", "hardware-mascot.jpg");
    if ("hardware-mascot.jpg" === path.basename(mascotPath).toLowerCase())
    {
        hardwarePath = mascotPath;
        const restoredMascotPath = await findHardwareMascotSource(hardwarePath);
        if (restoredMascotPath)
        {
            mascotPath = restoredMascotPath;
            settings = settingsStore.update({ animation: { mascotPath } });
            applyWindowSettings();
        }
    }
    else
    {
        const sourceStat = fs.statSync(mascotPath);
        const hardwareIsCurrent = fs.existsSync(hardwarePath)
            && sourceStat.mtimeMs <= fs.statSync(hardwarePath).mtimeMs
            && await isFirmwareCompatibleMascot(hardwarePath);
        if (!hardwareIsCurrent)
        {
            hardwarePath = await prepareHardwareMascot(mascotPath, customAssetDirectory());
        }
    }

    const stat = fs.statSync(hardwarePath);
    if (!stat.isFile() || 4 > stat.size || HARDWARE_MASCOT_MAX_BYTES < stat.size)
    {
        throw new Error(`硬件桌宠图片必须小于 ${HARDWARE_MASCOT_MAX_BYTES / 1024} KB`);
    }

    const imageData = fs.readFileSync(hardwarePath);
    return {
        revision: `${stat.size}:${Math.round(stat.mtimeMs)}`,
        md5: crypto.createHash("md5").update(imageData).digest("hex"),
        data: Array.from(imageData)
    };
}
function loginExecutable()
{
    return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function loginItemOptions(openAtLogin)
{
    const options = {};
    if ("boolean" === typeof openAtLogin)
    {
        options.openAtLogin = openAtLogin;
    }
    if ("win32" === process.platform)
    {
        options.path = loginExecutable();
    }
    return options;
}
function createTrayImage(state)
{
    return nativeImage.createFromBitmap(createTrayBitmap(state), {
        width: TRAY_ICON_SIZE,
        height: TRAY_ICON_SIZE,
        scaleFactor: 1
    });
}

function currentBaseSize()
{
    return BASE_SIZES[settings.displayMode] || BASE_SIZES.pet;
}

function placeWindow(forceDefault = false)
{
    if (!mainWindow)
    {
        return;
    }

    const defaultBounds = screen.getPrimaryDisplay().workArea;
    const bounds = !forceDefault && settings.position
        ? screen.getDisplayNearestPoint(settings.position).workArea
        : defaultBounds;
    const [width, height] = mainWindow.getSize();
    const preferred = !forceDefault && settings.position
        ? settings.position
        : { x: bounds.x + bounds.width - width - 24, y: bounds.y + bounds.height - height - 18 };
    const x = Math.max(bounds.x, Math.min(preferred.x, bounds.x + bounds.width - width));
    const y = Math.max(bounds.y, Math.min(preferred.y, bounds.y + bounds.height - height));
    suppressMoveSaveUntil = Date.now() + 500;
    mainWindow.setPosition(x, y, false);
}

function maintainWindowLayer()
{
    if (!mainWindow || mainWindow.isDestroyed())
    {
        return;
    }
    mainWindow.setAlwaysOnTop(true, "screen-saver");
}

function bringWindowToFront()
{
    if (!mainWindow || mainWindow.isDestroyed())
    {
        return;
    }
    maintainWindowLayer();
    if (!mainWindow.isVisible())
    {
        mainWindow.showInactive();
    }
    mainWindow.moveTop();
}

function saveWindowPosition()
{
    if (!mainWindow || Date.now() < suppressMoveSaveUntil)
    {
        return;
    }

    if (moveSaveTimer)
    {
        clearTimeout(moveSaveTimer);
    }
    moveSaveTimer = setTimeout(() => {
        moveSaveTimer = null;
        const [x, y] = mainWindow.getPosition();
        settings = settingsStore.update({ position: { x, y } });
    }, 250);
}

function setPositionAdjusting(active)
{
    if (positionAdjustTimer)
    {
        clearTimeout(positionAdjustTimer);
        positionAdjustTimer = null;
    }
    positionAdjusting = true === active && true === settings.clickThrough;
    applyInteractionMode();
    if (mainWindow && !mainWindow.isDestroyed())
    {
        mainWindow.webContents.send("position-adjust-mode", positionAdjusting);
        if (positionAdjusting)
        {
            mainWindow.show();
            positionAdjustTimer = setTimeout(() => setPositionAdjusting(false), 20000);
        }
    }
    rebuildTrayMenu();
}

function applyInteractionMode()
{
    if (!mainWindow)
    {
        return;
    }

    const ignoreMouse = shouldIgnoreMouse({
        clickThrough: settings.clickThrough,
        hasApproval: Boolean(latestApproval),
        positionAdjusting,
        sessionDetailsOpen,
        rendererHitActive
    });
    mainWindow.setIgnoreMouseEvents(ignoreMouse, { forward: true });
}

function applyWindowSettings()
{
    if (!mainWindow)
    {
        return;
    }

    const base = currentBaseSize();
    mainWindow.setSize(
        Math.round(base.width * settings.scale),
        Math.round(base.height * settings.scale),
        true
    );
    mainWindow.setOpacity(settings.opacity);
    maintainWindowLayer();
    applyInteractionMode();
    mainWindow.webContents.send("display-mode", settings.displayMode);
    mainWindow.webContents.send("window-settings", publicWindowSettings());
    placeWindow();
}

function updateSettings(changes)
{
    settings = settingsStore.update(changes);
    if (false === settings.clickThrough && positionAdjusting)
    {
        setPositionAdjusting(false);
    }
    applyWindowSettings();
    syncKeyboardMonitor();
    syncResourceMonitor();
    rebuildTrayMenu();
}

function applyDisplayMode(mode)
{
    updateSettings({ displayMode: "traffic" === mode ? "traffic" : "pet" });
}

function syncKeyboardMonitor()
{
    if (!keyboardMonitor)
    {
        return;
    }

    if (settings.keyboardAnimation)
    {
        keyboardMonitor.start();
    }
    else
    {
        keyboardMonitor.stop();
    }
}

function syncResourceMonitor()
{
    if (!resourceMonitor)
    {
        return;
    }

    if (settings.resources.enabled)
    {
        resourceMonitor.start();
    }
    else
    {
        resourceMonitor.stop();
        latestResources = null;
        if (mainWindow && !mainWindow.isDestroyed())
        {
            mainWindow.webContents.send("resource-usage", null);
        }
    }
}

function publishResources(snapshot)
{
    latestResources = snapshot;
    if (mainWindow && !mainWindow.isDestroyed())
    {
        mainWindow.webContents.send("resource-usage", snapshot);
    }
}

function publishTypingActivity(active)
{
    typingActive = active;
    if (mainWindow && !mainWindow.isDestroyed())
    {
        mainWindow.webContents.send("typing-activity", active);
    }
}

function setSessionDetailsOpen(open)
{
    sessionDetailsOpen = true === open;
    applyInteractionMode();
    if (mainWindow && !mainWindow.isDestroyed())
    {
        if (sessionDetailsOpen)
        {
            mainWindow.show();
        }
        mainWindow.webContents.send("show-session-details", sessionDetailsOpen);
    }
    rebuildTrayMenu();
}
function decideApproval(decision, requestId = latestApproval && latestApproval.id)
{
    if (!requestId || !approvalStore)
    {
        return false;
    }

    const request = latestApprovals.find((item) => item.id === requestId);
    if (!request)
    {
        return false;
    }

    const accepted = approvalStore.decide(request.id, decision);
    if (accepted)
    {
        latestApprovals = latestApprovals.filter((item) => item.id !== request.id);
        latestApproval = latestApprovals[0] || null;
        if (stateStore)
        {
            stateStore.setApprovalRequests(latestApprovals);
        }
        if (mainWindow && !mainWindow.isDestroyed())
        {
            mainWindow.webContents.send("approval-request", latestApproval);
            mainWindow.webContents.send("approval-requests", latestApprovals);
        }
        applyInteractionMode();
        rebuildTrayMenu();
    }
    return accepted;
}

function publishApprovals(requests)
{
    latestApprovals = Array.isArray(requests) ? requests : [];
    latestApproval = latestApprovals[0] || null;
    if (stateStore)
    {
        stateStore.setApprovalRequests(latestApprovals);
    }
    if (mainWindow && !mainWindow.isDestroyed())
    {
        if (latestApproval)
        {
            mainWindow.show();
        }
        mainWindow.webContents.send("approval-request", latestApproval);
        mainWindow.webContents.send("approval-requests", latestApprovals);
        mainWindow.webContents.send("resource-usage", latestResources);
        mainWindow.webContents.send("position-adjust-mode", positionAdjusting);
        applyInteractionMode();
    }
    rebuildTrayMenu();
}

async function dismissSession(sessionId, force = false)
{
    const session = latestSnapshot.sessions.find((item) => item.id === sessionId);
    if (!session)
    {
        return false;
    }

    const dismissible = ["idle", "completed", "error"].includes(session.state);
    if (!dismissible && !force)
    {
        return false;
    }

    if (!dismissible)
    {
        const result = await dialog.showMessageBox(mainWindow, {
            type: "warning",
            buttons: ["取消", "强制关闭"],
            defaultId: 0,
            cancelId: 0,
            title: "强制关闭会话记录",
            message: `确定关闭 ${session.provider || "Agent"} 会话记录吗？`,
            detail: "这只会移除桌宠中的状态和待审批提示，不会终止 Agent。若 Agent 继续发送 hook，会话可能重新出现。",
            noLink: true
        });
        if (1 !== result.response)
        {
            return false;
        }
        approvalStore.dismissSession(sessionId);
    }

    return stateStore.remove(sessionId);
}

function formatSetupResult(result)
{
    const label = platformLabel(result.platform);
    const local = result.local.ok
        ? `✓ ${label} 已配置并自检通过`
        : `✗ ${label}：${result.local.message}`;
    const wsl = result.wsl
        ? (result.wsl.ok ? "✓ 默认 WSL 已配置并自检通过" : `△ 默认 WSL：${result.wsl.message}`)
        : null;
    return `${[local, wsl].filter(Boolean).join("\n")}\n\n配置只对重启后的新会话生效。请完全关闭并重新打开 Codex / Claude Code；Codex 中输入 /hooks，并信任新增的 Agent Pet SessionStart hook。`;
}

function runOneClickSetup()
{
    if (setupRunning)
    {
        return;
    }

    setupRunning = true;
    rebuildTrayMenu();
    setImmediate(() => {
        const result = installLocalAi(agentDataDirectory());
        setupRunning = false;
        rebuildTrayMenu();
        dialog.showMessageBox(mainWindow, {
            type: result.local.ok ? "info" : "error",
            title: "Agent Pet 一键配置",
            message: "本机 AI 配置完成",
            detail: formatSetupResult(result),
            buttons: ["知道了"]
        });
    });
}

async function chooseMascotImage()
{
    const result = await dialog.showOpenDialog(mainWindow, {
        title: "选择桌宠主图",
        properties: ["openFile"],
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }]
    });
    if (result.canceled)
    {
        return;
    }
    try
    {
        const [importedPath] = importImageFiles(result.filePaths, customAssetDirectory(), "mascot");
        const sourcePath = settings.animation.autoExtractMascot
            ? extractMascotImage(importedPath)
            : importedPath;
        if (settings.hardware.enabled)
        {
            await prepareHardwareMascot(sourcePath, customAssetDirectory());
        }
        updateSettings({ animation: { mascotPath: sourcePath } });
    }
    catch (error)
    {
        dialog.showErrorBox("无法导入桌宠图片", error.message);
    }
}

async function chooseHoverFrames()
{
    const result = await dialog.showOpenDialog(mainWindow, {
        title: "选择悬停动画帧（按文件名排序）",
        properties: ["openFile", "multiSelections"],
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }]
    });
    if (result.canceled)
    {
        return;
    }
    try
    {
        const hoverFrames = importImageFiles(result.filePaths, customAssetDirectory(), "hover");
        updateSettings({ animation: { hoverFrames, hoverFrameDurations: [], hoverEnabled: true } });
    }
    catch (error)
    {
        dialog.showErrorBox("无法导入悬停动画帧", error.message);
    }
}
async function chooseStickerAnimation()
{
    const result = await dialog.showOpenDialog(mainWindow, {
        title: "选择 GIF 动画",
        properties: ["openFile"],
        filters: [{ name: "GIF 动画", extensions: ["gif"] }]
    });
    if (result.canceled)
    {
        return;
    }

    try
    {
        const imported = await importStickerAnimation(result.filePaths[0], customAssetDirectory());
        const averageDuration = imported.frameDurations.reduce((total, duration) => total + duration, 0)
            / imported.frameDurations.length;
        updateSettings({
            animation: {
                hoverFrames: imported.framePaths,
                hoverFrameDurations: imported.frameDurations,
                hoverFrameMs: Math.max(60, Math.min(500, Math.round(averageDuration))),
                hoverEnabled: true
            }
        });
        await dialog.showMessageBox(mainWindow, {
            type: "info",
            title: "GIF 动画导入完成",
            message: `已导入 ${imported.frameCount} 帧 GIF 动画`,
            detail: imported.sourceFrameCount > imported.frameCount
                ? `原始 ${imported.sourceFrameCount} 帧已等时长采样为 ${imported.frameCount} 帧。`
                : "已保留原始逐帧播放时长，可通过“悬停帧速度”整体调速。",
            buttons: ["知道了"]
        });
    }
    catch (error)
    {
        dialog.showErrorBox("无法导入 GIF 动画", error.message);
    }
}

function launchDownloadedUpdate(filePath)
{
    if ("win32" === process.platform)
    {
        isQuitting = true;
    }
    return launchDownloadedApplication(app, filePath, {
        platform: process.platform,
        openPath: (downloadedPath) => shell.openPath(downloadedPath)
    });
}

async function checkForUpdates()
{
    if (updateChecking)
    {
        return;
    }
    updateChecking = true;
    rebuildTrayMenu();
    try
    {
        const fetchImplementation = (url, options) => net.fetch(url, options);
        const update = await fetchLatestRelease(
            fetchImplementation,
            app.getVersion(),
            settings.updateSource
        );
        if (!update.updateAvailable)
        {
            await dialog.showMessageBox(mainWindow, {
                type: "info",
                title: "Agent Pet 更新",
                message: `当前已经是最新版本 v${app.getVersion()}`,
                detail: `更新源：${update.sourceLabel}`,
                buttons: ["知道了"]
            });
            return;
        }

        const decision = await dialog.showMessageBox(mainWindow, {
            type: "info",
            title: "发现 Agent Pet 新版本",
            message: `${update.releaseName} 可以下载`,
            detail: String(update.releaseNotes || "点击下载后会进行 SHA256 校验。").slice(0, 1200),
            buttons: ["下载更新", "稍后"],
            defaultId: 0,
            cancelId: 1
        });
        if (0 !== decision.response)
        {
            return;
        }

        const downloaded = await downloadRelease(
            fetchImplementation,
            update,
            app.getPath("downloads"),
            ({ downloadedBytes, totalBytes }) => {
                if (tray && 0 < totalBytes)
                {
                    const percent = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
                    tray.setToolTip(`Agent Pet · 正在下载更新 ${percent}%`);
                }
            }
        );
        const completed = await dialog.showMessageBox(mainWindow, {
            type: "info",
            title: "Agent Pet 更新下载完成",
            message: `${update.releaseName} 已下载并通过 SHA256 校验`,
            detail: downloaded.destinationPath,
            buttons: "darwin" === process.platform
                ? ["打开安装镜像", "打开下载位置", "稍后"]
                : ["退出并启动新版本", "打开下载位置", "稍后"],
            defaultId: 0,
            cancelId: 2
        });
        if (0 === completed.response)
        {
            launchDownloadedUpdate(downloaded.destinationPath);
        }
        else if (1 === completed.response)
        {
            shell.showItemInFolder(downloaded.destinationPath);
        }
    }
    catch (error)
    {
        dialog.showErrorBox("Agent Pet 更新失败", error.message);
    }
    finally
    {
        updateChecking = false;
        rebuildTrayMenu();
    }
}

function rebuildTrayMenu()
{
    if (!tray || !settings)
    {
        return;
    }

    const autoStart = app.getLoginItemSettings(loginItemOptions()).openAtLogin;
    const scaleItems = [[0.75, "75%"], [1, "100%"], [1.25, "125%"], [1.5, "150%"]];
    const opacityItems = [[0.5, "50%"], [0.75, "75%"], [0.9, "90%"], [1, "100%"]];

    tray.setContextMenu(Menu.buildFromTemplate([
        {
            label: mainWindow && mainWindow.isVisible() ? "隐藏桌宠" : "显示桌宠",
            click: () => {
                if (mainWindow.isVisible())
                {
                    mainWindow.hide();
                }
                else
                {
                    mainWindow.showInactive();
                }
                rebuildTrayMenu();
            }
        },
        {
            label: "将桌宠显示到最前面",
            click: bringWindowToFront
        },
        { type: "separator" },
        {
            label: "桌宠模式",
            type: "radio",
            checked: "pet" === settings.displayMode,
            click: () => applyDisplayMode("pet")
        },
        {
            label: "红绿灯模式",
            type: "radio",
            checked: "traffic" === settings.displayMode,
            click: () => applyDisplayMode("traffic")
        },
        {
            label: "大小",
            submenu: scaleItems.map(([value, label]) => ({
                label,
                type: "radio",
                checked: value === settings.scale,
                click: () => updateSettings({ scale: value })
            }))
        },
        {
            label: "透明度",
            submenu: opacityItems.map(([value, label]) => ({
                label,
                type: "radio",
                checked: value === settings.opacity,
                click: () => updateSettings({ opacity: value })
            }))
        },
        {
            label: "鼠标穿透模式  Ctrl+Shift+Alt+P",
            type: "checkbox",
            checked: settings.clickThrough,
            click: (item) => updateSettings({ clickThrough: item.checked })
        },
        {
            label: positionAdjusting ? "完成位置调整" : "调整位置（20 秒）  Ctrl+Shift+Alt+M",
            enabled: settings.clickThrough,
            click: () => setPositionAdjusting(!positionAdjusting)
        },
        {
            label: "恢复到右下角",
            click: () => {
                settings = settingsStore.update({ position: null });
                placeWindow(true);
                rebuildTrayMenu();
            }
        },
        {
            label: "外观与动画",
            submenu: [
                {
                    label: "动画风格",
                    submenu: [
                        ["classic", "经典"],
                        ["playful", "活泼"],
                        ["gentle", "轻柔"],
                        ["still", "静止"]
                    ].map(([value, label]) => ({
                        label,
                        type: "radio",
                        checked: value === settings.animation.style,
                        click: () => updateSettings({ animation: { style: value } })
                    }))
                },
                {
                    label: "鼠标悬停随机动画",
                    type: "checkbox",
                    checked: settings.animation.hoverEnabled,
                    click: (item) => updateSettings({ animation: { hoverEnabled: item.checked } })
                },
                {
                    label: "悬停帧速度",
                    submenu: [[70, "快速"], [110, "标准"], [180, "慢速"]].map(([value, label]) => ({
                        label,
                        type: "radio",
                        checked: value === settings.animation.hoverFrameMs,
                        click: () => updateSettings({ animation: { hoverFrameMs: value } })
                    }))
                },
                { type: "separator" },
                {
                    label: "主图自动去背景和裁边",
                    type: "checkbox",
                    checked: settings.animation.autoExtractMascot,
                    click: (item) => updateSettings({ animation: { autoExtractMascot: item.checked } })
                },
                { label: "更换桌宠主图…", click: chooseMascotImage },
                { label: "导入 GIF 动画…", click: chooseStickerAnimation },
                { label: "导入悬停动画帧…", click: chooseHoverFrames },
                {
                    label: "恢复默认主图",
                    enabled: Boolean(settings.animation.mascotPath),
                    click: () => updateSettings({ animation: { mascotPath: null } })
                },
                {
                    label: "清除悬停动画帧",
                    enabled: 0 < settings.animation.hoverFrames.length,
                    click: () => updateSettings({ animation: { hoverFrames: [], hoverFrameDurations: [] } })
                }
            ]
        },
        {
            label: "电脑资源显示",
            submenu: [
                {
                    label: "启用资源监控（数据仅保留在本机）",
                    type: "checkbox",
                    checked: settings.resources.enabled,
                    click: (item) => updateSettings({ resources: { enabled: item.checked } })
                },
                { type: "separator" },
                {
                    label: "CPU",
                    type: "checkbox",
                    checked: settings.resources.cpu,
                    click: (item) => updateSettings({ resources: { cpu: item.checked } })
                },
                {
                    label: "GPU",
                    type: "checkbox",
                    checked: "win32" === process.platform && settings.resources.gpu,
                    enabled: "win32" === process.platform,
                    click: (item) => updateSettings({ resources: { gpu: item.checked } })
                },
                {
                    label: "内存",
                    type: "checkbox",
                    checked: settings.resources.memory,
                    click: (item) => updateSettings({ resources: { memory: item.checked } })
                },
                {
                    label: "网速（下行 / 上行）",
                    type: "checkbox",
                    checked: "win32" === process.platform && settings.resources.network,
                    enabled: "win32" === process.platform,
                    click: (item) => updateSettings({ resources: { network: item.checked } })
                }
            ]
        },
        {
            label: "键盘打字动画（不记录按键）",
            type: "checkbox",
            checked: "win32" === process.platform && settings.keyboardAnimation,
            enabled: "win32" === process.platform,
            click: (item) => updateSettings({ keyboardAnimation: item.checked })
        },
        {
            label: "启用 BLE 硬件联动",
            type: "checkbox",
            checked: settings.hardware.enabled,
            click: (item) => updateSettings({ hardware: { enabled: item.checked } })
        },
        { type: "separator" },
        {
            label: sessionDetailsOpen ? "关闭会话详情" : `查看 ${latestSnapshot.sessions.length} 个会话详情  Ctrl+Shift+Alt+S`,
            enabled: 0 < latestSnapshot.sessions.length,
            click: () => setSessionDetailsOpen(!sessionDetailsOpen)
        },
        {
            label: latestApproval ? "允许当前授权  Ctrl+Shift+Enter" : "当前没有待授权操作",
            enabled: Boolean(latestApproval),
            click: () => decideApproval("allow")
        },
        {
            label: "拒绝当前授权  Ctrl+Shift+Backspace",
            enabled: Boolean(latestApproval),
            click: () => decideApproval("deny")
        },
        { type: "separator" },
        {
            label: setupRunning ? "正在配置本机 AI…" : ("darwin" === process.platform ? "一键配置本机 AI（macOS）" : "一键配置本机 AI（Windows + 默认 WSL）"),
            enabled: !setupRunning,
            click: runOneClickSetup
        },
        {
            label: "打开状态目录",
            click: () => shell.openPath(stateDirectory())
        },
        {
            label: "清理已结束会话",
            click: () => stateStore.clearFinished()
        },
        {
            label: updateChecking ? "正在检查更新…" : `检查更新…（当前 v${app.getVersion()}）`,
            enabled: !updateChecking,
            click: checkForUpdates
        },
        {
            label: "更新源",
            submenu: [
                ["github", "GitHub"],
                ["gitee", "Gitee（国内镜像）"]
            ].map(([value, label]) => ({
                label,
                type: "radio",
                checked: value === settings.updateSource,
                enabled: !updateChecking,
                click: () => updateSettings({ updateSource: value })
            }))
        },
        {
            label: "开机启动",
            type: "checkbox",
            checked: autoStart,
            click: (item) => app.setLoginItemSettings(loginItemOptions(item.checked))
        },
        { type: "separator" },
        {
            label: "退出 Agent Pet",
            click: () => {
                isQuitting = true;
                app.quit();
            }
        }
    ]));
}

function createWindow()
{
    mainWindow = new BrowserWindow({
        width: BASE_SIZES.pet.width,
        height: BASE_SIZES.pet.height,
        transparent: true,
        frame: false,
        resizable: false,
        show: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        hasShadow: false,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    maintainWindowLayer();
    mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
    mainWindow.webContents.on("select-bluetooth-device", (event, devices, callback) => {
        event.preventDefault();
        bluetoothSelectionCallback = callback;
        const device = devices.find((candidate) => String(candidate.deviceName || "").startsWith("AgentPet-"));
        if (device)
        {
            clearTimeout(bluetoothSelectionTimer);
            bluetoothSelectionTimer = null;
            bluetoothSelectionCallback = null;
            callback(device.deviceId);
            return;
        }
        if (!bluetoothSelectionTimer)
        {
            bluetoothSelectionTimer = setTimeout(() => {
                const pendingCallback = bluetoothSelectionCallback;
                bluetoothSelectionTimer = null;
                bluetoothSelectionCallback = null;
                if (pendingCallback)
                {
                    pendingCallback("");
                }
            }, BLUETOOTH_SELECTION_TIMEOUT_MS);
        }
    });
    mainWindow.once("ready-to-show", () => {
        applyWindowSettings();
        bringWindowToFront();
        mainWindow.webContents.send("agent-state", latestSnapshot);
        mainWindow.webContents.send("typing-activity", typingActive);
        mainWindow.webContents.send("approval-request", latestApproval);
        mainWindow.webContents.send("approval-requests", latestApprovals);
        mainWindow.webContents.send("resource-usage", latestResources);
        mainWindow.webContents.send("position-adjust-mode", positionAdjusting);
    });
    mainWindow.on("show", () => {
        maintainWindowLayer();
        mainWindow.moveTop();
    });
    mainWindow.on("move", saveWindowPosition);
    mainWindow.on("close", (event) => {
        if (!isQuitting)
        {
            event.preventDefault();
            mainWindow.hide();
            rebuildTrayMenu();
        }
    });
}

function createTray()
{
    tray = new Tray(createTrayImage("idle"));
    tray.setToolTip("Agent Pet · 空闲");
    tray.on("click", () => {
        bringWindowToFront();
        rebuildTrayMenu();
    });
    rebuildTrayMenu();
}

function publishSnapshot(snapshot)
{
    latestSnapshot = snapshot;
    if (mainWindow && !mainWindow.isDestroyed())
    {
        mainWindow.webContents.send("agent-state", snapshot);
    }
    if (tray)
    {
        tray.setImage(createTrayImage(snapshot.state));
        const provider = snapshot.active ? snapshot.active.provider : "Agent";
        tray.setToolTip(`Agent Pet · ${provider} · ${snapshot.state}`);
    }
    rebuildTrayMenu();
}

function registerGlobalShortcuts()
{
    globalShortcut.register("CommandOrControl+Shift+Enter", () => decideApproval("allow"));
    globalShortcut.register("CommandOrControl+Shift+Backspace", () => decideApproval("deny"));
    globalShortcut.register("CommandOrControl+Shift+Alt+P", () => {
        updateSettings({ clickThrough: !settings.clickThrough });
    });
    globalShortcut.register("CommandOrControl+Shift+Alt+M", () => {
        setPositionAdjusting(!positionAdjusting);
    });
    globalShortcut.register("CommandOrControl+Shift+Alt+S", () => {
        if (0 < latestSnapshot.sessions.length)
        {
            setSessionDetailsOpen(!sessionDetailsOpen);
        }
    });
}

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock)
{
    app.quit();
}
else
{
    app.on("second-instance", () => {
        if (mainWindow)
        {
            bringWindowToFront();
        }
    });

    app.whenReady().then(() => {
        if ("darwin" === process.platform && app.dock)
        {
            app.dock.hide();
        }
        fs.mkdirSync(stateDirectory(), { recursive: true });
        fs.mkdirSync(approvalDirectory(), { recursive: true });
        settingsStore = new SettingsStore(path.join(app.getPath("userData"), "settings.json"));
        settings = settingsStore.load();

        createWindow();
        createTray();

        stateStore = new StateStore(stateDirectory());
        stateStore.on("change", publishSnapshot);
        stateStore.start();

        approvalStore = new ApprovalStore(approvalDirectory());
        approvalStore.on("change", publishApprovals);
        approvalStore.start();

        keyboardMonitor = new KeyboardActivityMonitor();
        keyboardMonitor.on("change", publishTypingActivity);
        syncKeyboardMonitor();

        resourceMonitor = new ResourceMonitor();
        resourceMonitor.on("change", publishResources);
        syncResourceMonitor();
        registerGlobalShortcuts();

        ipcMain.on("set-display-mode", (_event, mode) => applyDisplayMode(mode));
        ipcMain.on("pointer-hit-state", (_event, active) => {
            const nextHitActive = true === active;
            if (rendererHitActive === nextHitActive)
            {
                return;
            }
            rendererHitActive = nextHitActive;
            applyInteractionMode();
        });
        ipcMain.on("hide-window", () => {
            mainWindow.hide();
            rebuildTrayMenu();
        });
        ipcMain.on("approval-decision", (_event, payload) => {
            if (payload && "object" === typeof payload)
            {
                decideApproval(payload.decision, payload.requestId);
            }
            else
            {
                decideApproval(payload);
            }
        });
        ipcMain.handle("hardware-mascot-image", () => hardwareMascotPayload());
        ipcMain.handle("dismiss-session", (_event, payload) => {
            if (payload && "object" === typeof payload)
            {
                return dismissSession(payload.sessionId, true === payload.force);
            }
            return dismissSession(payload);
        });
        ipcMain.on("clear-finished-sessions", () => stateStore.clearFinished());
        ipcMain.on("session-details-state", (_event, open) => {
            sessionDetailsOpen = true === open;
            applyInteractionMode();
            rebuildTrayMenu();
        });
        ipcMain.on("window-drag", (_event, dx, dy) => {
            if (mainWindow && Number.isFinite(dx) && Number.isFinite(dy))
            {
                const [x, y] = mainWindow.getPosition();
                mainWindow.setPosition(x + dx, y + dy);
            }
        });
    });
}

app.on("before-quit", () => {
    isQuitting = true;
    globalShortcut.unregisterAll();
    if (positionAdjustTimer)
    {
        clearTimeout(positionAdjustTimer);
    }
    if (moveSaveTimer)
    {
        clearTimeout(moveSaveTimer);
    }
    if (stateStore)
    {
        stateStore.stop();
    }
    if (approvalStore)
    {
        approvalStore.stop();
    }
    if (keyboardMonitor)
    {
        keyboardMonitor.stop();
    }
    if (resourceMonitor)
    {
        resourceMonitor.stop();
    }
});

app.on("window-all-closed", (event) => event.preventDefault());
