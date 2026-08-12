"use strict";

const STATE_PRESENTATION = Object.freeze({
    idle: { title: "空闲中", fallback: "等你派任务给我", badge: "Z", traffic: "空闲" },
    running: { title: "努力工作中", fallback: "正在处理任务…", badge: "⚙", traffic: "执行中" },
    completed: { title: "任务完成啦", fallback: "快来看看成果吧！", badge: "✓", traffic: "已完成" },
    needs_input: { title: "需要你的决定", fallback: "有一个问题等你处理", badge: "?", traffic: "待输入" },
    error: { title: "遇到问题了", fallback: "请回到终端查看错误", badge: "!", traffic: "异常" }
});

const statusTitle = document.getElementById("status-title");
const statusMessage = document.getElementById("status-message");
const stateBadge = document.getElementById("state-badge");
const providerLabel = document.getElementById("provider-label");
const sessionCount = document.getElementById("session-count");
const trafficLabel = document.getElementById("traffic-label");
const approvalPanel = document.getElementById("approval-panel");
const approvalProvider = document.getElementById("approval-provider");
const approvalTool = document.getElementById("approval-tool");
const approvalSummary = document.getElementById("approval-summary");
const resourcePanel = document.getElementById("resource-panel");
const resourceCpu = document.getElementById("resource-cpu");
const resourceGpu = document.getElementById("resource-gpu");
const resourceMemory = document.getElementById("resource-memory");
const resourceNetwork = document.getElementById("resource-network");
const mascot = document.getElementById("mascot");
const sessionDetailsPanel = document.getElementById("session-details-panel");
const sessionDetailsList = document.getElementById("session-details-list");
const sessionDetailsSubtitle = document.getElementById("session-details-subtitle");
const sessionSummary = document.getElementById("session-summary");
const clearFinishedButton = document.getElementById("clear-finished-sessions");
const woodenFishScene = document.getElementById("wooden-fish-scene");
const meritToast = document.getElementById("merit-toast");
const woodenFishSound = document.getElementById("wooden-fish-sound");
const clickSpeedLabel = document.getElementById("click-speed-label");
const dailyMeritSummary = document.getElementById("daily-merit-summary");
const transcriptionPanel = document.getElementById("transcription-panel");
const transcriptionStatus = document.getElementById("transcription-status");
const transcriptionDetail = document.getElementById("transcription-detail");
const conversationInput = document.getElementById("conversation-input");
const transcriptionCopy = document.getElementById("transcription-copy");
const transcriptionClear = document.getElementById("transcription-clear");
const transcriptionClose = document.getElementById("transcription-close");
const transcriptionToggle = document.getElementById("transcription-toggle");

const hardwareButton = document.getElementById("hardware-button");
const hardwareProtocol = window.AgentPetHardwareProtocol;
const hardwareStatus = window.AgentPetHardwareStatus;
const hardwareProtocolEncoder = new hardwareProtocol.HardwareProtocolEncoder();
let latestSnapshot = { state: "idle", active: null, sessions: [] };
let typingActive = false;
let approvalRequest = null;
let approvalRequests = [];
let latestResources = null;
let windowSettings = { hardware: { enabled: false }, resources: { enabled: true, cpu: true, gpu: true, memory: true, network: true } };
let positionAdjusting = false;
let sessionDetailsOpen = false;
let animationSettings = { style: "classic", hoverEnabled: true, mascotUrl: null, hoverAnimations: [], hoverFrameUrls: [], hoverFrameDurations: [], hoverFrameMs: 110 };
let hoverTimer = null;
let hardwareHoverActive = false;
let hardwareTypingActive = null;
let woodenFishTimer = null;
let meritCount = 0;
let lastWoodenFishHitAt = 0;
let dailyMeritSummaryTimer = null;
let hardwareImageRequest = 0;
let hardwareEnabled = false;
let transcriptionSessionId = null;
let transcriptionUserEdited = false;
let transcriptionControlState = "idle";
let transcriptionStartTimer = null;
let transcriptionDismissAfterStop = false;
let localSttRuntimeReady = false;
const TRANSCRIPTION_START_TIMEOUT_MS = 8000;
const defaultMascotUrl = mascot.src;
const HOVER_ACTIONS = ["hop", "wave", "spin", "squash"];
const DAILY_MERIT_STORAGE_KEY = "agent-pet.daily-merit.v1";
const WOODEN_FISH_IDLE_MS = 950;
const TRANSCRIPTION_STATUS = Object.freeze({
    idle: "等待录音",
    listening: "正在接收录音",
    transcribing: "本地识别中…",
    complete: "转写完成",
    error: "转写失败"
});
function clearTranscriptionStartTimer()
{
    clearTimeout(transcriptionStartTimer);
    transcriptionStartTimer = null;
}

function updateTranscriptionToggle()
{
    const connected = hardwareClient.isConnected();
    const presentations = {
        idle: ["\uD83C\uDFA4 \u5F00\u59CB\u8F6C\u5199", "\u4F7F\u7528\u8BBE\u5907\u9EA6\u514B\u98CE\u5F00\u59CB\u672C\u5730\u8F6C\u5199"],
        starting: ["\u542F\u52A8\u4E2D\u2026", "\u6B63\u5728\u542F\u52A8\u8BBE\u5907\u9EA6\u514B\u98CE"],
        active: ["\u25A0 \u505C\u6B62\u8F6C\u5199", "\u505C\u6B62\u91C7\u96C6\u5E76\u63D0\u4EA4\u672C\u5730\u8F6C\u5199"],
        stopping: ["\u505C\u6B62\u4E2D\u2026", "\u6B63\u5728\u7ED3\u675F\u8BBE\u5907\u91C7\u96C6"]
    };
    const presentation = presentations[transcriptionControlState] || presentations.idle;

    transcriptionToggle.hidden = !hardwareEnabled;
    transcriptionToggle.dataset.state = transcriptionControlState;
    transcriptionToggle.textContent = presentation[0];
    transcriptionToggle.title = presentation[1];
    transcriptionToggle.disabled = "starting" === transcriptionControlState ||
        "stopping" === transcriptionControlState ||
        ("idle" === transcriptionControlState && (!connected || !localSttRuntimeReady));
}

async function requestTranscriptionStop(dismissAfterStop = false)
{
    if (dismissAfterStop)
    {
        transcriptionDismissAfterStop = true;
    }
    if ("active" !== transcriptionControlState)
    {
        return false;
    }

    transcriptionControlState = "stopping";
    updateTranscriptionToggle();
    try
    {
        await hardwareClient.requestAudioStream(false);
        return true;
    }
    catch (error)
    {
        transcriptionControlState = "active";
        if (dismissAfterStop)
        {
            transcriptionDismissAfterStop = false;
        }
        updateTranscriptionToggle();
        applyLocalSttUpdate({
            status: "error",
            text: conversationInput.value,
            error: error.message,
            sessionId: transcriptionSessionId,
            isFinal: false
        });
        return false;
    }
}

function failTranscriptionControl(error)
{
    const dismissPanel = transcriptionDismissAfterStop;
    transcriptionDismissAfterStop = false;
    clearTranscriptionStartTimer();
    transcriptionControlState = "idle";
    hardwareClient.setAudioStreamActive(false);
    updateTranscriptionToggle();
    if (dismissPanel)
    {
        void window.agentPet.clearLocalTranscription();
        return;
    }
    applyLocalSttUpdate({
        status: "error",
        text: conversationInput.value,
        error: error.message,
        sessionId: transcriptionSessionId,
        isFinal: false
    });
}

const hardwareAudioReceiver = new window.AgentPetHardwareAudio.HardwareAudioReceiver({
    onStart: async () => {
        if ("starting" !== transcriptionControlState)
        {
            throw new Error("Unexpected hardware audio stream");
        }
        clearTranscriptionStartTimer();
        transcriptionControlState = "active";
        hardwareClient.setAudioStreamActive(true);
        updateTranscriptionToggle();
        const result = await window.agentPet.startLocalTranscription({
            mimeType: "audio/ogg",
            source: "hardware"
        });
        if (transcriptionDismissAfterStop)
        {
            void requestTranscriptionStop(true);
        }

        return result;
    },
    onChunk: (chunk) => window.agentPet.appendLocalTranscriptionChunk(chunk),
    onFinish: async () => {
        try
        {
            return await window.agentPet.finishLocalTranscription();
        }
        finally
        {
            const dismissPanel = transcriptionDismissAfterStop;
            transcriptionDismissAfterStop = false;
            transcriptionControlState = "idle";
            hardwareClient.setAudioStreamActive(false);
            updateTranscriptionToggle();
            if (dismissPanel)
            {
                await window.agentPet.clearLocalTranscription();
            }
        }
    },
    onCancel: async () => {
        try
        {
            return await window.agentPet.cancelLocalTranscription();
        }
        finally
        {
            clearTranscriptionStartTimer();
            const dismissPanel = transcriptionDismissAfterStop;
            transcriptionDismissAfterStop = false;
            transcriptionControlState = "idle";
            hardwareClient.setAudioStreamActive(false);
            updateTranscriptionToggle();
            if (dismissPanel)
            {
                await window.agentPet.clearLocalTranscription();
            }
        }
    },
    onError: (error) => {
        failTranscriptionControl(error);
    }
});
const hardwareClient = new window.AgentPetBleClient({
    serviceUuid: hardwareProtocol.SERVICE_UUID,
    characteristicUuid: hardwareProtocol.STATUS_RX_UUID,
    imageCharacteristicUuid: hardwareProtocol.IMAGE_RX_UUID,
    imageDigestCharacteristicUuid: hardwareProtocol.IMAGE_DIGEST_UUID,
    meritCharacteristicUuid: hardwareProtocol.DAILY_MERIT_UUID,
    audioCharacteristicUuid: hardwareProtocol.AUDIO_STREAM_UUID,
    onAudioFrame: (frame) => hardwareAudioReceiver.push(frame),
    onAudioDisconnect: () => hardwareAudioReceiver.disconnect(),
    encodeImage: hardwareProtocol.encodeMascotImage,
    encodeAudioControl: hardwareProtocol.encodeAudioControl,
    imageDataSizes: hardwareProtocol.IMAGE_DATA_SIZES,
    enabled: false,
    encodeReset: hardwareProtocol.encodeMascotReset,
    encodeImageSelect: hardwareProtocol.encodeMascotSelect,
    parseImageDigest: hardwareProtocol.parseMascotDigest,
    encodeDailyMerit: hardwareProtocol.encodeDailyMerit,
    parseDailyMerit: hardwareProtocol.parseDailyMerit,
    getDailyMerit: () => {
        const dailyMerit = readDailyMerit();
        return { day: localDateNumber(), count: dailyMerit.count };
    },
    onDailyMerit: (syncedMerit) => applySyncedDailyMerit(syncedMerit),
    encodeTimeSync: () => hardwareProtocolEncoder.encodeTimeSync(),
    onStatus: (status, detail) => {
        const presentation = hardwareStatus.hardwareStatusPresentation(status, detail);
        hardwareButton.dataset.status = status;
        hardwareButton.textContent = presentation.text;
        hardwareButton.title = presentation.title;
        hardwareButton.style.setProperty(
            "--transfer-progress",
            `${null === presentation.percent ? 0 : presentation.percent}%`
        );
        if (null === presentation.percent)
        {
            hardwareButton.removeAttribute("aria-label");
        }
        else
        {
            hardwareButton.setAttribute("aria-label", `图片传输 ${presentation.percent}%`);
        }
        if ("error" === status)
        {
            hardwareButton.setAttribute("aria-label", `BLE 错误：${detail || "未知错误"}`);
        }
        updateTranscriptionToggle();
    }
});
const CLICK_SPEEDS = Object.freeze([
    { name: "turbo", maximumInterval: 180, label: "木鱼连击", sound: "咚咚咚！" },
    { name: "fast", maximumInterval: 360, label: "功德加速", sound: "咚咚！" },
    { name: "quick", maximumInterval: 700, label: "渐入佳境", sound: "咚！" },
    { name: "steady", maximumInterval: Number.POSITIVE_INFINITY, label: "静心一击", sound: "咚" }
]);

function applyState(snapshot)
{
    latestSnapshot = snapshot || latestSnapshot;
    if (hardwareEnabled)
    {
        hardwareClient.setSnapshot(hardwareProtocolEncoder.encode(latestSnapshot).map((frame) => Array.from(frame)));
    }
    const state = Object.hasOwn(STATE_PRESENTATION, latestSnapshot.state) ? latestSnapshot.state : "idle";
    const presentation = STATE_PRESENTATION[state];
    const active = latestSnapshot.active;
    const canAnimateTyping = typingActive && ("idle" === state || "running" === state);

    for (const stateName of Object.keys(STATE_PRESENTATION))
    {
        document.body.classList.remove(`state-${stateName}`);
    }
    document.body.classList.add(`state-${state}`);
    document.body.classList.toggle("is-typing", canAnimateTyping);
    syncHardwareTypingAnimation(canAnimateTyping);

    statusTitle.textContent = positionAdjusting
        ? "拖动到想要的位置"
        : (canAnimateTyping ? "一起敲代码" : presentation.title);
    statusMessage.textContent = positionAdjusting
        ? "20 秒后自动恢复鼠标穿透"
        : (active && active.message ? active.message : presentation.fallback);
    stateBadge.textContent = canAnimateTyping ? "⌨" : presentation.badge;
    trafficLabel.textContent = presentation.traffic;
    providerLabel.textContent = active
        ? `${active.provider || "Agent"} · ${active.source || "local"}`
        : "Agent Pet";
    sessionCount.textContent = `${Array.isArray(latestSnapshot.sessions) ? latestSnapshot.sessions.length : 0} 个会话 ›`;
    if (sessionDetailsOpen)
    {
        renderSessionDetails();
    }
}

function displayPath(cwd)
{
    const value = String(cwd || "未知目录");
    const parts = value.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : value;
}

function formatUpdatedAt(value)
{
    const date = new Date(value || 0);
    return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { hour12: false });
}

function renderSessionDetails()
{
    const sessions = Array.isArray(latestSnapshot.sessions) ? latestSnapshot.sessions : [];
    const dismissibleCount = sessions.filter((session) => ["idle", "completed", "error"].includes(session.state)).length;
    sessionDetailsSubtitle.textContent = `${sessions.length} 个会话 · 按状态优先排列`;
    clearFinishedButton.disabled = 0 === dismissibleCount;
    sessionDetailsList.replaceChildren();

    if (0 === sessions.length)
    {
        const empty = document.createElement("p");
        empty.className = "session-empty";
        empty.textContent = "当前还没有 Agent 会话。";
        sessionDetailsList.appendChild(empty);
        return;
    }

    for (const session of sessions)
    {
        const state = Object.hasOwn(STATE_PRESENTATION, session.state) ? session.state : "idle";
        const card = document.createElement("article");
        card.className = `session-card session-${state}`;

        const header = document.createElement("header");
        const identity = document.createElement("strong");
        identity.textContent = `${session.provider || "Agent"} · ${displayPath(session.cwd)}`;
        const stateLabel = document.createElement("span");
        stateLabel.className = "session-state";
        stateLabel.textContent = STATE_PRESENTATION[state].traffic;
        header.append(identity, stateLabel);

        const source = document.createElement("span");
        source.className = "session-source";
        source.textContent = `${session.source || "local"} · ${session.event || "状态更新"}`;

        const message = document.createElement("p");
        message.textContent = session.message || STATE_PRESENTATION[state].fallback;

        card.append(header, source, message);

        const request = approvalRequests.find((item) => item.sessionId === session.id);
        if (request)
        {
            const approval = document.createElement("section");
            approval.className = "session-inline-approval";
            const operation = document.createElement("code");
            operation.textContent = request.toolName || "待审批操作";
            const summary = document.createElement("p");
            summary.textContent = request.summary || "请核对操作内容后选择。";
            const actions = document.createElement("div");
            actions.className = "session-actions";
            const allow = document.createElement("button");
            allow.type = "button";
            allow.className = "session-allow";
            allow.textContent = "允许";
            allow.addEventListener("click", () => window.agentPet.decideApproval("allow", request.id));
            const deny = document.createElement("button");
            deny.type = "button";
            deny.className = "session-deny";
            deny.textContent = "拒绝";
            deny.addEventListener("click", () => window.agentPet.decideApproval("deny", request.id));
            actions.append(allow, deny);
            approval.append(operation, summary, actions);
            card.appendChild(approval);
        }
        else if ("needs_input" === state)
        {
            const notice = document.createElement("div");
            notice.className = "session-input-notice";
            notice.textContent = "此请求需要文本输入，请回到原 Codex / Claude Code 会话继续。当前 hooks 无法安全代发任意文本。";
            card.appendChild(notice);
        }

        const footer = document.createElement("footer");
        const cwd = document.createElement("code");
        cwd.textContent = session.cwd || "未知目录";
        cwd.title = session.cwd || "";
        const updated = document.createElement("time");
        updated.dateTime = session.updatedAt || "";
        updated.textContent = formatUpdatedAt(session.updatedAt);
        footer.append(cwd, updated);

        const dismissible = ["idle", "completed", "error"].includes(state);
        const dismiss = document.createElement("button");
        dismiss.type = "button";
        dismiss.className = dismissible ? "session-dismiss" : "session-dismiss session-force-dismiss";
        dismiss.textContent = dismissible ? "关闭" : "强制关闭";
        dismiss.title = dismissible
            ? "只移除桌宠中的会话记录，不会终止 Agent"
            : "强制移除状态和待审批提示，不会终止 Agent";
        dismiss.addEventListener("click", () => window.agentPet.dismissSession(session.id, !dismissible));
        footer.appendChild(dismiss);

        card.appendChild(footer);
        sessionDetailsList.appendChild(card);
    }
}

function setSessionDetails(open, notify = true)
{
    sessionDetailsOpen = true === open;
    sessionDetailsPanel.hidden = !sessionDetailsOpen;
    document.body.classList.toggle("has-session-details", sessionDetailsOpen);
    if (sessionDetailsOpen)
    {
        renderSessionDetails();
    }
    applyApproval(approvalRequest);
    if (notify)
    {
        window.agentPet.setSessionDetailsOpen(sessionDetailsOpen);
    }
}
function applyApproval(request)
{
    approvalRequest = request || null;
    const showStandalone = null !== approvalRequest && !sessionDetailsOpen;

    document.body.classList.toggle("has-approval", showStandalone);
    approvalPanel.hidden = !showStandalone;
    if (!approvalRequest)
    {
        return;
    }

    approvalProvider.textContent = `${String(approvalRequest.provider || "Agent").toUpperCase()} · 需要授权`;
    approvalTool.textContent = approvalRequest.toolName || "未知操作";
    approvalSummary.textContent = approvalRequest.summary || "请核对操作内容后选择。";
}

function applyApprovalRequests(requests)
{
    approvalRequests = Array.isArray(requests) ? requests : [];
    if (sessionDetailsOpen)
    {
        renderSessionDetails();
    }
}

function cancelHoverAnimation()
{
    if (hoverTimer)
    {
        clearTimeout(hoverTimer);
        clearInterval(hoverTimer);
        hoverTimer = null;
    }
    for (const action of HOVER_ACTIONS)
    {
        document.body.classList.remove(`hover-action-${action}`);
    }
    mascot.src = animationSettings.mascotUrl || defaultMascotUrl;
    if (hardwareHoverActive)
    {
        hardwareHoverActive = false;
        void hardwareClient.sendEvent(hardwareProtocolEncoder.encodeAnimationRestore());
    }
}

function playBuiltInHoverAnimation()
{
    const action = HOVER_ACTIONS[Math.floor(Math.random() * HOVER_ACTIONS.length)];
    document.body.classList.add(`hover-action-${action}`);
    hoverTimer = setTimeout(() => {
        document.body.classList.remove(`hover-action-${action}`);
        hoverTimer = null;
    }, 900);
}

function playCustomHoverFrames(animation = null)
{
    const frames = animation && Array.isArray(animation.frameUrls)
        ? animation.frameUrls
        : animationSettings.hoverFrameUrls;
    const durations = animation && Array.isArray(animation.frameDurations)
        ? animation.frameDurations
        : animationSettings.hoverFrameDurations;
    let index = 0;
    if (animation && Number.isInteger(animation.slot) && hardwareEnabled)
    {
        hardwareHoverActive = true;
        void hardwareClient.sendEvent(
            hardwareProtocolEncoder.encodeAnimationPlay(animation.slot));
    }
    if (1 === frames.length)
    {
        mascot.src = frames[0];
        hoverTimer = setTimeout(cancelHoverAnimation, 650);
        return;
    }

    const hasSourceTiming = Array.isArray(durations) && durations.length === frames.length;
    const averageDuration = hasSourceTiming
        ? durations.reduce((total, duration) => total + duration, 0) / durations.length
        : animationSettings.hoverFrameMs;
    const speedRatio = animationSettings.hoverFrameMs / Math.max(1, averageDuration);

    function showNextFrame()
    {
        mascot.src = frames[index];
        const sourceDuration = hasSourceTiming ? durations[index] : animationSettings.hoverFrameMs;
        const frameDuration = Math.max(20, Math.min(1000, Math.round(sourceDuration * speedRatio)));
        index++;
        hoverTimer = setTimeout(() => {
            if (frames.length <= index)
            {
                cancelHoverAnimation();
                return;
            }
            showNextFrame();
        }, frameDuration);
    }

    if (0 < frames.length)
    {
        showNextFrame();
    }
}

function playRandomHoverAnimation()
{
    if (
        !animationSettings.hoverEnabled ||
        hoverTimer ||
        document.body.classList.contains("has-approval") ||
        document.body.classList.contains("has-session-details")
    )
    {
        return;
    }

    const animations = Array.isArray(animationSettings.hoverAnimations)
        ? animationSettings.hoverAnimations.filter((animation) =>
            Array.isArray(animation.frameUrls) && 0 < animation.frameUrls.length)
        : [];
    if (0 < animations.length)
    {
        playCustomHoverFrames(animations[Math.floor(Math.random() * animations.length)]);
    }
    else if (0 < animationSettings.hoverFrameUrls.length && 0.65 > Math.random())
    {
        playCustomHoverFrames();
    }
    else
    {
        playBuiltInHoverAnimation();
    }
}

async function syncHardwareMascot()
{
    if (!hardwareEnabled)
    {
        return;
    }
    const request = ++hardwareImageRequest;

    try
    {
        const images = "function" === typeof window.agentPet.getHardwareMascotImages
            ? await window.agentPet.getHardwareMascotImages()
            : [await window.agentPet.getHardwareMascotImage()];
        if (hardwareEnabled && request === hardwareImageRequest)
        {
            hardwareClient.setImages(images);
        }
    }
    catch (error)
    {
        hardwareButton.dataset.status = "error";
        hardwareButton.textContent = "BLE !";
        hardwareButton.title = error.message;
    }
}

function applyHardwareSettings(settings)
{
    const enabled = true === settings.hardware?.enabled;
    const changed = enabled !== hardwareEnabled;
    hardwareEnabled = enabled;
    hardwareButton.hidden = !hardwareEnabled;
    hardwareClient.setEnabled(hardwareEnabled);
    updateTranscriptionToggle();
    if (hardwareEnabled)
    {
        void hardwareClient.restoreAuthorizedDevice();
    }

    if (!hardwareEnabled)
    {
        hardwareImageRequest++;
        hardwareTypingActive = null;
        return;
    }
    if (changed)
    {
        hardwareClient.setSnapshot(
            hardwareProtocolEncoder.encode(latestSnapshot).map((frame) => Array.from(frame))
        );
    }
    syncHardwareTypingAnimation();
    void syncHardwareMascot();
}

function syncHardwareTypingAnimation(active = null)
{
    const state = Object.hasOwn(STATE_PRESENTATION, latestSnapshot.state)
        ? latestSnapshot.state
        : "idle";
    const shouldAnimate = "boolean" === typeof active
        ? active
        : typingActive && ("idle" === state || "running" === state);

    if (!hardwareEnabled)
    {
        hardwareTypingActive = null;
        return;
    }
    if (hardwareTypingActive === shouldAnimate)
    {
        return;
    }

    hardwareTypingActive = shouldAnimate;
    void hardwareClient.setTypingAnimation(
        shouldAnimate
            ? hardwareProtocolEncoder.encodeTypingStart()
            : hardwareProtocolEncoder.encodeTypingStop()
    );
}
function applyAnimationSettings(settings)
{
    cancelHoverAnimation();
    animationSettings = {
        ...animationSettings,
        ...(settings.animation || {})
    };
    for (const style of ["classic", "playful", "gentle", "still"])
    {
        document.body.classList.toggle(`animation-style-${style}`, style === animationSettings.style);
    }
    mascot.src = animationSettings.mascotUrl || defaultMascotUrl;
}
function formatRate(bytesPerSecond)
{
    const value = Math.max(0, Number(bytesPerSecond) || 0);
    if (1048576 <= value)
    {
        return `${(value / 1048576).toFixed(1)}M`;
    }
    if (1024 <= value)
    {
        return `${Math.round(value / 1024)}K`;
    }
    return `${Math.round(value)}B`;
}

function applyResourceSettings(settings)
{
    windowSettings = settings || windowSettings;
    const resources = windowSettings.resources || {};
    const enabledKeys = ["cpu", "gpu", "memory", "network"].filter((key) => false !== resources[key]);
    resourcePanel.hidden = false === resources.enabled || 0 === enabledKeys.length;
    for (const chip of resourcePanel.querySelectorAll("[data-resource]"))
    {
        chip.hidden = !enabledKeys.includes(chip.dataset.resource);
    }
    document.body.classList.toggle("has-resources", !resourcePanel.hidden);
}

function applyResourceUsage(snapshot)
{
    latestResources = snapshot || null;
    if (!latestResources)
    {
        resourceCpu.textContent = "--%";
        resourceGpu.textContent = "--%";
        resourceMemory.textContent = "--%";
        resourceNetwork.textContent = "↓ -- ↑ --";
        return;
    }

    resourceCpu.textContent = `${latestResources.cpu ?? 0}%`;
    resourceGpu.textContent = null === latestResources.gpu ? "N/A" : `${latestResources.gpu}%`;
    resourceMemory.textContent = `${latestResources.memoryPercent ?? 0}%`;
    resourceNetwork.textContent = `↓ ${formatRate(latestResources.download)} ↑ ${formatRate(latestResources.upload)}`;
}
function localDateKey(date = new Date())
{
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function localDateNumber(date = new Date())
{
    return Number(localDateKey(date).replaceAll("-", ""));
}

function readDailyMerit()
{
    const today = localDateKey();
    try
    {
        const stored = JSON.parse(localStorage.getItem(DAILY_MERIT_STORAGE_KEY) || "null");
        if (stored && today === stored.date && Number.isSafeInteger(stored.count) && 0 <= stored.count)
        {
            return stored;
        }
    }
    catch (_error)
    {
        // Ignore malformed local-only data and start a fresh day.
    }
    return { date: today, count: 0 };
}

function writeDailyMerit(dailyMerit)
{
    try
    {
        localStorage.setItem(DAILY_MERIT_STORAGE_KEY, JSON.stringify(dailyMerit));
    }
    catch (_error)
    {
        // The click animation still works if local storage is unavailable.
    }
}

function applySyncedDailyMerit(syncedMerit)
{
    if (!syncedMerit || localDateNumber() !== syncedMerit.day ||
        !Number.isSafeInteger(syncedMerit.count) || 0 > syncedMerit.count)
    {
        return;
    }
    const previousMerit = readDailyMerit();
    const dailyMerit = { date: localDateKey(), count: syncedMerit.count };

    writeDailyMerit(dailyMerit);
    woodenFishScene.dataset.dailyMerit = String(dailyMerit.count);
    dailyMeritSummary.textContent = `今日功德 ${dailyMerit.count}`;
    if (dailyMerit.count > previousMerit.count)
    {
        showDailyMerit(dailyMerit);
    }
}

function showDailyMerit(dailyMerit)
{
    dailyMeritSummary.textContent = `今日功德 ${dailyMerit.count}`;
    dailyMeritSummary.classList.remove("is-visible");
    void dailyMeritSummary.offsetWidth;
    dailyMeritSummary.classList.add("is-visible");
    if (dailyMeritSummaryTimer)
    {
        clearTimeout(dailyMeritSummaryTimer);
    }
    dailyMeritSummaryTimer = setTimeout(() => {
        dailyMeritSummary.classList.remove("is-visible");
        dailyMeritSummaryTimer = null;
    }, 1900);
}

function clickSpeedFor(interval)
{
    return CLICK_SPEEDS.find((speed) => interval <= speed.maximumInterval);
}

function playWoodenFishHit(clientX, clientY)
{
    const now = Date.now();
    const interval = 0 === lastWoodenFishHitAt ? Number.POSITIVE_INFINITY : now - lastWoodenFishHitAt;
    const speed = clickSpeedFor(interval);
    const stageBounds = document.getElementById("pet-stage").getBoundingClientRect();
    const computedScale = Number(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale"));
    const uiScale = 0 < computedScale ? computedScale : 1;
    const stageWidth = stageBounds.width / uiScale;
    const stageHeight = stageBounds.height / uiScale;
    const pointerX = (clientX - stageBounds.left) / uiScale;
    const pointerY = (clientY - stageBounds.top) / uiScale;
    const localX = Math.max(54, Math.min(pointerX, stageWidth - 54));
    const localY = Math.max(48, Math.min(pointerY, stageHeight - 48));
    const dailyMerit = readDailyMerit();

    lastWoodenFishHitAt = now;
    dailyMerit.count++;
    writeDailyMerit(dailyMerit);
    meritCount++;
    if (hardwareEnabled)
    {
        void hardwareClient.sendEvent(
            hardwareProtocolEncoder.encodeWoodenFishHit().map((frame) => Array.from(frame)));
    }
    meritToast.textContent = "功德 +1";
    meritToast.title = `本轮功德 ${meritCount}`;
    woodenFishSound.textContent = speed.sound;
    clickSpeedLabel.textContent = speed.label;
    woodenFishScene.dataset.meritCount = String(meritCount);
    woodenFishScene.dataset.speed = speed.name;
    woodenFishScene.dataset.dailyMerit = String(dailyMerit.count);
    woodenFishScene.style.left = `${localX}px`;
    woodenFishScene.style.top = `${localY}px`;
    dailyMeritSummary.classList.remove("is-visible");

    if (woodenFishTimer)
    {
        clearTimeout(woodenFishTimer);
    }
    if (dailyMeritSummaryTimer)
    {
        clearTimeout(dailyMeritSummaryTimer);
        dailyMeritSummaryTimer = null;
    }
    woodenFishScene.classList.remove("is-hitting");
    void woodenFishScene.offsetWidth;
    woodenFishScene.classList.add("is-hitting");
    document.body.classList.add("is-wooden-fish-hit");
    woodenFishTimer = setTimeout(() => {
        woodenFishScene.classList.remove("is-hitting");
        document.body.classList.remove("is-wooden-fish-hit");
        woodenFishTimer = null;
        lastWoodenFishHitAt = 0;
        showDailyMerit(readDailyMerit());
    }, WOODEN_FISH_IDLE_MS);
}

function submitApproval(decision)
{
    if (approvalRequest)
    {
        window.agentPet.decideApproval(decision, approvalRequest.id);
    }
}

function applyLocalSttUpdate(update)
{
    const next = update || { status: "idle", text: "", isFinal: false };
    const status = Object.hasOwn(TRANSCRIPTION_STATUS, next.status) ? next.status : "error";
    const text = "string" === typeof next.text ? next.text : "";
    const visible = "idle" !== status || 0 < text.length;
    const active = ["listening", "transcribing"].includes(status);

    if (null !== next.sessionId && undefined !== next.sessionId &&
        next.sessionId !== transcriptionSessionId)
    {
        transcriptionSessionId = next.sessionId;
        transcriptionUserEdited = false;
        conversationInput.value = "";
    }
    if (active || !transcriptionUserEdited)
    {
        conversationInput.value = text;
    }

    window.agentPet.setTranscriptionPanelOpen(visible);
    transcriptionPanel.hidden = !visible;
    document.body.classList.toggle("has-transcription", visible);
    transcriptionStatus.textContent = TRANSCRIPTION_STATUS[status];
    transcriptionStatus.dataset.status = status;
    conversationInput.readOnly = active;
    transcriptionCopy.disabled = 0 === conversationInput.value.trim().length;

    if ("error" === status)
    {
        transcriptionDetail.textContent = next.error || "请检查本地 STT 服务";
    }
    else if ("complete" === status)
    {
        transcriptionDetail.textContent = "可编辑或复制到目标对话";
    }
    else
    {
        transcriptionDetail.textContent = "音频仅发送到本机 STT 服务";
    }
}

window.agentPet.onState(applyState);
function applyLocalSttRuntime(update)
{
    localSttRuntimeReady = true === update?.ready;
    updateTranscriptionToggle();
}

window.agentPet.onTypingActivity((active) => {
    typingActive = true === active;
    applyState(latestSnapshot);
});
window.agentPet.onApprovalRequest(applyApproval);
window.agentPet.onApprovalRequests(applyApprovalRequests);
window.agentPet.onDisplayMode((mode) => {
    document.body.classList.toggle("mode-pet", "pet" === mode);
    document.body.classList.toggle("mode-traffic", "traffic" === mode);
});
window.agentPet.onWindowSettings((settings) => {
    const requestedScale = Number(settings.scale);
    const uiScale = [0.75, 1, 1.25, 1.5].includes(requestedScale) ? requestedScale : 1;
    document.documentElement.style.setProperty("--ui-scale", String(uiScale));
    document.body.classList.toggle("is-click-through", true === settings.clickThrough);
    applyResourceSettings(settings);
    applyAnimationSettings(settings);
    applyHardwareSettings(settings);
});
window.agentPet.onResourceUsage(applyResourceUsage);
window.agentPet.onShowSessionDetails((open) => setSessionDetails(open, false));
window.agentPet.onPositionAdjustMode((active) => {
    positionAdjusting = true === active;
    document.body.classList.toggle("is-position-adjusting", positionAdjusting);
    applyState(latestSnapshot);
});
window.agentPet.onLocalSttUpdate(applyLocalSttUpdate);

window.agentPet.onLocalSttRuntimeUpdate(applyLocalSttRuntime);
void window.agentPet.getLocalSttRuntimeStatus()
    .then(applyLocalSttRuntime)
    .catch(() => applyLocalSttRuntime({ ready: false }));
mascot.addEventListener("mouseenter", playRandomHoverAnimation);

// 手动窗口拖动：mascot 因 -webkit-app-region: no-drag 不参与原生拖动，
// 通过 IPC 手动移动窗口，同时保留 mouseenter 悬停动画。
(function initManualDrag()
{
    const dragThreshold = 6;
    let isDragging = false;
    let hasMoved = false;
    let pointerStartX = 0;
    let pointerStartY = 0;
    let dragStartX = 0;
    let dragStartY = 0;

    mascot.addEventListener("mousedown", (event) =>
    {
        if (0 !== event.button)
        {
            return;
        }
        isDragging = true;
        hasMoved = false;
        pointerStartX = event.screenX;
        pointerStartY = event.screenY;
        dragStartX = event.screenX;
        dragStartY = event.screenY;
        event.preventDefault();
    });

    document.addEventListener("mousemove", (event) =>
    {
        if (!isDragging)
        {
            return;
        }

        if (!hasMoved && dragThreshold <= Math.hypot(event.screenX - pointerStartX, event.screenY - pointerStartY))
        {
            hasMoved = true;
        }
        if (!hasMoved)
        {
            return;
        }

        const dx = event.screenX - dragStartX;
        const dy = event.screenY - dragStartY;
        if (dx || dy)
        {
            window.agentPet.dragWindow(dx, dy);
            dragStartX = event.screenX;
            dragStartY = event.screenY;
        }
    });

    document.addEventListener("mouseup", (event) =>
    {
        if (!isDragging || 0 !== event.button)
        {
            return;
        }
        isDragging = false;
        if (!hasMoved)
        {
            playWoodenFishHit(event.clientX, event.clientY);
        }
    });
})();
sessionSummary.addEventListener("click", () => setSessionDetails(!sessionDetailsOpen));
sessionSummary.addEventListener("keydown", (event) => {
    if (["Enter", " "].includes(event.key))
    {
        event.preventDefault();
        setSessionDetails(!sessionDetailsOpen);
    }
});
document.getElementById("session-details-close").addEventListener("click", () => setSessionDetails(false));
clearFinishedButton.addEventListener("click", () => window.agentPet.clearFinishedSessions());
document.getElementById("approval-allow").addEventListener("click", () => submitApproval("allow"));
document.getElementById("approval-deny").addEventListener("click", () => submitApproval("deny"));
conversationInput.addEventListener("input", () => {
    transcriptionUserEdited = true;
    transcriptionCopy.disabled = 0 === conversationInput.value.trim().length;
});
transcriptionCopy.addEventListener("click", async () => {
    if (!conversationInput.value.trim())
    {
        return;
    }
    await window.agentPet.copyText(conversationInput.value);
    transcriptionCopy.textContent = "已复制";
    setTimeout(() => {
        transcriptionCopy.textContent = "复制";
    }, 1200);
});
transcriptionClear.addEventListener("click", () => {
    transcriptionUserEdited = false;
    void window.agentPet.clearLocalTranscription();
});
transcriptionClose.addEventListener("click", async (event) => {
    event.stopPropagation();
    if ("starting" === transcriptionControlState)
    {
        transcriptionDismissAfterStop = true;
        return;
    }
    if ("active" === transcriptionControlState)
    {
        await requestTranscriptionStop(true);
        return;
    }
    if ("stopping" === transcriptionControlState)
    {
        transcriptionDismissAfterStop = true;
        return;
    }

    transcriptionDismissAfterStop = false;
    transcriptionUserEdited = false;
    await window.agentPet.clearLocalTranscription();
});
transcriptionToggle.addEventListener("click", async (event) => {
    event.stopPropagation();
    if ("idle" === transcriptionControlState)
    {
        if (!hardwareClient.isConnected() || !localSttRuntimeReady)
        {
            return;
        }
        transcriptionControlState = "starting";
        updateTranscriptionToggle();
        transcriptionStartTimer = setTimeout(() => {
            void hardwareClient.requestAudioStream(false).catch(() => {});
            failTranscriptionControl(new Error("\u8BBE\u5907\u672A\u5728\u9650\u65F6\u5185\u5F00\u59CB\u91C7\u96C6\uFF0C\u8BF7\u68C0\u67E5\u8BBE\u5907\u5F55\u97F3\u529F\u80FD\u662F\u5426\u6B63\u5728\u4F7F\u7528\u9EA6\u514B\u98CE"));
        }, TRANSCRIPTION_START_TIMEOUT_MS);
        try
        {
            await hardwareClient.requestAudioStream(true);
        }
        catch (error)
        {
            failTranscriptionControl(error);
        }
        return;
    }
    await requestTranscriptionStop();
});
hardwareButton.addEventListener("keydown", (event) => event.stopPropagation());
hardwareButton.addEventListener("click", async (event) => {
    event.stopPropagation();

    if (!hardwareEnabled)
    {
        return;
    }
    if (hardwareClient.isConnected())
    {
        hardwareClient.disconnect();
        return;
    }
    hardwareButton.disabled = true;
    try
    {
        await hardwareClient.connect();
    }
    catch (error)
    {
        console.error("[Agent Pet BLE]", error);
        hardwareButton.dataset.status = "error";
        hardwareButton.textContent = "BLE !";
        hardwareButton.title = error.message;
    }
    finally
    {
        hardwareButton.disabled = false;
    }
});
document.getElementById("hide-button").addEventListener("click", () => window.agentPet.hide());
