"use strict";

const { OggOpusDecoder } = require("ogg-opus-decoder");

const OPUS_DECODE_SAMPLE_RATE = 16000;
const MAX_DECODED_SAMPLES = OPUS_DECODE_SAMPLE_RATE * 30 * 60;
const MAX_DECODE_CHANNELS = 8;
const OPUS_HEAD = Buffer.from("OpusHead", "ascii");

function containsOpusHead(audio)
{
    const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
    return -1 !== buffer.subarray(0, Math.min(buffer.length, 65536)).indexOf(OPUS_HEAD);
}

function wavFromChannelData(channelData, sampleRate)
{
    if (!Array.isArray(channelData) || 0 === channelData.length ||
        MAX_DECODE_CHANNELS < channelData.length)
    {
        throw new Error("Opus 音频声道数无效");
    }
    if (!Number.isInteger(sampleRate) || 8000 > sampleRate || 48000 < sampleRate)
    {
        throw new Error("Opus 音频采样率无效");
    }

    const sampleCount = channelData[0]?.length || 0;
    if (0 === sampleCount || MAX_DECODED_SAMPLES < sampleCount ||
        channelData.some((channel) => !(channel instanceof Float32Array) || channel.length !== sampleCount))
    {
        throw new Error("Opus 音频解码结果为空、过长或不完整");
    }

    const dataBytes = sampleCount * 2;
    const wav = Buffer.allocUnsafe(44 + dataBytes);
    wav.write("RIFF", 0, "ascii");
    wav.writeUInt32LE(36 + dataBytes, 4);
    wav.write("WAVE", 8, "ascii");
    wav.write("fmt ", 12, "ascii");
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36, "ascii");
    wav.writeUInt32LE(dataBytes, 40);

    for (let index = 0; index < sampleCount; index++)
    {
        let sample = 0;
        for (const channel of channelData)
        {
            sample += channel[index];
        }
        sample = Math.max(-1, Math.min(1, sample / channelData.length));
        const int16 = Math.round(sample * (0 > sample ? 0x8000 : 0x7fff));
        wav.writeInt16LE(int16, 44 + (index * 2));
    }
    return wav;
}

async function decodeOggOpusToWav(audio, options = {})
{
    const Decoder = options.Decoder || OggOpusDecoder;
    const decoder = new Decoder({ sampleRate: OPUS_DECODE_SAMPLE_RATE });
    try
    {
        await decoder.ready;
        const result = await decoder.decodeFile(new Uint8Array(
            audio.buffer,
            audio.byteOffset,
            audio.byteLength
        ));
        return wavFromChannelData(result.channelData, result.sampleRate);
    }
    catch (error)
    {
        throw new Error(`Ogg Opus 解码失败：${error.message}`);
    }
    finally
    {
        decoder.free();
    }
}

async function prepareAudioForWhisper(audio, mimeType, options = {})
{
    const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
    const type = String(mimeType || "").toLowerCase();
    const opus = "audio/opus" === type || containsOpusHead(buffer);
    if (!opus)
    {
        return { buffer, mimeType: type, extension: null };
    }
    if (!containsOpusHead(buffer))
    {
        throw new Error("原始 Opus packet 必须先封装为包含 OpusHead 的 Ogg Opus");
    }

    return {
        buffer: await decodeOggOpusToWav(buffer, options),
        mimeType: "audio/wav",
        extension: "wav"
    };
}

module.exports = {
    containsOpusHead,
    decodeOggOpusToWav,
    prepareAudioForWhisper,
    wavFromChannelData,
    MAX_DECODED_SAMPLES,
    OPUS_DECODE_SAMPLE_RATE
};
