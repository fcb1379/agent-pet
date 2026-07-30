#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { platformLabel, stateDirectory: defaultStateDirectory } = require("./platform-paths");

function readStdin()
{
    return new Promise((resolve) => {
        if (process.stdin.isTTY)
        {
            resolve("");
            return;
        }

        let input = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
            input += chunk;
        });
        process.stdin.on("end", () => resolve(input));
        process.stdin.resume();
    });
}

function windowsPathToWsl(windowsPath)
{
    const match = /^([A-Za-z]):\\(.*)$/.exec(windowsPath.trim());
    if (!match)
    {
        return windowsPath.trim();
    }

    return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

function resolveStateDirectory()
{
    if (process.env.AGENT_PET_STATE_DIR)
    {
        return process.env.AGENT_PET_STATE_DIR;
    }

    if ("win32" === process.platform)
    {
        return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "AgentPet", "states");
    }

    if (process.env.WSL_DISTRO_NAME || fs.existsSync("/proc/sys/fs/binfmt_misc/WSLInterop"))
    {
        try
        {
            const localAppData = childProcess.execFileSync(
                "cmd.exe",
                ["/d", "/c", "echo", "%LOCALAPPDATA%"],
                { encoding: "utf8", windowsHide: true }
            ).trim();
            return path.join(windowsPathToWsl(localAppData), "AgentPet", "states");
        }
        catch (_error)
        {
            const windowsUser = process.env.WINUSER || process.env.USER || "Public";
            return `/mnt/c/Users/${windowsUser}/AppData/Local/AgentPet/states`;
        }
    }

    return defaultStateDirectory();
}

function approvalDirectoryForStateDirectory(stateDirectory)
{
    return path.join(path.dirname(stateDirectory), "approvals");
}

function normalizedEventName(eventName)
{
    return String(eventName || "").toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function permissionSummary(payload)
{
    const toolInput = payload.tool_input && "object" === typeof payload.tool_input ? payload.tool_input : {};
    const description = toolInput.description || payload.message || "";
    const command = toolInput.command || "";
    const value = description && command && description !== command
        ? `${description} · ${command}`
        : (description || command || JSON.stringify(toolInput));

    return String(value || "需要授权的操作").replaceAll(/\s+/g, " ").slice(0, 400);
}

function writeJsonAtomic(filePath, value)
{
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, filePath);
}

function permissionDecisionOutput(decision)
{
    return {
        hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: "allow" === decision
                ? { behavior: "allow" }
                : { behavior: "deny", message: "Denied from Agent Pet." }
        }
    };
}

function createApprovalRequest(provider, payload, session, stateDirectory, now = Date.now())
{
    const timeout = Math.max(5000, Math.min(170000, Number(process.env.AGENT_PET_APPROVAL_TIMEOUT_MS) || 150000));
    const seed = `${provider}|${session.id}|${payload.tool_name || "tool"}|${JSON.stringify(payload.tool_input || {})}|${now}|${process.pid}`;
    const id = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32);
    const request = {
        protocolVersion: 1,
        id,
        provider: session.provider,
        source: session.source,
        sessionId: session.id,
        toolName: String(payload.tool_name || "Tool").slice(0, 100),
        summary: permissionSummary(payload),
        cwd: session.cwd,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + timeout).toISOString()
    };
    const directory = approvalDirectoryForStateDirectory(stateDirectory);
    writeJsonAtomic(path.join(directory, `${id}.request.json`), request);
    return request;
}

function waitForApprovalDecision(request, stateDirectory)
{
    const directory = approvalDirectoryForStateDirectory(stateDirectory);
    const requestPath = path.join(directory, `${request.id}.request.json`);
    const decisionPath = path.join(directory, `${request.id}.decision.json`);
    const deadline = Date.parse(request.expiresAt);

    return new Promise((resolve) => {
        const check = () => {
            if (fs.existsSync(decisionPath))
            {
                try
                {
                    const value = JSON.parse(fs.readFileSync(decisionPath, "utf8"));
                    if (["allow", "deny"].includes(value.decision))
                    {
                        fs.rmSync(decisionPath, { force: true });
                        fs.rmSync(requestPath, { force: true });
                        resolve(value.decision);
                        return;
                    }
                }
                catch (_error)
                {
                    // Ignore a partial or invalid decision and continue waiting.
                }
            }

            if (!fs.existsSync(requestPath))
            {
                fs.rmSync(decisionPath, { force: true });
                resolve(null);
                return;
            }

            if (Date.now() >= deadline)
            {
                fs.rmSync(requestPath, { force: true });
                fs.rmSync(decisionPath, { force: true });
                resolve(null);
                return;
            }

            setTimeout(check, 100);
        };

        check();
    });
}
function normalizeEvent(eventName, payload)
{
    const event = String(eventName || payload.hook_event_name || payload.type || "")
        .toLowerCase()
        .replaceAll(/[^a-z0-9]/g, "");
    const notificationType = String(payload.notification_type || "").toLowerCase();

    if (["userpromptsubmit", "sessionstart", "start", "running"].includes(event))
    {
        return "running";
    }

    if (
        ["permissionrequest", "approvalrequested", "needsinput", "agentneedsinput"].includes(event) ||
        ("notification" === event && ["permission_prompt", "idle_prompt", "agent_needs_input"].includes(notificationType))
    )
    {
        return "needs_input";
    }

    if (["stop", "agentturncomplete", "taskcompleted", "completed", "agentcompleted"].includes(event))
    {
        return "completed";
    }

    if (["stopfailure", "error", "failed", "blocked"].includes(event))
    {
        return "error";
    }

    if (["sessionend", "idle"].includes(event))
    {
        return "idle";
    }

    return "running";
}

function safeIdentifier(value)
{
    return String(value).replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
}

function sessionIdentifier(provider, payload)
{
    const explicit = payload.session_id ||
        payload.thread_id ||
        payload["thread-id"] ||
        payload.conversation_id ||
        ("codex" === provider ? process.env.CODEX_THREAD_ID : undefined);

    if (explicit)
    {
        return safeIdentifier(`${provider}-${explicit}`);
    }

    const identity = `${provider}|${payload.cwd || process.cwd()}|${process.ppid}`;
    const digest = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 16);
    return `${safeIdentifier(provider)}-${digest}`;
}

function messageFor(state, payload)
{
    const submittedPrompt = payload.prompt || payload.user_prompt || payload.userPrompt;
    if (submittedPrompt)
    {
        return `任务：${String(submittedPrompt).replaceAll(/\s+/g, " ").slice(0, 400)}`;
    }
    if (payload.message)
    {
        return String(payload.message).slice(0, 500);
    }
    if (payload.last_assistant_message && "completed" === state)
    {
        return String(payload.last_assistant_message).replaceAll(/\s+/g, " ").slice(0, 600);
    }

    return {
        idle: "会话已空闲",
        running: "正在处理任务…",
        completed: "任务已完成",
        needs_input: "需要你的输入或审批",
        error: payload.error ? `任务失败：${payload.error}` : "任务遇到错误"
    }[state];
}

function shouldPreserveFinalState(existingSession, nextState, now = Date.now())
{
    if ("idle" !== nextState || !existingSession)
    {
        return false;
    }

    const updatedAt = Date.parse(existingSession.updatedAt || "");
    const age = Number.isFinite(updatedAt) ? now - updatedAt : Number.POSITIVE_INFINITY;

    return ("completed" === existingSession.state && age < 15000) ||
        ("error" === existingSession.state && age < 60000);
}

async function main()
{
    const provider = String(process.argv[2] || "agent").toLowerCase();
    const eventName = process.argv[3] || "running";
    const input = await readStdin();
    let payload = {};

    if (input.trim())
    {
        try
        {
            payload = JSON.parse(input);
        }
        catch (_error)
        {
            payload = { message: input.trim() };
        }
    }

    const state = normalizeEvent(eventName, payload);
    const id = sessionIdentifier(provider, payload);
    const stateDirectory = resolveStateDirectory();
    const session = {
        protocolVersion: 1,
        id,
        provider: "claude" === provider ? "Claude Code" : "Codex",
        source: process.env.WSL_DISTRO_NAME ? `WSL · ${process.env.WSL_DISTRO_NAME}` : platformLabel(),
        state,
        event: eventName,
        message: messageFor(state, payload),
        cwd: payload.cwd || process.cwd(),
        pid: process.ppid,
        updatedAt: new Date().toISOString()
    };

    fs.mkdirSync(stateDirectory, { recursive: true });
    const statePath = path.join(stateDirectory, `${id}.json`);
    let existingSession = null;

    if (fs.existsSync(statePath))
    {
        try
        {
            existingSession = JSON.parse(fs.readFileSync(statePath, "utf8"));
        }
        catch (_error)
        {
            existingSession = null;
        }
    }

    if ("permissionrequest" === normalizedEventName(eventName))
    {
        const request = createApprovalRequest(provider, payload, session, stateDirectory);
        session.approvalId = request.id;
        session.message = `等待授权：${request.toolName} · ${request.summary}`.slice(0, 500);
        writeJsonAtomic(statePath, session);

        const decision = await waitForApprovalDecision(request, stateDirectory);
        if (decision)
        {
            writeJsonAtomic(statePath, {
                ...session,
                approvalId: undefined,
                state: "running",
                event: `PermissionRequest:${decision}`,
                message: "allow" === decision ? "已从桌宠允许操作" : "已从桌宠拒绝操作",
                updatedAt: new Date().toISOString()
            });
            process.stdout.write(`${JSON.stringify(permissionDecisionOutput(decision))}\n`);
        }
        return;
    }

    if (!shouldPreserveFinalState(existingSession, state))
    {
        writeJsonAtomic(statePath, session);
    }
}

if (require.main === module)
{
    main().catch((error) => {
        process.stderr.write(`Agent Pet bridge: ${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    approvalDirectoryForStateDirectory,
    createApprovalRequest,
    messageFor,
    normalizeEvent,
    permissionDecisionOutput,
    permissionSummary,
    resolveStateDirectory,
    sessionIdentifier,
    shouldPreserveFinalState,
    waitForApprovalDecision,
    windowsPathToWsl
};
