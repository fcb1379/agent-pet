"use strict";

const FRAME_SIZE = 20;
const FRAME_PAYLOAD_SIZE = 10;
const MAX_SESSION_COUNT = 12;
const MAX_MASCOT_IMAGE_BYTES = 512 * 1024;
const SERVICE_UUID = "7a1e0001-6b5f-4f5c-8c9d-3e2f1a0b1000";
const STATUS_RX_UUID = "7a1e0002-6b5f-4f5c-8c9d-3e2f1a0b1000";
const IMAGE_RX_UUID = "7a1e0003-6b5f-4f5c-8c9d-3e2f1a0b1000";
const IMAGE_DIGEST_UUID = "7a1e0004-6b5f-4f5c-8c9d-3e2f1a0b1000";
const DAILY_MERIT_UUID = "7a1e0005-6b5f-4f5c-8c9d-3e2f1a0b1000";
const AUDIO_STREAM_UUID = "7a1e0006-6b5f-4f5c-8c9d-3e2f1a0b1000";
const AUDIO_CONTROL_FRAME_SIZE = 5;
const AUDIO_CONTROL_COMMAND_START = 1;
const AUDIO_CONTROL_COMMAND_STOP = 2;
const DAILY_MERIT_FRAME_SIZE = 16;
const DAILY_MERIT_MAX_COUNT = 0x7fffffff;
const MESSAGE_TYPE_SNAPSHOT = 1;
const MESSAGE_TYPE_WOODEN_FISH = 2;
const MESSAGE_TYPE_TIME_SYNC = 3;
const MESSAGE_TYPE_ANIMATION = 4;
const WOODEN_FISH_ACTION = 1;
const ANIMATION_ACTION_PLAY = 1;
const ANIMATION_ACTION_RESTORE = 2;
const ANIMATION_ACTION_TYPING_START = 3;
const ANIMATION_ACTION_TYPING_STOP = 4;
const IMAGE_MAGIC_FIRST = 0x41;
const IMAGE_MAGIC_SECOND = 0x49;
const IMAGE_COMMAND_BEGIN = 1;
const IMAGE_COMMAND_DATA = 2;
const IMAGE_COMMAND_COMMIT = 3;
const IMAGE_COMMAND_RESET = 4;
const IMAGE_COMMAND_SELECT = 5;
const IMAGE_SLOT_COUNT = 5;
const IMAGE_FORMAT_JPEG = 1;
const IMAGE_FORMAT_GIF = 2;
const IMAGE_DATA_SIZE = 235;
const IMAGE_DATA_SIZES = Object.freeze([235, 176, 120, 64, 11]);
const IMAGE_PACKET_OVERHEAD = 9;

const STATE_CODES = Object.freeze({
    idle: 0,
    running: 1,
    needs_input: 2,
    completed: 3,
    error: 4
});

function crc8Atm(data)
{
    let crc = 0;

    for (const value of data)
    {
        crc ^= value;
        for (let bit = 0; bit < 8; bit++)
        {
            crc = 0 !== (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
        }
    }

    return crc;
}

function crc32Mpeg2(data, initial = 0xffffffff)
{
    let crc = Number(initial) >>> 0;

    for (const value of data)
    {
        crc = (crc ^ ((value & 0xff) << 24)) >>> 0;
        for (let bit = 0; bit < 8; bit++)
        {
            crc = 0 !== (crc & 0x80000000)
                ? (((crc << 1) ^ 0x04c11db7) >>> 0)
                : ((crc << 1) >>> 0);
        }
    }

    return crc >>> 0;
}

function validDailyMeritDay(day)
{
    if (!Number.isInteger(day) || 20200101 > day || 20381231 < day)
    {
        return false;
    }
    const text = String(day);
    const date = new Date(`${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T00:00:00`);
    return !Number.isNaN(date.getTime()) &&
        date.getFullYear() === Number(text.slice(0, 4)) &&
        date.getMonth() + 1 === Number(text.slice(4, 6)) &&
        date.getDate() === Number(text.slice(6, 8));
}

function encodeDailyMerit(day, count)
{
    if (!validDailyMeritDay(day) || !Number.isInteger(count) ||
        0 > count || DAILY_MERIT_MAX_COUNT < count)
    {
        throw new Error("Invalid daily merit value");
    }
    const frame = new Uint8Array(DAILY_MERIT_FRAME_SIZE);
    const view = new DataView(frame.buffer);

    frame[0] = 0x41;
    frame[1] = 0x4d;
    frame[2] = 1;
    frame[3] = 1;
    view.setUint32(4, day, true);
    view.setUint32(8, count, true);
    frame[15] = crc8Atm(frame.subarray(0, 15));
    return frame;
}

function encodeAudioControl(active)
{
    const frame = new Uint8Array(AUDIO_CONTROL_FRAME_SIZE);

    frame[0] = 0x41;
    frame[1] = 0x43;
    frame[2] = 1;
    frame[3] = true === active
        ? AUDIO_CONTROL_COMMAND_START
        : AUDIO_CONTROL_COMMAND_STOP;
    frame[4] = crc8Atm(frame.subarray(0, 4));
    return frame;
}

function parseDailyMerit(value)
{
    const bytes = value instanceof DataView
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : Uint8Array.from(value || []);
    if (DAILY_MERIT_FRAME_SIZE !== bytes.length || 0x41 !== bytes[0] ||
        0x4d !== bytes[1] || 1 !== bytes[2] ||
        bytes[15] !== crc8Atm(bytes.subarray(0, 15)))
    {
        throw new Error("Invalid daily merit response");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const day = view.getUint32(4, true);
    const count = view.getUint32(8, true);
    if (!validDailyMeritDay(day) || DAILY_MERIT_MAX_COUNT < count)
    {
        throw new Error("Invalid daily merit value");
    }
    return { day, count };
}

function setUint24(view, offset, value)
{
    view[offset] = value & 0xff;
    view[offset + 1] = (value >>> 8) & 0xff;
    view[offset + 2] = (value >>> 16) & 0xff;
}

function finalizeImageFrame(frame)
{
    const crcOffset = frame.length - 1;

    frame[crcOffset] = crc8Atm(frame.subarray(0, crcOffset));
    return frame;
}

function validImageSlot(slot)
{
    return Number.isInteger(slot) && 0 <= slot && IMAGE_SLOT_COUNT > slot;
}

function encodeMascotSelect(slot)
{
    if (!validImageSlot(slot))
    {
        throw new Error(`Invalid mascot image slot: ${slot}`);
    }
    const frame = new Uint8Array(FRAME_SIZE);

    frame[0] = IMAGE_MAGIC_FIRST;
    frame[1] = IMAGE_MAGIC_SECOND;
    frame[2] = 2;
    frame[3] = IMAGE_COMMAND_SELECT;
    frame[4] = slot;
    return finalizeImageFrame(frame);
}

function encodeMascotReset(slot = 0)
{
    if (!validImageSlot(slot))
    {
        throw new Error(`Invalid mascot image slot: ${slot}`);
    }
    const frame = new Uint8Array(FRAME_SIZE);

    frame[0] = IMAGE_MAGIC_FIRST;
    frame[1] = IMAGE_MAGIC_SECOND;
    frame[2] = 2;
    frame[3] = IMAGE_COMMAND_RESET;
    frame[12] = slot;
    return [finalizeImageFrame(frame)];
}

function encodeMascotImage(imageBytes, dataSize = IMAGE_DATA_SIZE, slot = 0)
{
    const image = imageBytes instanceof Uint8Array
        ? imageBytes
        : Uint8Array.from(imageBytes || []);
    if (4 > image.length || MAX_MASCOT_IMAGE_BYTES < image.length)
    {
        throw new Error(`硬件桌宠图片必须介于 4 字节和 ${MAX_MASCOT_IMAGE_BYTES} 字节之间`);
    }

    if (!Number.isInteger(dataSize) || 1 > dataSize || IMAGE_DATA_SIZE < dataSize)
    {
        throw new Error(`Invalid mascot image data size: ${dataSize}`);
    }
    if (!validImageSlot(slot))
    {
        throw new Error(`Invalid mascot image slot: ${slot}`);
    }

    const imageFormat = 6 <= image.length &&
        0x47 === image[0] && 0x49 === image[1] && 0x46 === image[2] &&
        0x38 === image[3] && 0x39 === image[4] && 0x61 === image[5]
        ? IMAGE_FORMAT_GIF
        : IMAGE_FORMAT_JPEG;
    const imageCrc = crc32Mpeg2(image);
    const frames = [];
    const begin = new Uint8Array(FRAME_SIZE);
    const beginView = new DataView(begin.buffer);

    begin[0] = IMAGE_MAGIC_FIRST;
    begin[1] = IMAGE_MAGIC_SECOND;
    begin[2] = 2;
    begin[3] = IMAGE_COMMAND_BEGIN;
    setUint24(begin, 4, image.length);
    begin[7] = imageFormat;
    beginView.setUint32(8, imageCrc, true);
    begin[12] = slot;
    frames.push(finalizeImageFrame(begin));

    for (let offset = 0; offset < image.length; offset += dataSize)
    {
        const length = Math.min(dataSize, image.length - offset);
        const frame = new Uint8Array(11 === dataSize ? FRAME_SIZE : IMAGE_PACKET_OVERHEAD + length);

        frame[0] = IMAGE_MAGIC_FIRST;
        frame[1] = IMAGE_MAGIC_SECOND;
        frame[2] = 2;
        frame[3] = IMAGE_COMMAND_DATA;
        setUint24(frame, 4, offset);
        frame[7] = length;
        frame.set(image.subarray(offset, offset + length), 8);
        frames.push(finalizeImageFrame(frame));
    }

    const commit = new Uint8Array(FRAME_SIZE);
    const commitView = new DataView(commit.buffer);

    commit[0] = IMAGE_MAGIC_FIRST;
    commit[1] = IMAGE_MAGIC_SECOND;
    commit[2] = 2;
    commit[3] = IMAGE_COMMAND_COMMIT;
    setUint24(commit, 4, image.length);
    commit[7] = imageFormat;
    commitView.setUint32(8, imageCrc, true);
    commit[12] = slot;
    frames.push(finalizeImageFrame(commit));

    return frames;
}
function parseMascotDigest(value)
{
    const bytes = value instanceof DataView
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : Uint8Array.from(value || []);
    const isLegacy = FRAME_SIZE === bytes.length && 1 === bytes[2];
    const hasFlowStatus = 32 === bytes.length && (2 === bytes[2] || 3 === bytes[2]);
    if ((!isLegacy && !hasFlowStatus) || IMAGE_MAGIC_FIRST !== bytes[0] ||
        IMAGE_MAGIC_SECOND !== bytes[1])
    {
        throw new Error("Invalid mascot digest response");
    }

    const available = 0 !== (bytes[3] & 0x01);
    const md5 = available
        ? Array.from(bytes.subarray(4, 20), (byte) => byte.toString(16).padStart(2, "0")).join("")
        : null;
    if (!hasFlowStatus)
    {
        return { available, md5 };
    }
    const statusView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = {
        available,
        md5,
        received: statusView.getUint32(20, true),
        total: statusView.getUint32(24, true),
        state: bytes[28],
        result: bytes[29]
    };
    if (3 === bytes[2])
    {
        result.slot = bytes[30];
    }
    return result;
}
function fnv1a32(value)
{
    let hash = 0x811c9dc5;
    const bytes = new TextEncoder().encode(String(value || "unknown"));

    for (const byte of bytes)
    {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }

    return hash >>> 0;
}

function providerCode(provider)
{
    const value = String(provider || "").toLowerCase();
    if (value.includes("codex"))
    {
        return 1;
    }
    if (value.includes("claude"))
    {
        return 2;
    }
    return 0;
}

function sourceCode(source)
{
    const value = String(source || "").toLowerCase();
    if (value.includes("wsl"))
    {
        return 2;
    }
    if (value.includes("windows") || value.includes("win32"))
    {
        return 1;
    }
    if (value.includes("linux"))
    {
        return 3;
    }
    return 0;
}

function ageSeconds(updatedAt, now)
{
    const timestamp = Date.parse(updatedAt || "");
    if (!Number.isFinite(timestamp))
    {
        return 0xffff;
    }
    return Math.min(0xfffe, Math.max(0, Math.floor((now - timestamp) / 1000)));
}

function encodePayload(snapshot, now = Date.now())
{
    const sessions = Array.isArray(snapshot && snapshot.sessions)
        ? snapshot.sessions.slice(0, MAX_SESSION_COUNT)
        : [];
    const payload = new Uint8Array(6 + (sessions.length * 10));
    const view = new DataView(payload.buffer);
    const activeId = snapshot && snapshot.active ? snapshot.active.id : null;

    payload[0] = STATE_CODES[snapshot && snapshot.state] ?? STATE_CODES.idle;
    payload[1] = sessions.length;
    view.setUint32(2, Math.floor(now / 1000) >>> 0, true);

    sessions.forEach((session, index) => {
        const offset = 6 + (index * 10);
        const state = Object.hasOwn(STATE_CODES, session.state) ? session.state : "idle";
        let flags = 0;

        if ("needs_input" === state || true === session.approvalPending || true === session.approval_pending)
        {
            flags |= 0x01;
        }
        if (null !== activeId && session.id === activeId)
        {
            flags |= 0x02;
        }

        payload[offset] = STATE_CODES[state];
        payload[offset + 1] = providerCode(session.provider);
        payload[offset + 2] = sourceCode(session.source);
        payload[offset + 3] = flags;
        view.setUint32(offset + 4, fnv1a32(session.id), true);
        view.setUint16(offset + 8, ageSeconds(session.updatedAt, now), true);
    });

    return payload;
}

function encodeSnapshot(snapshot, sequence, now = Date.now())
{
    const payload = encodePayload(snapshot || {}, now);
    const chunkCount = Math.ceil(payload.length / FRAME_PAYLOAD_SIZE);
    const frames = [];

    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++)
    {
        const frame = new Uint8Array(FRAME_SIZE);
        const payloadOffset = chunkIndex * FRAME_PAYLOAD_SIZE;
        const payloadLength = Math.min(FRAME_PAYLOAD_SIZE, payload.length - payloadOffset);
        const view = new DataView(frame.buffer);

        frame[0] = 0x41;
        frame[1] = 0x50;
        frame[2] = 1;
        frame[3] = MESSAGE_TYPE_SNAPSHOT;
        view.setUint16(4, Number(sequence) & 0xffff, true);
        frame[6] = chunkIndex;
        frame[7] = chunkCount;
        frame[8] = payloadLength;
        frame.set(payload.subarray(payloadOffset, payloadOffset + payloadLength), 9);
        frame[19] = crc8Atm(frame.subarray(0, 19));
        frames.push(frame);
    }

    return frames;
}

function encodeWoodenFishEvent(sequence)
{
    const frame = new Uint8Array(FRAME_SIZE);
    const view = new DataView(frame.buffer);

    frame[0] = 0x41;
    frame[1] = 0x50;
    frame[2] = 1;
    frame[3] = MESSAGE_TYPE_WOODEN_FISH;
    view.setUint16(4, Number(sequence) & 0xffff, true);
    frame[6] = 0;
    frame[7] = 1;
    frame[8] = 1;
    frame[9] = WOODEN_FISH_ACTION;
    frame[19] = crc8Atm(frame.subarray(0, 19));

    return frame;
}

function encodeAnimationEvent(sequence, action, slot)
{
    const normalizedSlot = Number(slot);
    const isTypingAction = ANIMATION_ACTION_TYPING_START === action ||
        ANIMATION_ACTION_TYPING_STOP === action;
    if ((ANIMATION_ACTION_PLAY === action &&
         (!validImageSlot(normalizedSlot) || 0 === normalizedSlot)) ||
        (ANIMATION_ACTION_RESTORE === action && 0 !== normalizedSlot) ||
        (isTypingAction && 0 !== normalizedSlot) ||
        (!isTypingAction &&
         ANIMATION_ACTION_PLAY !== action &&
         ANIMATION_ACTION_RESTORE !== action))
    {
        throw new Error("Invalid hardware animation event");
    }
    const frame = new Uint8Array(FRAME_SIZE);
    const view = new DataView(frame.buffer);

    frame[0] = 0x41;
    frame[1] = 0x50;
    frame[2] = 1;
    frame[3] = MESSAGE_TYPE_ANIMATION;
    view.setUint16(4, Number(sequence) & 0xffff, true);
    frame[6] = 0;
    frame[7] = 1;
    frame[8] = 2;
    frame[9] = action;
    frame[10] = normalizedSlot;
    frame[19] = crc8Atm(frame.subarray(0, 19));

    return frame;
}

function encodeTimeSync(sequence, now = Date.now(), timezoneOffsetMinutes = null)
{
    const timestamp = now instanceof Date ? now.getTime() : Number(now);
    const epochSeconds = Math.floor(timestamp / 1000);
    const timezoneMinutes = null === timezoneOffsetMinutes
        ? -new Date(timestamp).getTimezoneOffset()
        : Number(timezoneOffsetMinutes);
    if (!Number.isFinite(timestamp) || !Number.isInteger(epochSeconds) ||
        1577836800 > epochSeconds || 2145916800 < epochSeconds)
    {
        throw new Error("Time sync timestamp must be between 2020 and 2038");
    }
    if (!Number.isInteger(timezoneMinutes) || -840 > timezoneMinutes || 840 < timezoneMinutes)
    {
        throw new Error("Time sync timezone must be between -840 and 840 minutes");
    }

    const frame = new Uint8Array(FRAME_SIZE);
    const view = new DataView(frame.buffer);

    frame[0] = 0x41;
    frame[1] = 0x50;
    frame[2] = 1;
    frame[3] = MESSAGE_TYPE_TIME_SYNC;
    view.setUint16(4, Number(sequence) & 0xffff, true);
    frame[6] = 0;
    frame[7] = 1;
    frame[8] = 6;
    view.setUint32(9, epochSeconds, true);
    view.setInt16(13, timezoneMinutes, true);
    frame[19] = crc8Atm(frame.subarray(0, 19));

    return frame;
}
class HardwareProtocolEncoder
{
    constructor(sequence = 0)
    {
        this.sequence = Number(sequence) & 0xffff;
    }

    encode(snapshot, now = Date.now())
    {
        this.sequence = (this.sequence + 1) & 0xffff;
        return encodeSnapshot(snapshot, this.sequence, now);
    }

    encodeWoodenFishHit()
    {
        this.sequence = (this.sequence + 1) & 0xffff;
        return [encodeWoodenFishEvent(this.sequence)];
    }

    encodeTimeSync(now = Date.now(), timezoneOffsetMinutes = null)
    {
        this.sequence = (this.sequence + 1) & 0xffff;
        return [encodeTimeSync(this.sequence, now, timezoneOffsetMinutes)];
    }

    encodeAnimationPlay(slot)
    {
        this.sequence = (this.sequence + 1) & 0xffff;
        return [encodeAnimationEvent(this.sequence, ANIMATION_ACTION_PLAY, slot)];
    }

    encodeAnimationRestore()
    {
        this.sequence = (this.sequence + 1) & 0xffff;
        return [encodeAnimationEvent(this.sequence, ANIMATION_ACTION_RESTORE, 0)];
    }

    encodeTypingStart()
    {
        this.sequence = (this.sequence + 1) & 0xffff;
        return [encodeAnimationEvent(this.sequence, ANIMATION_ACTION_TYPING_START, 0)];
    }

    encodeTypingStop()
    {
        this.sequence = (this.sequence + 1) & 0xffff;
        return [encodeAnimationEvent(this.sequence, ANIMATION_ACTION_TYPING_STOP, 0)];
    }
}

const HARDWARE_PROTOCOL_API = Object.freeze({
    FRAME_SIZE,
    IMAGE_COMMAND_BEGIN,
    IMAGE_COMMAND_COMMIT,
    IMAGE_COMMAND_DATA,
    IMAGE_COMMAND_RESET,
    IMAGE_COMMAND_SELECT,
    IMAGE_SLOT_COUNT,
    IMAGE_DATA_SIZE,
    IMAGE_DATA_SIZES,
    IMAGE_PACKET_OVERHEAD,
    IMAGE_FORMAT_JPEG,
    IMAGE_FORMAT_GIF,
    IMAGE_DIGEST_UUID,
    DAILY_MERIT_UUID,
    AUDIO_STREAM_UUID,
    AUDIO_CONTROL_COMMAND_START,
    AUDIO_CONTROL_COMMAND_STOP,
    AUDIO_CONTROL_FRAME_SIZE,
    DAILY_MERIT_FRAME_SIZE,
    IMAGE_RX_UUID,
    MAX_SESSION_COUNT,
    MAX_MASCOT_IMAGE_BYTES,
    MESSAGE_TYPE_SNAPSHOT,
    MESSAGE_TYPE_TIME_SYNC,
    MESSAGE_TYPE_ANIMATION,
    MESSAGE_TYPE_WOODEN_FISH,
    WOODEN_FISH_ACTION,
    ANIMATION_ACTION_PLAY,
    ANIMATION_ACTION_RESTORE,
    ANIMATION_ACTION_TYPING_START,
    ANIMATION_ACTION_TYPING_STOP,
    SERVICE_UUID,
    STATUS_RX_UUID,
    STATE_CODES,
    HardwareProtocolEncoder,
    ageSeconds,
    crc8Atm,
    crc32Mpeg2,
    encodeAudioControl,
    encodeDailyMerit,
    encodeMascotImage,
    encodeMascotReset,
    encodeMascotSelect,
    encodeAnimationEvent,
    parseMascotDigest,
    parseDailyMerit,
    encodePayload,
    encodeSnapshot,
    encodeTimeSync,
    encodeWoodenFishEvent,
    fnv1a32,
    providerCode,
    sourceCode
});

if ("undefined" !== typeof module && module.exports)
{
    module.exports = HARDWARE_PROTOCOL_API;
}
if ("undefined" !== typeof window)
{
    window.AgentPetHardwareProtocol = HARDWARE_PROTOCOL_API;
}
