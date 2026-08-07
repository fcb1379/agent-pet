"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    HardwareProtocolEncoder,
    crc8Atm,
    crc32Mpeg2,
    encodeDailyMerit,
    encodeMascotImage,
    encodeMascotReset,
    encodeMascotSelect,
    encodeAnimationEvent,
    parseMascotDigest,
    parseDailyMerit,
    encodeSnapshot,
    encodeTimeSync,
    encodeWoodenFishEvent,
    fnv1a32
} = require("../src/hardware-protocol");

test("CRC-8/ATM matches the standard check vector", () => {
    assert.equal(crc8Atm(Buffer.from("123456789", "ascii")), 0xf4);
});

test("CRC-32/MPEG-2 matches the standard check vector", () => {
    assert.equal(crc32Mpeg2(Buffer.from("123456789", "ascii")), 0x0376e6e7);
});

test("daily merit frame round-trips a date and count with CRC protection", () => {
    const frame = encodeDailyMerit(20260806, 128);

    assert.equal(frame.length, 16);
    assert.equal(frame[15], crc8Atm(frame.subarray(0, 15)));
    assert.deepEqual(parseDailyMerit(new DataView(frame.buffer)), {
        day: 20260806,
        count: 128
    });
    frame[8] ^= 1;
    assert.throws(() => parseDailyMerit(frame), /Invalid daily merit response/);
});

test("mascot JPEG uses negotiated-size packets with ordered offsets and per-packet CRC", () => {
    const image = Uint8Array.from({ length: 500 }, (_value, index) => (index + 1) & 0xff);
    const frames = encodeMascotImage(image);

    assert.equal(frames.length, 5);
    assert.deepEqual(frames.map((frame) => frame.length), [20, 244, 244, 39, 20]);
    assert.equal(frames[0][0], 0x41);
    assert.equal(frames[0][1], 0x49);
    assert.equal(frames[0][3], 1);
    assert.equal(frames[0][7], 1);
    assert.equal(frames[0][4] | (frames[0][5] << 8) | (frames[0][6] << 16), image.length);
    assert.equal(new DataView(frames[0].buffer).getUint32(8, true), crc32Mpeg2(image));
    assert.equal(frames[1][3], 2);
    assert.equal(frames[1][7], 235);
    assert.deepEqual(Array.from(frames[1].subarray(8, 243)), Array.from(image.subarray(0, 235)));
    assert.equal(frames[3][4] | (frames[3][5] << 8) | (frames[3][6] << 16), 470);
    assert.equal(frames[3][7], 30);
    assert.deepEqual(Array.from(frames[3].subarray(8, 38)), Array.from(image.subarray(470)));
    assert.equal(frames[4][3], 3);
    for (const frame of frames)
    {
        assert.equal(frame.at(-1), crc8Atm(frame.subarray(0, -1)));
    }
});

test("mascot GIF uses the animated image format in begin and commit frames", () => {
    const image = Uint8Array.from([
        0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
        0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x3b
    ]);
    const frames = encodeMascotImage(image);

    assert.equal(frames[0][7], 2);
    assert.equal(frames.at(-1)[7], 2);
});


test("default mascot reset is one CRC-protected frame", () => {
    const [frame] = encodeMascotReset();

    assert.equal(frame.length, 20);
    assert.equal(frame[3], 4);
    assert.equal(frame[19], crc8Atm(frame.subarray(0, 19)));
});
test("expression images address an independent persistent slot", () => {
    const image = Uint8Array.from([
        0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
        0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x3b
    ]);
    const frames = encodeMascotImage(image, 11, 3);
    const select = encodeMascotSelect(3);

    assert.equal(frames[0][2], 2);
    assert.equal(frames[0][12], 3);
    assert.equal(frames.at(-1)[12], 3);
    assert.equal(select[3], 5);
    assert.equal(select[4], 3);
    assert.equal(select[19], crc8Atm(select.subarray(0, 19)));
});
test("mascot digest response exposes the persistent device image MD5", () => {
    const response = Uint8Array.from([
        0x41, 0x49, 0x01, 0x01,
        0xd4, 0x1d, 0x8c, 0xd9, 0x8f, 0x00, 0xb2, 0x04,
        0xe9, 0x80, 0x09, 0x98, 0xec, 0xf8, 0x42, 0x7e
    ]);

    assert.deepEqual(parseMascotDigest(new DataView(response.buffer)), {
        available: true,
        md5: "d41d8cd98f00b204e9800998ecf8427e"
    });
});
test("mascot digest v2 exposes firmware-processed transfer progress", () => {
    const response = new Uint8Array(32);
    response.set([0x41, 0x49, 0x02, 0x00]);
    const view = new DataView(response.buffer);
    view.setUint32(20, 3760, true);
    view.setUint32(24, 285440, true);
    response[28] = 1;
    response[29] = 0;

    assert.deepEqual(parseMascotDigest(view), {
        available: false,
        md5: null,
        received: 3760,
        total: 285440,
        state: 1,
        result: 0
    });
});
test("mascot digest v3 identifies the selected expression slot", () => {
    const response = new Uint8Array(32);
    response.set([0x41, 0x49, 0x03, 0x00]);
    response[30] = 4;

    assert.equal(parseMascotDigest(response).slot, 4);
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
test("expression playback is encoded as a lightweight status event", () => {
    const frame = encodeAnimationEvent(0x1234, 1, 2);

    assert.equal(frame[3], 4);
    assert.equal(frame[8], 2);
    assert.equal(frame[9], 1);
    assert.equal(frame[10], 2);
    assert.equal(frame[19], crc8Atm(frame.subarray(0, 19)));
});

test("typing activity uses independent start and stop animation events", () => {
    const encoder = new HardwareProtocolEncoder(0x2200);
    const start = encoder.encodeTypingStart()[0];
    const stop = encoder.encodeTypingStop()[0];

    assert.equal(start[3], 4);
    assert.equal(start[9], 3);
    assert.equal(start[10], 0);
    assert.equal(stop[9], 4);
    assert.equal(stop[10], 0);
    assert.equal(start[19], crc8Atm(start.subarray(0, 19)));
    assert.equal(stop[19], crc8Atm(stop.subarray(0, 19)));
});

test("time sync encodes UTC epoch and signed timezone in one frame", () => {
    const frame = encodeTimeSync(0x2468, Date.parse("2026-08-04T03:02:01Z"), 480);
    const view = new DataView(frame.buffer);

    assert.equal(frame.length, 20);
    assert.equal(frame[3], 3);
    assert.equal(view.getUint16(4, true), 0x2468);
    assert.equal(frame[6], 0);
    assert.equal(frame[7], 1);
    assert.equal(frame[8], 6);
    assert.equal(view.getUint32(9, true), 1785812521);
    assert.equal(view.getInt16(13, true), 480);
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

test("encoder shares its sequence across snapshots, events, and time sync", () => {
    const encoder = new HardwareProtocolEncoder(10);

    assert.equal(new DataView(encoder.encode({ state: "idle" }, 0)[0].buffer).getUint16(4, true), 11);
    assert.equal(new DataView(encoder.encodeWoodenFishHit()[0].buffer).getUint16(4, true), 12);
    assert.equal(new DataView(encoder.encodeTimeSync(Date.parse("2026-08-04T00:00:00Z"), 0)[0].buffer).getUint16(4, true), 13);
});

test("encoder increments the sequence number for every complete snapshot", () => {
    const encoder = new HardwareProtocolEncoder(0xfffe);
    assert.equal(new DataView(encoder.encode({ state: "idle" }, 0)[0].buffer).getUint16(4, true), 0xffff);
    assert.equal(new DataView(encoder.encode({ state: "idle" }, 0)[0].buffer).getUint16(4, true), 0);
});
