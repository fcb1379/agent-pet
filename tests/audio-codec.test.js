"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
    containsOpusHead,
    prepareAudioForWhisper,
    wavFromChannelData
} = require("../src/audio-codec");

test("PCM channel data becomes a mono 16-bit WAV", () => {
    const wav = wavFromChannelData([
        Float32Array.from([-1, 0.5, 1]),
        Float32Array.from([-1, -0.5, 1])
    ], 16000);

    assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), 6);
    assert.equal(wav.readInt16LE(44), -32768);
    assert.equal(wav.readInt16LE(46), 0);
    assert.equal(wav.readInt16LE(48), 32767);
});

test("Ogg Opus is decoded to 16 kHz WAV before whisper upload", async () => {
    const oggOpus = Buffer.concat([
        Buffer.from("OggS"),
        Buffer.alloc(24),
        Buffer.from("OpusHead"),
        Buffer.alloc(16)
    ]);
    let freed = false;
    class FakeDecoder
    {
        constructor(options)
        {
            assert.equal(options.sampleRate, 16000);
            this.ready = Promise.resolve();
        }

        async decodeFile(value)
        {
            assert.equal(containsOpusHead(value), true);
            return {
                channelData: [Float32Array.from([0, 0.25, -0.25])],
                sampleRate: 16000
            };
        }

        free()
        {
            freed = true;
        }
    }

    const prepared = await prepareAudioForWhisper(oggOpus, "audio/ogg", { Decoder: FakeDecoder });
    assert.equal(prepared.mimeType, "audio/wav");
    assert.equal(prepared.extension, "wav");
    assert.equal(prepared.buffer.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(freed, true);
});

test("raw Opus packets are rejected and ordinary WAV remains unchanged", async () => {
    const wav = Buffer.from("RIFF ordinary wav");
    const prepared = await prepareAudioForWhisper(wav, "audio/wav");
    assert.equal(prepared.buffer, wav);
    assert.equal(prepared.mimeType, "audio/wav");

    await assert.rejects(
        prepareAudioForWhisper(Buffer.from([1, 2, 3]), "audio/opus"),
        /必须先封装/
    );
});
