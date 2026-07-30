"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const STAMP_FILE = ".agent-pet-package-lock.sha256";

function packageLockHash(projectDirectory)
{
    const lockPath = path.join(projectDirectory, "package-lock.json");
    return crypto.createHash("sha256").update(fs.readFileSync(lockPath)).digest("hex");
}

function dependencyNames(projectDirectory)
{
    const manifest = JSON.parse(fs.readFileSync(path.join(projectDirectory, "package.json"), "utf8"));
    return [
        ...Object.keys(manifest.dependencies || {}),
        ...Object.keys(manifest.devDependencies || {})
    ];
}

function dependencyStatus(projectDirectory)
{
    const nodeModulesDirectory = path.join(projectDirectory, "node_modules");
    const stampPath = path.join(nodeModulesDirectory, STAMP_FILE);
    const expectedHash = packageLockHash(projectDirectory);
    const actualHash = fs.existsSync(stampPath)
        ? fs.readFileSync(stampPath, "utf8").trim()
        : "";
    const missing = dependencyNames(projectDirectory).filter((name) => {
        try
        {
            require.resolve(`${name}/package.json`, { paths: [projectDirectory] });
            return false;
        }
        catch (_error)
        {
            return true;
        }
    });
    return {
        current: expectedHash === actualHash && 0 === missing.length,
        expectedHash,
        missing,
        stampPath
    };
}

function writeDependencyStamp(projectDirectory)
{
    const nodeModulesDirectory = path.join(projectDirectory, "node_modules");
    fs.mkdirSync(nodeModulesDirectory, { recursive: true });
    fs.writeFileSync(
        path.join(nodeModulesDirectory, STAMP_FILE),
        `${packageLockHash(projectDirectory)}\n`,
        "utf8"
    );
}

function ensureDependencies(projectDirectory, runner = spawnSync)
{
    const status = dependencyStatus(projectDirectory);
    if (status.current)
    {
        return { installed: false, status };
    }

    const reasons = [];
    if (0 < status.missing.length)
    {
        reasons.push(`缺少 ${status.missing.join("、")}`);
    }
    if (!fs.existsSync(status.stampPath) || fs.readFileSync(status.stampPath, "utf8").trim() !== status.expectedHash)
    {
        reasons.push("package-lock.json 已更新");
    }
    process.stdout.write(`检测到依赖需要同步（${reasons.join("；")}），正在自动执行 npm ci…\n`);

    const isWindows = "win32" === process.platform;
    const npmCommand = isWindows ? (process.env.ComSpec || "cmd.exe") : "npm";
    const npmArguments = isWindows
        ? ["/d", "/s", "/c", "npm.cmd ci --no-audit --no-fund"]
        : ["ci", "--no-audit", "--no-fund"];
    const result = runner(
        npmCommand,
        npmArguments,
        { cwd: projectDirectory, stdio: "inherit", shell: false, windowsHide: isWindows }
    );
    if (0 !== result.status)
    {
        const reason = result.error ? `（${result.error.message}）` : "";
        throw new Error(`依赖自动安装失败${reason}。请检查网络和 Node.js 版本，然后手动运行 npm ci。`);
    }
    return { installed: true, status: dependencyStatus(projectDirectory) };
}

if (require.main === module)
{
    const projectDirectory = path.resolve(__dirname, "..");
    try
    {
        if (process.argv.includes("--stamp"))
        {
            writeDependencyStamp(projectDirectory);
        }
        else
        {
            ensureDependencies(projectDirectory);
        }
    }
    catch (error)
    {
        process.stderr.write(`Agent Pet 依赖检查失败：${error.message}\n`);
        process.exitCode = 1;
    }
}

module.exports = {
    dependencyNames,
    dependencyStatus,
    ensureDependencies,
    packageLockHash,
    STAMP_FILE,
    writeDependencyStamp
};
