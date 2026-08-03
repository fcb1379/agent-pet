"use strict";

const FRAME_SIZE = 20;
const FRAME_PAYLOAD_SIZE = 10;
const MAX_SESSION_COUNT = 12;
const MAX_MASCOT_IMAGE_BYTES = 128 * 1024;
const SERVICE_UUID = "7a1e0001-6b5f-4f5c-8c9d-3e2f1a0b1000";
const STATUS_RX_UUID = "7a1e0002-6b5f-4f5c-8c9d-3e2f1a0b1000";
const IMAGE_RX_UUID = "7a1e0003-6b5f-4f5c-8c9d-3e2f1a0b1000";
const MESSAGE_TYPE_SNAPSHOT = 1;
const MESSAGE_TYPE_WOODEN_FISH = 2;
const WOODEN_FISH_ACTION = 1;
const IMAGE_MAGIC_FIRST = 0x41;
const IMAGE_MAGIC_SECOND = 0x49;
const IMAGE_COMMAND_BEGIN = 1;
const IMAGE_COMMAND_DATA = 2;
const IMAGE_COMMAND_COMMIT = 3;
const IMAGE_COMMAND_RESET = 4;
const IMAGE_FORMAT_JPEG = 1;
const IMAGE_DATA_SIZE = 11;

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

function setUint24(view, offset, value)
{
    view[offset] = value & 0xff;
    view[offset + 1] = (value >>> 8) & 0xff;
    view[offset + 2] = (value >>> 16) & 0xff;
}

function finalizeImageFrame(frame)
{
    frame[19] = crc8Atm(frame.subarray(0, 19));
    return frame;
}

function encodeMascotReset()
{
    const frame = new Uint8Array(FRAME_SIZE);

    frame[0] = IMAGE_MAGIC_FIRST;
    frame[1] = IMAGE_MAGIC_SECOND;
    frame[2] = 1;
    frame[3] = IMAGE_COMMAND_RESET;
    return [finalizeImageFrame(frame)];
}

function encodeMascotImage(imageBytes)
{
    const image = imageBytes instanceof Uint8Array
        ? imageBytes
        : Uint8Array.from(imageBytes || []);
    if (4 > image.length || MAX_MASCOT_IMAGE_BYTES < image.length)
    {
        throw new Error(`硬件桌宠图片必须介于 4 字节和 ${MAX_MASCOT_IMAGE_BYTES} 字节之间`);
    }

    const imageCrc = crc32Mpeg2(image);
    const frames = [];
    const begin = new Uint8Array(FRAME_SIZE);
    const beginView = new DataView(begin.buffer);

    begin[0] = IMAGE_MAGIC_FIRST;
    begin[1] = IMAGE_MAGIC_SECOND;
    begin[2] = 1;
    begin[3] = IMAGE_COMMAND_BEGIN;
    setUint24(begin, 4, image.length);
    begin[7] = IMAGE_FORMAT_JPEG;
    beginView.setUint32(8, imageCrc, true);
    frames.push(finalizeImageFrame(begin));

    for (let offset = 0; offset < image.length; offset += IMAGE_DATA_SIZE)
    {
        const frame = new Uint8Array(FRAME_SIZE);
        const length = Math.min(IMAGE_DATA_SIZE, image.length - offset);

        frame[0] = IMAGE_MAGIC_FIRST;
        frame[1] = IMAGE_MAGIC_SECOND;
        frame[2] = 1;
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
    commit[2] = 1;
    commit[3] = IMAGE_COMMAND_COMMIT;
    setUint24(commit, 4, image.length);
    commit[7] = IMAGE_FORMAT_JPEG;
    commitView.setUint32(8, imageCrc, true);
    frames.push(finalizeImageFrame(commit));

    return frames;
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
}

const HARDWARE_PROTOCOL_API = Object.freeze({
    FRAME_SIZE,
    IMAGE_COMMAND_BEGIN,
    IMAGE_COMMAND_COMMIT,
    IMAGE_COMMAND_DATA,
    IMAGE_COMMAND_RESET,
    IMAGE_DATA_SIZE,
    IMAGE_FORMAT_JPEG,
    IMAGE_RX_UUID,
    MAX_SESSION_COUNT,
    MAX_MASCOT_IMAGE_BYTES,
    MESSAGE_TYPE_SNAPSHOT,
    MESSAGE_TYPE_WOODEN_FISH,
    WOODEN_FISH_ACTION,
    SERVICE_UUID,
    STATUS_RX_UUID,
    STATE_CODES,
    HardwareProtocolEncoder,
    ageSeconds,
    crc8Atm,
    crc32Mpeg2,
    encodeMascotImage,
    encodeMascotReset,
    encodePayload,
    encodeSnapshot,
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
