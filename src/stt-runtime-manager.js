"use strict";

const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const {
    ensureSttRuntime,
    runtimeIsComplete,
    runtimePaths
} = require("./stt-runtime-installer");

const STT_START_TIMEOUT_MS = 90000;
const STT_MAX_RESTART_ATTEMPTS = 3;

function availableLoopbackPort()
{
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = address && "object" === typeof address ? address.port : 0;
            server.close((error) => error ? reject(error) : resolve(port));
        });
    });
}

function probeEndpoint(endpoint, timeoutMs = 1000)
{
    return new Promise((resolve) => {
        const request = http.get(endpoint, { timeout: timeoutMs }, (response) => {
            response.resume();
            resolve(200 <= response.statusCode && 500 > response.statusCode);
        });
        request.once("timeout", () => {
            request.destroy();
            resolve(false);
        });
        request.once("error", () => resolve(false));
    });
}

function delay(milliseconds)
{
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class SttRuntimeManager extends EventEmitter
{
    constructor(options = {})
    {
        super();
        this.resourcesPath = options.resourcesPath || process.resourcesPath;
        this.userDataPath = options.userDataPath;
        this.developmentRoot = options.developmentRoot || path.resolve(__dirname, "..");
        this.platform = options.platform || process.platform;
        this.arch = options.arch || process.arch;
        this.fetch = options.fetch || globalThis.fetch;
        this.spawn = options.spawn || spawn;
        this.ensureRuntime = options.ensureRuntime || ensureSttRuntime;
        this.portProvider = options.portProvider || availableLoopbackPort;
        this.probe = options.probe || probeEndpoint;
        this.startTimeoutMs = options.startTimeoutMs || STT_START_TIMEOUT_MS;
        this.delay = options.delay || delay;
        this.setTimer = options.setTimeout || setTimeout;
        this.clearTimer = options.clearTimeout || clearTimeout;
        this.child = null;
        this.endpoint = null;
        this.status = { status: "idle", ready: false, progress: null, detail: null };
        this.startPromise = null;
        this.restartTimer = null;
        this.restartAttempts = 0;
        this.stopping = false;
        this.logTail = "";
    }

    currentStatus()
    {
        return { ...this.status };
    }

    isReady()
    {
        return true === this.status.ready && Boolean(this.endpoint);
    }

    publish(status, changes = {})
    {
        this.status = {
            ...this.status,
            status,
            ready: "ready" === status,
            ...changes
        };
        this.emit("update", this.currentStatus());
    }

    bundledRuntimeRoot()
    {
        return path.join(this.resourcesPath || "", "stt");
    }

    developmentRuntimeRoot()
    {
        return path.join(this.developmentRoot, "vendor", "stt");
    }

    cachedRuntimeRoot()
    {
        return path.join(this.userDataPath, "stt-runtime");
    }

    async resolveRuntime()
    {
        const candidates = [this.bundledRuntimeRoot(), this.developmentRuntimeRoot()];
        for (const candidate of candidates)
        {
            if (runtimeIsComplete(candidate))
            {
                return runtimePaths(candidate);
            }
        }

        return this.ensureRuntime(this.cachedRuntimeRoot(), {
            platform: this.platform,
            arch: this.arch,
            fetch: this.fetch,
            onProgress: (progress) => {
                const totalBytes = Number(progress.totalBytes) || 0;
                const receivedBytes = Number(progress.receivedBytes) || 0;
                const percent = 0 < totalBytes
                    ? Math.max(0, Math.min(100, Math.round((receivedBytes / totalBytes) * 100)))
                    : null;
                this.publish("preparing", {
                    stage: progress.stage,
                    progress: percent,
                    detail: "model" === progress.stage ? "正在准备中文语音模型" : "正在准备本地语音引擎"
                });
            }
        });
    }

    start()
    {
        if (this.isReady())
        {
            return Promise.resolve(this.currentStatus());
        }
        if (this.startPromise)
        {
            return this.startPromise;
        }

        this.stopping = false;
        this.startPromise = this.initialize()
            .catch((error) => {
                if (!this.stopping && "restarting" !== this.status.status)
                {
                    this.publish("error", {
                        endpoint: null,
                        progress: null,
                        detail: error.message
                    });
                }
                throw error;
            })
            .finally(() => {
                this.startPromise = null;
            });
        return this.startPromise;
    }

    async initialize()
    {
        this.publish("preparing", { progress: null, detail: "正在加载本地语音转写" });
        const runtime = await this.resolveRuntime();
        if (this.stopping)
        {
            throw new Error("本地 STT 启动已取消");
        }

        const port = await this.portProvider();
        if (!Number.isInteger(port) || 1 > port || 65535 < port)
        {
            throw new Error("无法为本地 STT 分配端口");
        }
        const endpoint = `http://127.0.0.1:${port}/inference`;
        const threadCount = Math.max(2, Math.min(8, os.cpus().length - 2));
        const child = this.spawn(runtime.server, [
            "--model", runtime.model,
            "--host", "127.0.0.1",
            "--port", String(port),
            "--language", "zh",
            "--threads", String(threadCount),
            "--no-gpu"
        ], {
            cwd: path.dirname(runtime.server),
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"]
        });

        this.child = child;
        this.endpoint = endpoint;
        this.logTail = "";
        const appendLog = (chunk) => {
            this.logTail = `${this.logTail}${chunk}`.slice(-8000);
        };
        child.stdout?.on("data", appendLog);
        child.stderr?.on("data", appendLog);
        child.once("error", (error) => {
            appendLog(error.message);
        });
        child.once("exit", (code, signal) => this.handleExit(child, code, signal));

        this.publish("starting", {
            endpoint,
            progress: null,
            detail: "正在加载中文语音模型"
        });
        const deadline = Date.now() + this.startTimeoutMs;
        while (!this.stopping && child === this.child && Date.now() < deadline)
        {
            if (await this.probe(`http://127.0.0.1:${port}/`))
            {
                this.restartAttempts = 0;
                this.publish("ready", {
                    endpoint,
                    progress: 100,
                    detail: "本地语音转写已就绪"
                });
                return this.currentStatus();
            }
            await this.delay(250);
        }

        if (child === this.child)
        {
            this.child = null;
            child.kill();
        }
        this.endpoint = null;
        const details = this.logTail.trim();
        throw new Error(`本地 STT 启动超时${details ? `：${details}` : ""}`);
    }

    handleExit(child, code, signal)
    {
        if (child !== this.child)
        {
            return;
        }
        this.child = null;
        this.endpoint = null;
        if (this.stopping)
        {
            return;
        }

        this.restartAttempts++;
        if (STT_MAX_RESTART_ATTEMPTS < this.restartAttempts)
        {
            this.publish("error", {
                endpoint: null,
                progress: null,
                detail: `本地 STT 连续异常退出（code=${code}, signal=${signal || "none"}）`
            });
            return;
        }

        const waitMs = Math.min(8000, 1000 * (2 ** (this.restartAttempts - 1)));
        this.publish("restarting", {
            endpoint: null,
            progress: null,
            detail: `本地 STT 异常退出，${waitMs / 1000} 秒后自动恢复`
        });
        this.restartTimer = this.setTimer(() => {
            this.restartTimer = null;
            void this.start().catch(() => {});
        }, waitMs);
    }

    stop()
    {
        this.stopping = true;
        if (this.restartTimer)
        {
            this.clearTimer(this.restartTimer);
            this.restartTimer = null;
        }
        const child = this.child;
        this.child = null;
        this.endpoint = null;
        if (child)
        {
            child.kill();
        }
        this.publish("idle", { endpoint: null, progress: null, detail: null });
    }

    retry()
    {
        this.restartAttempts = 0;
        this.stop();
        this.stopping = false;
        return this.start();
    }
}

module.exports = {
    availableLoopbackPort,
    probeEndpoint,
    SttRuntimeManager,
    STT_MAX_RESTART_ATTEMPTS,
    STT_START_TIMEOUT_MS
};
