#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
    CLAUDE_EVENTS,
    CODEX_EVENTS,
    addManagedHandlers,
    configurationPaths,
    readJson,
    writeJsonWithBackup
} = require("./hook-config");

function bundledNodeExecutable(platform = process.platform)
{
    if ("win32" !== platform)
    {
        return null;
    }

    const archivePath = path.resolve(__dirname, "..", "node_modules", "node-win-x64", "bin", "node.exe");
    const unpackedPath = archivePath.replace(
        `${path.sep}app.asar${path.sep}`,
        `${path.sep}app.asar.unpacked${path.sep}`
    );
    return [unpackedPath, archivePath].find((candidate) => fs.existsSync(candidate)) || null;
}
function resolveNodeExecutable(execFileSync = childProcess.execFileSync)
{
    const bundledExecutable = bundledNodeExecutable();
    if (bundledExecutable)
    {
        return bundledExecutable;
    }
    if (/^node(?:\.exe)?$/i.test(path.basename(process.execPath)))
    {
        return process.execPath;
    }

    const isWindows = "win32" === process.platform;
    const output = execFileSync(
        isWindows ? "where.exe" : "sh",
        isWindows ? ["node"] : ["-lc", "command -v node"],
        { encoding: "utf8", windowsHide: true }
    );
    const executable = String(output || "").split(/\r?\n/).find(Boolean);
    if (!executable)
    {
        throw new Error("Node.js 18 or newer is required to install Agent Pet hooks");
    }
    return executable.trim();
}

function installNodeRuntime(installDirectory, sourceExecutable)
{
    if ("win32" !== process.platform)
    {
        return sourceExecutable;
    }

    const runtimeDirectory = path.join(installDirectory, "runtime");
    const installedExecutable = path.join(runtimeDirectory, "node.exe");
    fs.mkdirSync(runtimeDirectory, { recursive: true });
    if (path.resolve(sourceExecutable) !== path.resolve(installedExecutable))
    {
        fs.copyFileSync(sourceExecutable, installedExecutable);
    }
    return installedExecutable;
}
function installHooks(options = {})
{
    const paths = configurationPaths();
    const sourceNodeExecutable = options.nodeExecutable || resolveNodeExecutable(options.execFileSync);
    fs.mkdirSync(paths.installDirectory, { recursive: true });
    const nodeExecutable = installNodeRuntime(paths.installDirectory, sourceNodeExecutable);
    const sourceBridge = path.resolve(__dirname, "..", "bridge", "agent-pet-bridge.js");
    const installedBridge = path.join(paths.installDirectory, "agent-pet-bridge.js");

    fs.copyFileSync(sourceBridge, installedBridge);

    const codexConfig = addManagedHandlers(
        readJson(paths.codexHooks, { hooks: {} }),
        CODEX_EVENTS,
        "codex",
        installedBridge,
        nodeExecutable
    );
    const claudeConfig = addManagedHandlers(
        readJson(paths.claudeSettings, {}),
        CLAUDE_EVENTS,
        "claude",
        installedBridge,
        nodeExecutable
    );

    writeJsonWithBackup(paths.codexHooks, codexConfig);
    writeJsonWithBackup(paths.claudeSettings, claudeConfig);

    return { ...paths, installedBridge, nodeExecutable };
}

function verifyInstalledBridge(paths, options = {})
{
    const execFileSync = options.execFileSync || childProcess.execFileSync;
    const nodeExecutable = options.nodeExecutable || paths.nodeExecutable || resolveNodeExecutable(execFileSync);
    const bridge = require(paths.installedBridge);
    const stateDirectory = options.stateDirectory || bridge.resolveStateDirectory();
    const verificationId = `agent-pet-setup-${process.pid}-${Date.now()}`;
    const providers = ["codex", "claude"];

    try
    {
        for (const provider of providers)
        {
            const sessionId = `${verificationId}-${provider}`;
            const expectedPath = path.join(stateDirectory, `${provider}-${sessionId}.json`);
            execFileSync(
                nodeExecutable,
                [paths.installedBridge, provider, "SessionStart"],
                {
                    encoding: "utf8",
                    env: { ...process.env, AGENT_PET_STATE_DIR: stateDirectory },
                    input: JSON.stringify({
                        session_id: sessionId,
                        cwd: os.homedir(),
                        source: "agent-pet-setup"
                    }),
                    timeout: 10000,
                    windowsHide: true
                }
            );
            const session = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
            if (session.provider !== ("claude" === provider ? "Claude Code" : "Codex"))
            {
                throw new Error(`${provider} bridge self-test returned invalid session data`);
            }
        }
    }
    finally
    {
        for (const provider of providers)
        {
            fs.rmSync(path.join(stateDirectory, `${provider}-${verificationId}-${provider}.json`), { force: true });
        }
    }

    return { stateDirectory };
}

function main()
{
    const paths = installHooks();
    const verification = process.argv.includes("--self-test")
        ? verifyInstalledBridge(paths)
        : null;
    process.stdout.write([
        "Agent Pet hooks installed.",
        `  Codex: ${paths.codexHooks}`,
        `  Claude Code: ${paths.claudeSettings}`,
        `  Bridge: ${paths.installedBridge}`,
        verification ? `  Self-test: OK (${verification.stateDirectory})` : "",
        "",
        "Restart both CLIs. In Codex, run /hooks once and trust the Agent Pet hooks.",
        "Run this installer separately in Windows and in each WSL distribution you use.",
        ""
    ].join("\n"));
}

if (require.main === module)
{
    try
    {
        main();
    }
    catch (error)
    {
        process.stderr.write(`Install failed: ${error.message}\n`);
        process.exitCode = 1;
    }
}

module.exports = {
    bundledNodeExecutable,
    installNodeRuntime,
    installHooks,
    resolveNodeExecutable,
    verifyInstalledBridge
};
