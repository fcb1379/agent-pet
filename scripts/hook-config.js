"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MANAGED_MARKER = "agent-pet-bridge.js";
const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "PermissionRequest", "Stop", "SessionEnd"];
const CLAUDE_EVENTS = ["SessionStart", "UserPromptSubmit", "PermissionRequest", "Notification", "Stop", "StopFailure", "SessionEnd"];

function readJson(filePath, fallback)
{
    if (!fs.existsSync(filePath))
    {
        return fallback;
    }

    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonWithBackup(filePath, value)
{
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const backupPath = `${filePath}.agent-pet.bak`;
    if (fs.existsSync(filePath) && !fs.existsSync(backupPath))
    {
        fs.copyFileSync(filePath, backupPath);
    }
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function commandFor(bridgePath, provider, eventName, nodeExecutable = "node")
{
    return `"${nodeExecutable}" "${bridgePath}" ${provider} ${eventName}`;
}

function removeManagedHandlers(config, events)
{
    config.hooks = config.hooks || {};

    for (const eventName of events)
    {
        const groups = Array.isArray(config.hooks[eventName]) ? config.hooks[eventName] : [];
        config.hooks[eventName] = groups
            .map((group) => ({
                ...group,
                hooks: Array.isArray(group.hooks)
                    ? group.hooks.filter((handler) => !String(handler.command || "").includes(MANAGED_MARKER))
                    : []
            }))
            .filter((group) => 0 < group.hooks.length);

        if (0 === config.hooks[eventName].length)
        {
            delete config.hooks[eventName];
        }
    }

    return config;
}

function addManagedHandlers(config, events, provider, bridgePath, nodeExecutable)
{
    removeManagedHandlers(config, events);
    config.hooks = config.hooks || {};

    for (const eventName of events)
    {
        config.hooks[eventName] = config.hooks[eventName] || [];
        const timeout = "PermissionRequest" === eventName
            ? 180
            : ("codex" === provider && "SessionEnd" === eventName ? 3 : 10);
        config.hooks[eventName].push({
            matcher: "",
            hooks: [{
                type: "command",
                command: commandFor(bridgePath, provider, eventName, nodeExecutable),
                timeout
            }]
        });
    }

    return config;
}

function configurationPaths()
{
    const home = os.homedir();
    return {
        installDirectory: path.join(home, ".agent-pet"),
        codexHooks: path.join(home, ".codex", "hooks.json"),
        claudeSettings: path.join(home, ".claude", "settings.json")
    };
}

module.exports = {
    CLAUDE_EVENTS,
    CODEX_EVENTS,
    MANAGED_MARKER,
    addManagedHandlers,
    commandFor,
    configurationPaths,
    readJson,
    removeManagedHandlers,
    writeJsonWithBackup
};
