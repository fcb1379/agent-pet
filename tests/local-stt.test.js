"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
    DEFAULT_STT_ENDPOINT,
    LocalSttService,
    MAX_STT_CHUNK_BYTES,
    endpointIsLoopback,
    normalizeEndpoint,
    transcriptFromResponse
} = require("../src/local-stt");

function jsonResponse(value, status = 200)
{
    return {
        ok: 200 <= status && 300 > status,
        status,
        headers: { get: () => null },
        text: async () => JSON.stringify(value)
    };
}

test("local STT accepts only loopback HTTP endpoints", () => {
    assert.equal(endpointIsLoopback("http://127.0.0.1:8080/inference"), true);
    assert.equal(endpointIsLoopback("http://[::1]:8080/inference"), true);
    assert.equal(endpointIsLoopback("http://localhost:8080/inference"), true);
    assert.equal(endpointIsLoopback("https://example.com/inference"), false);
    assert.equal(endpointIsLoopback("http://127.0.0.1.evil.example/inference"), false);
    assert.equal(endpointIsLoopback("file:///tmp/transcript"), false);
    assert.equal(normalizeEndpoint("https://example.com/inference"), DEFAULT_STT_ENDPOINT);
});

test("local STT parses whisper text and segmented responses", () => {
    assert.equal(transcriptFromResponse('{"text":" 你好，世界 "}'), "你好，世界");
    assert.equal(transcriptFromResponse({ segments: [{ text: "你好" }, { text: "世界" }] }), "你好 世界");
    assert.throws(() => transcriptFromResponse({ result: "missing" }), /没有转写文本/);
    assert.throws(() => transcriptFromResponse('{"error":"busy"}'), /没有转写文本/);
});

test("local STT posts cumulative Opus audio and publishes a final transcript", async () => {
    const calls = [];
    const updates = [];
    const service = new LocalSttService({
        fetch: async (endpoint, options) => {
            const file = options.body.get("file");
            calls.push({
                endpoint,
                language: options.body.get("language"),
                responseFormat: options.body.get("response_format"),
                size: file.size,
                type: file.type,
                redirect: options.redirect
            });
            return jsonResponse({ text: 3 === file.size ? "你好" : "你好 世界" });
        }
    });
    service.on("update", (update) => updates.push(update));

    const started = service.start({ mimeType: "audio/ogg; codecs=opus" });
    service.append(Buffer.from([1, 2, 3]));
    await service.drain(service.session);
    service.append(Buffer.from([4, 5]));
    const finished = await service.finish();

    assert.equal(started.sessionId, 1);
    assert.equal(finished.text, "你好 世界");
    assert.deepEqual(calls.map((call) => call.size), [3, 5]);
    assert.equal(calls[0].endpoint, DEFAULT_STT_ENDPOINT);
    assert.equal(calls[0].language, "zh");
    assert.equal(calls[0].responseFormat, "json");
    assert.equal(calls[0].type, "audio/ogg");
    assert.equal(calls[0].redirect, "error");
    assert.equal(updates.at(-1).status, "complete");
    assert.equal(updates.at(-1).isFinal, true);
    assert.equal(service.isActive(), false);
});

test("local STT reports HTTP errors and closes a finishing session", async () => {
    const updates = [];
    const service = new LocalSttService({
        fetch: async () => jsonResponse({ error: "busy" }, 503)
    });
    service.on("update", (update) => updates.push(update));
    service.start({ mimeType: "audio/wav" });
    service.append(Buffer.from([1, 2, 3]));

    await assert.rejects(service.finish(), /HTTP 503/);
    assert.equal(service.isActive(), false);
    assert.equal(updates.at(-1).status, "error");
});

test("local STT uploads the audio produced by its built-in codec stage", async () => {
    let uploaded = null;
    const service = new LocalSttService({
        prepareAudio: async () => ({
            buffer: Buffer.from("RIFF converted"),
            mimeType: "audio/wav",
            extension: "wav"
        }),
        fetch: async (_endpoint, options) => {
            uploaded = options.body.get("file");
            return jsonResponse({ text: "转换成功" });
        }
    });
    service.start({ mimeType: "audio/ogg" });
    service.append(Buffer.from("OggS OpusHead"));
    await service.finish();

    assert.equal(uploaded.type, "audio/wav");
    assert.equal(uploaded.name, "recording.wav");
    assert.equal(await uploaded.text(), "RIFF converted");
});

test("finishing while a partial request is running completes the same session", async () => {
    let resolveRequest = null;
    const service = new LocalSttService({
        fetch: () => new Promise((resolve) => {
            resolveRequest = resolve;
        })
    });
    service.start({ mimeType: "audio/ogg" });
    service.append(Buffer.from([1, 2, 3]));

    const partial = service.drain(service.session);
    await new Promise((resolve) => setImmediate(resolve));
    const finishing = service.finish();
    resolveRequest(jsonResponse({ text: "并发结束正常" }));

    await partial;
    const result = await finishing;
    assert.equal(result.text, "并发结束正常");
    assert.equal(service.isActive(), false);
});

test("local STT bounds incoming chunks and requires an active session", () => {
    const service = new LocalSttService({ fetch: async () => jsonResponse({ text: "" }) });

    assert.throws(() => service.append(Buffer.from([1])), /尚未开始/);
    service.start({ mimeType: "audio/opus" });
    assert.throws(() => service.append(Buffer.alloc(MAX_STT_CHUNK_BYTES + 1)), /单个录音分片/);
    service.cancel();
});
