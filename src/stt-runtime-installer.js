"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const STT_RUNTIME_VERSION = "1.9.2";
const STT_RUNTIME_ARCHIVE_URL = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip";
const STT_RUNTIME_ARCHIVE_SHA256 = "49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a";
const STT_MODEL_NAME = "base";
const STT_MODEL_FILE = "ggml-base.bin";
const STT_MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";
const STT_MODEL_SHA1 = "465707469ff3a37a2b9b8d8f89f2f99de7299dac";
const STT_MANIFEST_FILE = "agent-pet-stt-runtime.json";
const STT_SERVER_RELATIVE_PATH = path.join("Release", "whisper-server.exe");
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

function runtimePaths(rootDirectory)
{
    return {
        root: rootDirectory,
        manifest: path.join(rootDirectory, STT_MANIFEST_FILE),
        server: path.join(rootDirectory, STT_SERVER_RELATIVE_PATH),
        model: path.join(rootDirectory, "models", STT_MODEL_FILE)
    };
}

function runtimeManifest()
{
    return {
        schema: 1,
        platform: "win32-x64",
        runtimeVersion: STT_RUNTIME_VERSION,
        runtimeArchiveSha256: STT_RUNTIME_ARCHIVE_SHA256,
        model: STT_MODEL_NAME,
        modelSha1: STT_MODEL_SHA1,
        server: STT_SERVER_RELATIVE_PATH.replaceAll("\\", "/"),
        modelFile: `models/${STT_MODEL_FILE}`
    };
}

function runtimeIsComplete(rootDirectory)
{
    const paths = runtimePaths(rootDirectory);
    try
    {
        const manifest = JSON.parse(fs.readFileSync(paths.manifest, "utf8"));
        const expected = runtimeManifest();
        return Object.keys(expected).every((key) => expected[key] === manifest[key]) &&
            fs.statSync(paths.server).isFile() && 0 < fs.statSync(paths.server).size &&
            fs.statSync(paths.model).isFile() && 0 < fs.statSync(paths.model).size;
    }
    catch (_error)
    {
        return false;
    }
}

function pruneRuntimeExecutables(rootDirectory)
{
    const releaseDirectory = path.join(rootDirectory, "Release");
    if (!fs.existsSync(releaseDirectory))
    {
        return [];
    }
    const serverName = path.basename(STT_SERVER_RELATIVE_PATH).toLowerCase();
    const removed = [];
    for (const entry of fs.readdirSync(releaseDirectory, { withFileTypes: true }))
    {
        if (entry.isFile() && ".exe" === path.extname(entry.name).toLowerCase() &&
            serverName !== entry.name.toLowerCase())
        {
            fs.rmSync(path.join(releaseDirectory, entry.name), { force: true });
            removed.push(entry.name);
        }
    }
    return removed;
}

async function downloadVerifiedFile(url, destination, options = {})
{
    const fetchImplementation = options.fetch || globalThis.fetch;
    if ("function" !== typeof fetchImplementation)
    {
        throw new Error("当前 Node.js 运行时不支持下载 STT 资源");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DOWNLOAD_TIMEOUT_MS);
    const temporaryPath = `${destination}.tmp`;
    const hash = crypto.createHash(options.algorithm);
    let receivedBytes = 0;

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    try
    {
        const response = await fetchImplementation(url, {
            redirect: "follow",
            signal: controller.signal
        });
        if (!response.ok || !response.body)
        {
            throw new Error(`下载失败（HTTP ${response.status}）`);
        }
        const totalBytes = Number(response.headers?.get?.("content-length")) || null;
        const progress = new Transform({
            transform(value, _encoding, callback)
            {
                const chunk = Buffer.from(value);
                hash.update(chunk);
                receivedBytes += chunk.length;
                if ("function" === typeof options.onProgress)
                {
                    options.onProgress({ receivedBytes, totalBytes });
                }
                callback(null, chunk);
            }
        });
        await pipeline(
            Readable.from(response.body),
            progress,
            fs.createWriteStream(temporaryPath, { flags: "w" })
        );

        const actualHash = hash.digest("hex");
        if (actualHash !== String(options.expectedHash || "").toLowerCase())
        {
            throw new Error(`资源校验失败：期望 ${options.expectedHash}，实际 ${actualHash}`);
        }
        if (fs.existsSync(destination))
        {
            fs.rmSync(destination, { force: true });
        }
        fs.renameSync(temporaryPath, destination);
        return { receivedBytes, hash: actualHash };
    }
    catch (error)
    {
        fs.rmSync(temporaryPath, { force: true });
        if ("AbortError" === error?.name)
        {
            throw new Error("下载 STT 资源超时");
        }
        throw error;
    }
    finally
    {
        clearTimeout(timeout);
    }
}

function extractZipWithWindowsTar(archivePath, destination, runner = spawn)
{
    const tarExecutable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    return new Promise((resolve, reject) => {
        let settled = false;
        const child = runner(tarExecutable, ["-xf", archivePath, "-C", destination], {
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"]
        });
        let errorText = "";
        child.stderr?.on("data", (chunk) => {
            errorText = `${errorText}${chunk}`.slice(-4000);
        });
        child.once("error", (error) => {
            if (!settled)
            {
                settled = true;
                reject(error);
            }
        });
        child.once("exit", (code) => {
            if (settled)
            {
                return;
            }
            settled = true;
            if (0 === code)
            {
                resolve();
            }
            else
            {
                reject(new Error(`解压 STT 运行时失败（退出码 ${code}）：${errorText.trim()}`));
            }
        });
    });
}

async function ensureSttRuntime(rootDirectory, options = {})
{
    if (runtimeIsComplete(rootDirectory))
    {
        return runtimePaths(rootDirectory);
    }
    if ("win32" !== (options.platform || process.platform) || "x64" !== (options.arch || process.arch))
    {
        throw new Error("内置本地 STT 当前仅支持 Windows x64");
    }

    const installingDirectory = `${rootDirectory}.installing-${process.pid}`;
    const archivePath = path.join(installingDirectory, "whisper-bin-x64.zip");
    const modelPath = path.join(installingDirectory, "models", STT_MODEL_FILE);
    const notify = (stage, progress = {}) => {
        if ("function" === typeof options.onProgress)
        {
            options.onProgress({ stage, ...progress });
        }
    };

    fs.rmSync(installingDirectory, { recursive: true, force: true });
    fs.mkdirSync(installingDirectory, { recursive: true });
    try
    {
        notify("runtime");
        await downloadVerifiedFile(STT_RUNTIME_ARCHIVE_URL, archivePath, {
            algorithm: "sha256",
            expectedHash: STT_RUNTIME_ARCHIVE_SHA256,
            fetch: options.fetch,
            onProgress: (progress) => notify("runtime", progress)
        });
        notify("extracting");
        const extractZip = options.extractZip || extractZipWithWindowsTar;
        await extractZip(archivePath, installingDirectory);
        fs.rmSync(archivePath, { force: true });
        pruneRuntimeExecutables(installingDirectory);

        notify("model");
        await downloadVerifiedFile(STT_MODEL_URL, modelPath, {
            algorithm: "sha1",
            expectedHash: STT_MODEL_SHA1,
            fetch: options.fetch,
            onProgress: (progress) => notify("model", progress)
        });
        fs.writeFileSync(
            path.join(installingDirectory, STT_MANIFEST_FILE),
            `${JSON.stringify(runtimeManifest(), null, 2)}\n`,
            "utf8"
        );
        if (!runtimeIsComplete(installingDirectory))
        {
            throw new Error("STT 运行时安装后完整性检查失败");
        }

        fs.rmSync(rootDirectory, { recursive: true, force: true });
        fs.renameSync(installingDirectory, rootDirectory);
        notify("complete");
        return runtimePaths(rootDirectory);
    }
    catch (error)
    {
        fs.rmSync(installingDirectory, { recursive: true, force: true });
        throw error;
    }
}

module.exports = {
    downloadVerifiedFile,
    ensureSttRuntime,
    extractZipWithWindowsTar,
    pruneRuntimeExecutables,
    runtimeIsComplete,
    runtimeManifest,
    runtimePaths,
    STT_MANIFEST_FILE,
    STT_MODEL_FILE,
    STT_MODEL_NAME,
    STT_MODEL_SHA1,
    STT_MODEL_URL,
    STT_RUNTIME_ARCHIVE_SHA256,
    STT_RUNTIME_ARCHIVE_URL,
    STT_RUNTIME_VERSION
};
