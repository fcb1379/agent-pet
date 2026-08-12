"use strict";

const { EventEmitter } = require("node:events");
const { prepareAudioForWhisper } = require("./audio-codec");

const DEFAULT_STT_ENDPOINT = "http://127.0.0.1:8080/inference";
const DEFAULT_STT_LANGUAGE = "zh";
const DEFAULT_STT_INTERVAL_MS = 1500;
const DEFAULT_STT_TIMEOUT_MS = 120000;
const MAX_STT_AUDIO_BYTES = 32 * 1024 * 1024;
const MAX_STT_CHUNK_BYTES = 1024 * 1024;
const MAX_STT_RESPONSE_BYTES = 1024 * 1024;
const SUPPORTED_AUDIO_TYPES = Object.freeze([
    "audio/ogg",
    "audio/opus",
    "audio/wav",
    "audio/x-wav",
    "audio/mpeg"
]);

function endpointIsLoopback(value)
{
    try
    {
        const endpoint = new URL(String(value || ""));
        const hostname = endpoint.hostname.toLowerCase();
        const ipv4Parts = hostname.split(".");
        const loopbackIpv4 = 4 === ipv4Parts.length && "127" === ipv4Parts[0] &&
            ipv4Parts.every((part) => /^\d{1,3}$/.test(part) && 255 >= Number(part));
        const loopbackHost = "localhost" === hostname || hostname.endsWith(".localhost") ||
            "[::1]" === hostname || "::1" === hostname || loopbackIpv4;

        return ["http:", "https:"].includes(endpoint.protocol) &&
            !endpoint.username && !endpoint.password && loopbackHost;
    }
    catch (_error)
    {
        return false;
    }
}

function normalizeEndpoint(value)
{
    const endpoint = String(value || "").trim();
    return endpointIsLoopback(endpoint) ? new URL(endpoint).toString() : DEFAULT_STT_ENDPOINT;
}

function normalizeLanguage(value)
{
    const language = String(value || "").trim().toLowerCase();
    return "auto" === language || /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(language)
        ? language
        : DEFAULT_STT_LANGUAGE;
}

function normalizeMimeType(value)
{
    const mimeType = String(value || "audio/ogg").split(";", 1)[0].trim().toLowerCase();
    if (!SUPPORTED_AUDIO_TYPES.includes(mimeType))
    {
        throw new Error(`不支持的录音格式：${mimeType || "未知格式"}`);
    }
    return mimeType;
}

function audioFileExtension(mimeType)
{
    const extensions = {
        "audio/ogg": "ogg",
        "audio/opus": "opus",
        "audio/wav": "wav",
        "audio/x-wav": "wav",
        "audio/mpeg": "mp3"
    };
    return extensions[mimeType] || "ogg";
}

function audioChunkBuffer(value)
{
    if (Buffer.isBuffer(value))
    {
        return value;
    }
    if (value instanceof ArrayBuffer)
    {
        return Buffer.from(value);
    }
    if (ArrayBuffer.isView(value))
    {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    if (Array.isArray(value))
    {
        return Buffer.from(value);
    }
    throw new TypeError("录音分片必须是二进制数据");
}

function transcriptFromResponse(value)
{
    if ("string" === typeof value)
    {
        const text = value.trim();
        if (!text)
        {
            return "";
        }
        let parsed = null;
        try
        {
            parsed = JSON.parse(text);
        }
        catch (_error)
        {
            return text;
        }
        return transcriptFromResponse(parsed);
    }
    if (value && "string" === typeof value.text)
    {
        return value.text.trim();
    }
    if (value && Array.isArray(value.segments))
    {
        return value.segments
            .map((segment) => "string" === typeof segment?.text ? segment.text.trim() : "")
            .filter(Boolean)
            .join(" ")
            .trim();
    }
    throw new Error("本地 STT 返回内容中没有转写文本");
}

class LocalSttService extends EventEmitter
{
    constructor(options = {})
    {
        super();
        this.fetch = options.fetch || globalThis.fetch;
        this.prepareAudio = options.prepareAudio || prepareAudioForWhisper;
        this.intervalMs = DEFAULT_STT_INTERVAL_MS;
        this.timeoutMs = DEFAULT_STT_TIMEOUT_MS;
        this.enabled = true;
        this.endpoint = DEFAULT_STT_ENDPOINT;
        this.language = DEFAULT_STT_LANGUAGE;
        this.session = null;
        this.nextSessionId = 0;
        this.configure(options);
    }

    configure(options = {})
    {
        this.enabled = false !== options.enabled;
        this.endpoint = normalizeEndpoint(options.endpoint || this.endpoint);
        this.language = normalizeLanguage(options.language || this.language);
        const intervalMs = Number(options.intervalMs);
        const timeoutMs = Number(options.timeoutMs);

        if (Number.isFinite(intervalMs))
        {
            this.intervalMs = Math.max(250, Math.min(5000, Math.round(intervalMs)));
        }
        if (Number.isFinite(timeoutMs))
        {
            this.timeoutMs = Math.max(1000, Math.min(300000, Math.round(timeoutMs)));
        }
        if (!this.enabled && this.session)
        {
            this.cancel();
        }
    }

    isActive()
    {
        return null !== this.session;
    }

    start(options = {})
    {
        if (!this.enabled)
        {
            throw new Error("本地语音转写未启用");
        }
        if ("function" !== typeof this.fetch)
        {
            throw new Error("当前运行环境不支持本地 STT HTTP 请求");
        }
        if (this.session)
        {
            throw new Error("已有录音正在转写");
        }

        this.nextSessionId = (this.nextSessionId + 1) >>> 0;
        this.session = {
            id: this.nextSessionId,
            mimeType: normalizeMimeType(options.mimeType),
            chunks: [],
            totalBytes: 0,
            lastSubmittedBytes: 0,
            transcript: "",
            timer: null,
            request: null,
            controller: null,
            finalRequested: false,
            lastError: null
        };
        this.publish(this.session, "listening", false);
        return { sessionId: this.session.id };
    }

    append(value)
    {
        const session = this.requireSession();
        const chunk = audioChunkBuffer(value);
        if (0 === chunk.length)
        {
            return { sessionId: session.id, acceptedBytes: 0, totalBytes: session.totalBytes };
        }
        if (MAX_STT_CHUNK_BYTES < chunk.length)
        {
            throw new Error(`单个录音分片不能超过 ${MAX_STT_CHUNK_BYTES / 1024} KB`);
        }
        if (MAX_STT_AUDIO_BYTES < session.totalBytes + chunk.length)
        {
            throw new Error(`单次录音不能超过 ${MAX_STT_AUDIO_BYTES / 1024 / 1024} MB`);
        }

        session.chunks.push(Buffer.from(chunk));
        session.totalBytes += chunk.length;
        this.schedule(session);
        return { sessionId: session.id, acceptedBytes: chunk.length, totalBytes: session.totalBytes };
    }

    async finish()
    {
        const session = this.requireSession();
        session.finalRequested = true;
        this.clearTimer(session);
        await this.drain(session);
        if (session.lastError)
        {
            throw session.lastError;
        }
        return { sessionId: session.id, text: session.transcript };
    }

    cancel()
    {
        const session = this.session;
        if (!session)
        {
            this.emit("update", { status: "idle", text: "", isFinal: false });
            return false;
        }

        this.clearTimer(session);
        this.session = null;
        if (session.controller)
        {
            session.controller.abort();
        }
        this.emit("update", {
            sessionId: session.id,
            status: "idle",
            text: "",
            isFinal: false
        });
        return true;
    }

    clear()
    {
        if (this.session)
        {
            return this.cancel();
        }
        this.emit("update", { status: "idle", text: "", isFinal: false });
        return true;
    }

    requireSession()
    {
        if (!this.session)
        {
            throw new Error("尚未开始录音转写会话");
        }
        return this.session;
    }

    schedule(session)
    {
        if (session !== this.session || session.finalRequested || session.timer || session.request)
        {
            return;
        }
        session.timer = setTimeout(() => {
            session.timer = null;
            void this.drain(session);
        }, this.intervalMs);
    }

    clearTimer(session)
    {
        if (session.timer)
        {
            clearTimeout(session.timer);
            session.timer = null;
        }
    }

    async drain(session)
    {
        if (session !== this.session)
        {
            return;
        }
        if (session.request)
        {
            await session.request;
            if (session === this.session && session.finalRequested)
            {
                await this.drain(session);
            }
            return;
        }
        if (session.lastSubmittedBytes >= session.totalBytes)
        {
            if (session.finalRequested)
            {
                this.complete(session);
            }
            return;
        }

        const submittedBytes = session.totalBytes;
        const audio = Buffer.concat(session.chunks, session.totalBytes);
        this.publish(session, "transcribing", false);
        let requestError = null;
        session.request = this.requestTranscription(session, audio)
            .then((text) => {
                if (session !== this.session)
                {
                    return;
                }
                session.lastSubmittedBytes = submittedBytes;
                session.transcript = text;
                session.lastError = null;
                this.publish(session, "listening", false);
            })
            .catch((error) => {
                if (session !== this.session || "AbortError" === error?.name)
                {
                    return;
                }
                requestError = error;
                session.lastError = error;
                this.publish(session, "error", false, error.message);
            })
            .finally(() => {
                session.request = null;
                session.controller = null;
            });
        await session.request;

        if (session !== this.session)
        {
            return;
        }
        if (requestError)
        {
            if (session.finalRequested)
            {
                this.session = null;
                return;
            }
            if (submittedBytes < session.totalBytes)
            {
                this.schedule(session);
            }
            return;
        }
        if (session.finalRequested)
        {
            if (session.lastSubmittedBytes >= session.totalBytes)
            {
                this.complete(session);
            }
            return;
        }
        if (session.lastSubmittedBytes < session.totalBytes)
        {
            this.schedule(session);
        }
    }

    complete(session)
    {
        if (session !== this.session)
        {
            return;
        }
        this.session = null;
        this.publish(session, "complete", true);
    }

    publish(session, status, isFinal, error = null)
    {
        this.emit("update", {
            sessionId: session.id,
            status,
            text: session.transcript,
            isFinal: true === isFinal,
            error,
            receivedBytes: session.totalBytes
        });
    }

    async requestTranscription(session, audio)
    {
        const prepared = await this.prepareAudio(audio, session.mimeType);
        const preparedAudio = Buffer.isBuffer(prepared?.buffer)
            ? prepared.buffer
            : Buffer.from(prepared?.buffer || []);
        const preparedMimeType = prepared?.mimeType || session.mimeType;
        const extension = prepared?.extension || audioFileExtension(preparedMimeType);

        if (0 === preparedAudio.length)
        {
            throw new Error("音频转换结果为空");
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        const form = new FormData();
        session.controller = controller;
        form.append("file", new Blob([preparedAudio], { type: preparedMimeType }), `recording.${extension}`);
        form.append("response_format", "json");
        form.append("temperature", "0");
        if ("auto" !== this.language)
        {
            form.append("language", this.language);
        }

        try
        {
            const response = await this.fetch(this.endpoint, {
                method: "POST",
                body: form,
                redirect: "error",
                signal: controller.signal
            });
            if (!response.ok)
            {
                throw new Error(`本地 STT 请求失败（HTTP ${response.status}）`);
            }
            const contentLength = Number(response.headers?.get?.("content-length"));
            if (Number.isFinite(contentLength) && MAX_STT_RESPONSE_BYTES < contentLength)
            {
                throw new Error("本地 STT 返回内容过大");
            }
            const body = await response.text();
            if (MAX_STT_RESPONSE_BYTES < Buffer.byteLength(body))
            {
                throw new Error("本地 STT 返回内容过大");
            }
            return transcriptFromResponse(body);
        }
        catch (error)
        {
            if ("AbortError" === error?.name)
            {
                throw new Error("本地 STT 请求超时");
            }
            throw error;
        }
        finally
        {
            clearTimeout(timeout);
        }
    }
}

module.exports = {
    DEFAULT_STT_ENDPOINT,
    DEFAULT_STT_INTERVAL_MS,
    DEFAULT_STT_LANGUAGE,
    LocalSttService,
    MAX_STT_AUDIO_BYTES,
    MAX_STT_CHUNK_BYTES,
    SUPPORTED_AUDIO_TYPES,
    audioFileExtension,
    endpointIsLoopback,
    normalizeEndpoint,
    normalizeLanguage,
    normalizeMimeType,
    transcriptFromResponse
};
