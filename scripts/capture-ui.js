"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const state = process.argv[2] || "running";
const mode = process.argv[3] || "pet";
const scenario = process.argv[4] || "state";
const requestedScale = Number(process.env.AGENT_PET_CAPTURE_SCALE || 1);
const uiScale = [0.75, 1, 1.25, 1.5].includes(requestedScale) ? requestedScale : 1;
const baseSize = "transcription" === scenario || "traffic" !== mode
    ? { width: 300, height: 350 }
    : { width: 104, height: 236 };

app.whenReady().then(async () => {
    const window = new BrowserWindow({
        width: Math.round(baseSize.width * uiScale),
        height: Math.round(baseSize.height * uiScale),
        show: false,
        transparent: true,
        frame: false,
        webPreferences: {
            preload: path.join(__dirname, "..", "src", "preload.js"),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    await window.loadFile(path.join(__dirname, "..", "src", "renderer", "index.html"));
    window.webContents.send("display-mode", mode);
    window.webContents.send("agent-state", {
        state,
        active: {
            provider: "Codex",
            source: "WSL ? Ubuntu",
            state,
            message: `Visual smoke test: ${state}`,
            updatedAt: new Date().toISOString()
        },
        sessions: [{ state }],
        counts: { [state]: 1 }
    });
    window.webContents.send("window-settings", {
        clickThrough: false,
        scale: uiScale,
        resources: { enabled: true, cpu: true, gpu: true, memory: true, network: true },
        animation: { style: "scale" === scenario ? "still" : "playful", hoverEnabled: true, mascotUrl: null, hoverFrameUrls: [], hoverFrameMs: 110 }
    });
    window.webContents.send("resource-usage", {
        cpu: 28,
        gpu: 16,
        memoryPercent: 63,
        download: 1240000,
        upload: 86000
    });
    if ("hover" === scenario)
    {
        await window.webContents.executeJavaScript("document.getElementById('mascot').dispatchEvent(new MouseEvent('mouseenter'))");
    }
    else    if ("typing" === scenario)
    {
        window.webContents.send("typing-activity", true);
    }
    else if ("sessions" === scenario)
    {
        const now = new Date().toISOString();
        const sessions = [
            { id: "codex-1", provider: "Codex", source: "Windows", state: "running", event: "UserPromptSubmit", message: "任务：为桌宠增加会话详情列表", cwd: "C:\\Users\\tester\\AgentPet", updatedAt: now },
            { id: "claude-1", provider: "Claude Code", source: "WSL · Ubuntu", state: "completed", event: "Stop", message: "已完成固件日志分析并整理出三条修复建议。", cwd: "/home/tester/firmware", updatedAt: now },
            { id: "codex-2", provider: "Codex", source: "WSL · Ubuntu", state: "needs_input", event: "PermissionRequest", message: "等待授权：shell_command", cwd: "/home/tester/web", updatedAt: now }
        ];
        window.webContents.send("agent-state", { state: "needs_input", active: sessions[2], sessions, counts: { running: 1, completed: 1, needs_input: 1 } });
        window.webContents.send("approval-requests", [{
            id: "visual-session-approval",
            provider: "codex",
            sessionId: "codex-2",
            toolName: "shell_command",
            summary: "npm run build -- --safe-mode",
            createdAt: now,
            expiresAt: new Date(Date.now() + 60000).toISOString()
        }]);
        window.webContents.send("show-session-details", true);
    }
    else if ("wooden-fish" === scenario)
    {
        const result = await window.webContents.executeJavaScript(`(() => {
            try {
                localStorage.removeItem("agent-pet.daily-merit.v1");
                document.getElementById("mascot").dispatchEvent(new MouseEvent("mousedown", { button: 0, screenX: 120, screenY: 150, clientX: 120, clientY: 150, bubbles: true }));
                document.dispatchEvent(new MouseEvent("mouseup", { button: 0, screenX: 120, screenY: 150, clientX: 120, clientY: 150, bubbles: true }));
                return "ok";
            } catch (error) {
                return "error: " + (error.stack || error.message);
            }
        })()`);
        process.stdout.write(`Wooden fish action ${result}\n`);
    }
    else if ("approval" === scenario)
    {
        window.webContents.send("approval-request", {
            id: "visual-smoke-test",
            provider: "codex",
            toolName: "shell_command",
            summary: "npm run build -- --safe-mode"
        });
    }
    else if ("transcription" === scenario)
    {
        window.webContents.send("local-stt-update", {
            sessionId: 1,
            status: "complete",
            text: "帮我整理今天的项目进展，并列出明天最重要的三个任务。",
            isFinal: true,
            receivedBytes: 48120
        });
    }

    const captureDelay = "hover" === scenario ? 380 : ("wooden-fish" === scenario ? 280 : 900);
    await new Promise((resolve) => setTimeout(resolve, captureDelay));
    if ("transcription" === scenario)
    {
        const ui = await window.webContents.executeJavaScript(`JSON.stringify({
            panelHidden: document.getElementById("transcription-panel").hidden,
            bodyClass: document.body.className,
            text: document.getElementById("conversation-input").value,
            listenerAvailable: "function" === typeof window.agentPet.onLocalSttUpdate
        })`);
        process.stdout.write(`Transcription UI check ${ui}\n`);
    }
    if ("wooden-fish" === scenario)
    {
        const ui = await window.webContents.executeJavaScript(`(() => {
            document.getElementById("mascot").dispatchEvent(new MouseEvent("mousedown", { button: 0, screenX: 120, screenY: 150, clientX: 120, clientY: 150, bubbles: true }));
            document.dispatchEvent(new MouseEvent("mouseup", { button: 0, screenX: 120, screenY: 150, clientX: 120, clientY: 150, bubbles: true }));
            document.getElementById("mascot").dispatchEvent(new MouseEvent("mousedown", { button: 0, screenX: 120, screenY: 150, clientX: 120, clientY: 150, bubbles: true }));
            document.dispatchEvent(new MouseEvent("mousemove", { button: 0, screenX: 132, screenY: 150, clientX: 132, clientY: 150, bubbles: true }));
            document.dispatchEvent(new MouseEvent("mouseup", { button: 0, screenX: 132, screenY: 150, clientX: 132, clientY: 150, bubbles: true }));
            return JSON.stringify({
                hitting: document.getElementById("wooden-fish-scene").classList.contains("is-hitting"),
                meritCountAfterClicksAndDrag: document.getElementById("wooden-fish-scene").dataset.meritCount,
                speed: document.getElementById("wooden-fish-scene").dataset.speed,
                speedLabel: document.getElementById("click-speed-label").textContent,
                dailyMerit: document.getElementById("wooden-fish-scene").dataset.dailyMerit,
                hasMallet: null !== document.getElementById("wooden-fish-mallet"),
                hasFish: null !== document.getElementById("wooden-fish"),
                mascotHidden: document.body.classList.contains("is-wooden-fish-hit")
            });
        })()`);
        process.stdout.write(`Wooden fish UI check ${ui}\n`);
        await new Promise((resolve) => setTimeout(resolve, 1050));
        const summary = await window.webContents.executeJavaScript(`JSON.stringify({
            mascotRestored: !document.body.classList.contains("is-wooden-fish-hit"),
            summaryVisible: document.getElementById("daily-merit-summary").classList.contains("is-visible"),
            summaryText: document.getElementById("daily-merit-summary").textContent
        })`);
        process.stdout.write(`Daily merit UI check ${summary}\n`);
    }
    if ("sessions" === scenario)
    {
        const ui = await window.webContents.executeJavaScript(`JSON.stringify({
            cards: document.querySelectorAll(".session-card").length,
            inlineApprovals: document.querySelectorAll(".session-inline-approval").length,
            allowButtons: document.querySelectorAll(".session-allow").length,
            dismissButtons: document.querySelectorAll(".session-dismiss").length,
            clearButtonVisible: !document.getElementById("clear-finished-sessions").disabled
        })`);
        process.stdout.write(`UI check ${ui}\n`);
    }
    if ("scale" === scenario)
    {
        const layout = await window.webContents.executeJavaScript(`(() => {
            const bubble = document.getElementById("speech-bubble").getBoundingClientRect();
            const mascot = document.getElementById("mascot").getBoundingClientRect();
            const scale = Number(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale"));
            const gap = mascot.top - bubble.bottom;
            return JSON.stringify({
                viewport: { width: innerWidth, height: innerHeight },
                scale,
                bubbleBottom: bubble.bottom,
                mascotTop: mascot.top,
                gap,
                normalizedGap: gap / scale
            });
        })()`);
        process.stdout.write(`Scale layout ${layout}\n`);
    }
    const image = await window.webContents.capturePage();
    const outputDirectory = path.join(__dirname, "..", "artifacts");
    fs.mkdirSync(outputDirectory, { recursive: true });
    const scaleSuffix = "scale" === scenario ? `-${uiScale}` : "";
    const outputPath = path.join(outputDirectory, `ui-${mode}-${state}-${scenario}${scaleSuffix}.png`);
    fs.writeFileSync(outputPath, image.toPNG());
    process.stdout.write(`Captured ${outputPath}\n`);
    app.quit();
}).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    app.exit(1);
});
