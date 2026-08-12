"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const audio = require("../src/hardware-audio");

function makeFrame(type, session, sequence, index, count, payload)
{
    const body = Uint8Array.from(payload);
    const frame = new Uint8Array(13 + body.length);

    frame.set([0x41, 0x4f, 1, type, session & 0xff, session >>> 8,
        sequence & 0xff, sequence >>> 8, sequence >>> 16,
        index, count, body.length], 0);
    frame.set(body, 12);
    frame[frame.length - 1] = audio.crc8Atm(frame.subarray(0, -1));
    return frame;
}

function startPayload()
{
    const payload = new Uint8Array(12);
    const view = new DataView(payload.buffer);

    view.setUint32(0, 16000, true);
    payload[4] = 1;
    view.setUint16(5, 320, true);
    view.setUint16(7, 312, true);
    payload.set([0xc0, 0x5d, 0], 9);
    return payload;
}

function endPayload(packetCount)
{
    const payload = new Uint8Array(8);
    new DataView(payload.buffer).setUint32(0, packetCount, true);
    return payload;
}

function assertOggPage(page)
{
    assert.equal(Buffer.from(page.subarray(0, 4)).toString("ascii"), "OggS");
    const copy = page.slice();
    const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
    const expected = view.getUint32(22, true);
    view.setUint32(22, 0, true);
    assert.equal(audio.oggCrc(copy), expected);
}
test("fragmented hardware Opus becomes a complete Ogg Opus stream", async () => {
    const events = [];
    const chunks = [];
    const errors = [];
    const receiver = new audio.HardwareAudioReceiver({
        onStart: async (metadata) => {
            events.push("start");
            assert.equal(metadata.sampleRate, 16000);
            assert.equal(metadata.bitrate, 24000);
        },
        onChunk: async (chunk) => {
            events.push("chunk");
            chunks.push(chunk);
        },
        onFinish: async () => events.push("finish"),
        onCancel: async () => events.push("cancel"),
        onError: (error) => errors.push(error)
    });
    const packet = Uint8Array.from([0xf8, 0xff, 0xfe, 0x11, 0x22]);

    await receiver.push(makeFrame(audio.AUDIO_TYPE_START, 9, 0, 0, 1, startPayload()));
    await receiver.push(makeFrame(audio.AUDIO_TYPE_DATA, 9, 0, 0, 2, packet.subarray(0, 2)));
    await receiver.push(makeFrame(audio.AUDIO_TYPE_DATA, 9, 0, 1, 2, packet.subarray(2)));
    await receiver.push(makeFrame(audio.AUDIO_TYPE_END, 9, 1, 0, 1, endPayload(1)));

    assert.equal(errors.length, 0);
    assert.equal(chunks.length, 4);
    chunks.forEach(assertOggPage);
    assert.ok(Buffer.from(chunks[0]).includes(Buffer.from("OpusHead")));
    assert.ok(Buffer.from(chunks[1]).includes(Buffer.from("OpusTags")));
    assert.ok(Buffer.from(chunks[2]).includes(Buffer.from(packet)));
    assert.equal(chunks[3][5], 0x04);
    assert.deepEqual(events, [
        "start", "chunk", "chunk", "chunk", "chunk", "finish"
    ]);
});
test("CRC damage and packet loss never finish partial transcription", async () => {
    const events = [];
    const errors = [];
    const receiver = new audio.HardwareAudioReceiver({
        onStart: async () => events.push("start"),
        onChunk: async () => events.push("chunk"),
        onFinish: async () => events.push("finish"),
        onCancel: async () => events.push("cancel"),
        onError: (error) => errors.push(error)
    });
    const valid = makeFrame(audio.AUDIO_TYPE_DATA, 7, 0x123456, 0, 1, [1, 2, 3]);
    const parsed = audio.parseAudioFrame(valid);

    assert.equal(parsed.sequence, 0x123456);
    const corrupted = valid.slice();
    corrupted[12] ^= 1;
    assert.throws(
        () => audio.parseAudioFrame(corrupted),
        /Invalid hardware audio frame/
    );

    await receiver.push(makeFrame(audio.AUDIO_TYPE_START, 12, 0, 0, 1, startPayload()));
    await receiver.push(makeFrame(audio.AUDIO_TYPE_DATA, 12, 1, 0, 1, [0xf8]));

    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /packet gap/);
    assert.equal(events.at(-1), "cancel");
    assert.ok(!events.includes("finish"));
});

test("busy error before stream start is reported without partial transcription", async () => {
    const events = [];
    const errors = [];
    const receiver = new audio.HardwareAudioReceiver({
        onStart: async () => events.push("start"),
        onFinish: async () => events.push("finish"),
        onCancel: async () => events.push("cancel"),
        onError: (error) => errors.push(error)
    });

    await receiver.push(makeFrame(audio.AUDIO_TYPE_ERROR, 13, 0, 0, 1, [2]));

    assert.deepEqual(events, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /microphone is busy/);
});
