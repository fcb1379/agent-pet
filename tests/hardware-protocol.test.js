"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    HardwareProtocolEncoder,
    crc8Atm,
    encodeSnapshot,
    encodeWoodenFishEvent,
    fnv1a32
} = require("../src/hardware-protocol");

test("CRC-8/ATM matches the standard check vector", () => {
    assert.equal(crc8Atm(Buffer.from("123456789", "ascii")), 0xf4);
});

test("idle snapshot matches the firmware golden frame", () => {
    const [frame] = encodeSnapshot({ state: "idle", sessions: [] }, 0x1234, 0);
    assert.equal(Buffer.from(frame).toString("hex"), "4150010134120001060000000000000000000018");
});

test("wooden fish click is encoded as a single deduplicated event frame", () => {
    const frame = encodeWoodenFishEvent(0x4321);

    assert.equal(frame.length, 20);
    assert.equal(frame[0], 0x41);
    assert.equal(frame[1], 0x50);
    assert.equal(frame[2], 1);
    assert.equal(frame[3], 2);
    assert.equal(new DataView(frame.buffer).getUint16(4, true), 0x4321);
    assert.equal(frame[6], 0);
    assert.equal(frame[7], 1);
    assert.equal(frame[8], 1);
    assert.equal(frame[9], 1);
    assert.equal(frame[19], crc8Atm(frame.subarray(0, 19)));
});

test("snapshot maps agent and pet state into bounded GATT frames", () => {
    const now = Date.parse("2026-08-03T12:00:10Z");
    const snapshot = {
        state: "needs_input",
        active: { id: "codex-1" },
        sessions: [{ id: "codex-1", provider: "Codex", source: "wsl", state: "needs_input", updatedAt: "2026-08-03T12:00:05Z" }]
    };
    const frames = encodeSnapshot(snapshot, 7, now);

    assert.equal(frames.length, 2);
    assert.equal(frames[0].length, 20);
    assert.equal(frames[0][9], 2);
    assert.equal(frames[0][15], 2);
    assert.equal(frames[0][16], 1);
    assert.equal(frames[0][17], 2);
    assert.equal(frames[0][18], 3);
    assert.equal(new DataView(frames[1].buffer).getUint32(9, true), fnv1a32("codex-1"));
    assert.equal(new DataView(frames[1].buffer).getUint16(13, true), 5);
    assert.equal(frames[0][19], crc8Atm(frames[0].subarray(0, 19)));
    assert.equal(frames[1][19], crc8Atm(frames[1].subarray(0, 19)));
});

test("encoder shares its sequence across snapshots and wooden fish events", () => {
    const encoder = new HardwareProtocolEncoder(10);

    assert.equal(new DataView(encoder.encode({ state: "idle" }, 0)[0].buffer).getUint16(4, true), 11);
    assert.equal(new DataView(encoder.encodeWoodenFishHit()[0].buffer).getUint16(4, true), 12);
});

test("encoder increments the sequence number for every complete snapshot", () => {
    const encoder = new HardwareProtocolEncoder(0xfffe);
    assert.equal(new DataView(encoder.encode({ state: "idle" }, 0)[0].buffer).getUint16(4, true), 0xffff);
    assert.equal(new DataView(encoder.encode({ state: "idle" }, 0)[0].buffer).getUint16(4, true), 0);
});
