"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { installHooks, verifyInstalledBridge } = require("../scripts/install-hooks");

function windowsPathToWsl(windowsPath)
{
    const match = /^([A-Za-z]):\\(.*)$/.exec(String(windowsPath));
    if (!match)
    {
        return String(windowsPath).replaceAll("\\", "/");
    }

    return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

function materializeWslInstaller(localAppData)
{
    const root = path.join(localAppData, "AgentPet", "setup-package");
    const scripts = path.join(root, "scripts");
    const bridge = path.join(root, "bridge");
    fs.mkdirSync(scripts, { recursive: true });
    fs.mkdirSync(bridge, { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, "..", "scripts", "install-hooks.js"), path.join(scripts, "install-hooks.js"));
    fs.copyFileSync(path.resolve(__dirname, "..", "scripts", "hook-config.js"), path.join(scripts, "hook-config.js"));
    fs.copyFileSync(path.resolve(__dirname, "..", "bridge", "agent-pet-bridge.js"), path.join(bridge, "agent-pet-bridge.js"));
    return root;
}

function installLocalAi(localAppData, execFileSync = childProcess.execFileSync)
{
    const result = {
        windows: { ok: false, message: "" },
        wsl: { ok: false, message: "" }
    };

    try
    {
        const paths = installHooks({ execFileSync });
        const verification = verifyInstalledBridge(paths, { execFileSync });
        result.windows = {
            ok: true,
            message: `Codex: ${paths.codexHooks}\nClaude: ${paths.claudeSettings}\nSelf-test: ${verification.stateDirectory}`
        };
    }
    catch (error)
    {
        result.windows.message = error.message;
    }

    try
    {
        const installerRoot = materializeWslInstaller(localAppData);
        const installerPath = windowsPathToWsl(path.join(installerRoot, "scripts", "install-hooks.js"));
        const output = execFileSync(
            "wsl.exe",
            ["--", "node", installerPath, "--self-test"],
            { encoding: "utf8", windowsHide: true, timeout: 60000 }
        );
        result.wsl = { ok: true, message: output.trim() };
    }
    catch (error)
    {
        const details = error.stderr ? String(error.stderr).trim() : error.message;
        result.wsl.message = details || "默认 WSL 未安装或缺少 Node.js";
    }

    return result;
}

module.exports = {
    installLocalAi,
    materializeWslInstaller,
    windowsPathToWsl
};