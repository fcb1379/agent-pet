"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    AgentPetBleClient,
    deviceIsUnavailable,
    formatTransferDuration,
    formatTransferSpeed
} = require("../src/renderer/ble-client");
const {
    encodeDailyMerit,
    parseDailyMerit
} = require("../src/hardware-protocol");

test("BLE image transfer metrics use readable speed and duration units", () => {
    assert.equal(formatTransferSpeed(800), "800 B/s");
    assert.equal(formatTransferSpeed(96.4 * 1024), "96.4 KB/s");
    assert.equal(formatTransferSpeed(1.25 * 1024 * 1024), "1.3 MB/s");
    assert.equal(formatTransferDuration(5230), "5.2 s");
});

test("disabled BLE client stays silent until hardware integration is enabled", async () => {
    let scanCount = 0;
    const statuses = [];
    const client = new AgentPetBleClient({
        enabled: false,
        bluetooth: {
            requestDevice: async () => {
                scanCount++;
                return null;
            }
        },
        serviceUuid: "service",
        characteristicUuid: "status",
        imageCharacteristicUuid: "image",
        encodeImage: () => [],
        encodeReset: () => [],
        onStatus: (status) => statuses.push(status)
    });

    assert.equal(await client.connect(), false);
    client.scheduleReconnect();
    assert.equal(scanCount, 0);
    assert.equal(client.reconnectTimer, null);
    assert.deepEqual(statuses, []);
});

function connectedDevice(name = "AgentPet-HS52")
{
    const statusCharacteristic = { writeValueWithResponse: async () => {} };
    const imageCharacteristic = { writeValueWithResponse: async () => {} };
    return {
        name,
        addEventListener: () => {},
        removeEventListener: () => {},
        gatt: {
            connected: true,
            connect: async () => ({
                getPrimaryService: async () => ({
                    getCharacteristic: async (uuid) => "image" === uuid
                        ? imageCharacteristic
                        : statusCharacteristic
                })
            })
        }
    };
}

test("BLE client serializes a changed mascot and does not resend the same revision", async () => {
    const writes = [];
    const client = new AgentPetBleClient({
        serviceUuid: "service",
        characteristicUuid: "status",
        imageCharacteristicUuid: "image",
        encodeImage: (data) => [Uint8Array.from([1, data.length]), Uint8Array.from([2])],
        encodeReset: () => [Uint8Array.from([4])]
    });

    client.device = { name: "test", gatt: { connected: true } };
    client.characteristic = { writeValueWithResponse: async () => {} };
    client.imageCharacteristic = {
        writeValueWithResponse: async (frame) => writes.push(Array.from(frame))
    };

    client.setImage({ revision: "image-1", data: [10, 11, 12] });
    await client.writeQueue;
    assert.deepEqual(writes, [[1, 3], [2]]);

    client.setImage({ revision: "image-1", data: [10, 11, 12] });
    await client.writeQueue;
    assert.equal(writes.length, 2);
});

test("BLE client skips transfer after reconnect when device MD5 already matches", async () => {
    const writes = [];
    const client = new AgentPetBleClient({
        serviceUuid: "service",
        characteristicUuid: "status",
        imageCharacteristicUuid: "image",
        imageDigestCharacteristicUuid: "digest",
        encodeImage: () => [Uint8Array.from([1])],
        encodeReset: () => [Uint8Array.from([4])],
        parseImageDigest: () => ({
            available: true,
            md5: "d41d8cd98f00b204e9800998ecf8427e"
        })
    });

    client.device = { name: "test", gatt: { connected: true } };
    client.characteristic = { writeValueWithResponse: async () => {} };
    client.imageCharacteristic = { writeValueWithResponse: async (frame) => writes.push(frame) };
    client.imageDigestCharacteristic = { readValue: async () => new DataView(new ArrayBuffer(20)) };
    client.latestImage = {
        revision: "after-reboot",
        md5: "d41d8cd98f00b204e9800998ecf8427e",
        data: Uint8Array.from([1, 2, 3])
    };

    await client.flushImage();

    assert.equal(writes.length, 0);
    assert.equal(client.syncedImageRevision, "after-reboot");
});

test("BLE client sends time before the latest snapshot after every GATT connection", async () => {
    const writes = [];
    const statusCharacteristic = {
        writeValueWithResponse: async (frame) => writes.push(Array.from(frame))
    };
    const imageCharacteristic = { writeValueWithResponse: async () => {} };
    const client = new AgentPetBleClient({
        serviceUuid: "service",
        characteristicUuid: "status",
        imageCharacteristicUuid: "image",
        encodeImage: () => [],
        encodeReset: () => [Uint8Array.from([4])],
        encodeTimeSync: () => [Uint8Array.from([3])]
    });
    client.setDevice({
        name: "AgentPet-HS52",
        addEventListener: () => {},
        removeEventListener: () => {},
        gatt: {
            connected: true,
            connect: async () => ({
                getPrimaryService: async () => ({
                    getCharacteristic: async (uuid) => "image" === uuid
                        ? imageCharacteristic
                        : statusCharacteristic
                })
            })
        }
    });
    client.setSnapshot([Uint8Array.from([1])]);

    await client.connectGatt();
    await client.connectGatt();

    assert.deepEqual(writes, [[3], [1], [3], [1]]);
});
test("BLE client sends a reset frame for the default mascot", async () => {
    const writes = [];
    const client = new AgentPetBleClient({
        serviceUuid: "service",
        characteristicUuid: "status",
        imageCharacteristicUuid: "image",
        encodeImage: () => [],
        encodeReset: () => [Uint8Array.from([4])]
    });

    client.device = { name: "test", gatt: { connected: true } };
    client.characteristic = { writeValueWithResponse: async () => {} };
    client.imageCharacteristic = {
        writeValueWithResponse: async (frame) => writes.push(Array.from(frame))
    };

    await client.flushImage();
    assert.deepEqual(writes, [[4]]);
});

test("BLE client falls back to the legacy 20-byte packet when a larger MTU is rejected", async () => {
    const attemptedDataSizes = [];
    const packetLengths = [];
    const statuses = [];
    const client = new AgentPetBleClient({
        serviceUuid: "service",
        characteristicUuid: "status",
        imageCharacteristicUuid: "image",
        imageDataSizes: [235, 11],
        imagePacketDelayMs: 0,
        imageRetryDelayMs: 0,
        encodeImage: (_data, dataSize) => {
            attemptedDataSizes.push(dataSize);
            return [new Uint8Array(20), new Uint8Array(dataSize + 9), new Uint8Array(20)];
        },
        encodeReset: () => [new Uint8Array(20)],
        onStatus: (status, detail) => statuses.push([status, detail])
    });

    client.device = { name: "test", gatt: { connected: true } };
    client.characteristic = { writeValueWithResponse: async () => {} };
    client.imageCharacteristic = {
        writeValueWithResponse: async (packet) => {
            packetLengths.push(packet.length);
            if (20 < packet.length)
            {
                throw new Error("GATT operation exceeds MTU");
            }
        }
    };
    client.latestImage = { revision: "fallback", data: Uint8Array.from([1, 2, 3]) };

    await client.flushImage();

    assert.deepEqual(attemptedDataSizes, [235, 11]);
    assert.deepEqual(packetLengths, [20, 244, 20, 20, 20]);
    assert.ok(statuses.some(([status, detail]) => "transferring" === status && detail.includes("fallback 20 B")));
    assert.equal(client.syncedImageRevision, "fallback");
});

test("BLE image transfer yields between packets so the firmware worker queue can drain", async () => {
    const writes = [];
    const waits = [];
    let queuedPackets = 0;
    const client = new AgentPetBleClient({
        serviceUuid: "service",
        characteristicUuid: "status",
        imageCharacteristicUuid: "image",
        imageDataSizes: [235],
        imagePacketDelayMs: 10,
        encodeImage: () => Array.from({ length: 12 }, (_value, index) =>
            Uint8Array.from([index])),
        encodeReset: () => [new Uint8Array(20)],
        wait: async (milliseconds) => {
            waits.push(milliseconds);
            queuedPackets = Math.max(0, queuedPackets - 1);
        }
    });

    client.device = { name: "test", gatt: { connected: true } };
    client.characteristic = { writeValueWithResponse: async () => {} };
    client.imageCharacteristic = {
        writeValueWithResponse: async (packet) => {
            queuedPackets++;
            if (8 < queuedPackets)
            {
                throw new Error("Firmware image queue full");
            }
            writes.push(Array.from(packet));
        }
    };
    client.latestImage = { revision: "paced", data: Uint8Array.from([1, 2, 3]) };

    await client.flushImage();

    assert.equal(writes.length, 12);
    assert.equal(waits.length, 11);
    assert.ok(waits.every((milliseconds) => 10 === milliseconds));
    assert.equal(client.syncedImageRevision, "paced");
});

test("BLE image fast path bursts data commands and verifies the committed digest", async () => {
    const responseWrites = [];
    const commandWrites = [];
    const waits = [];
    const statuses = [];
    let digestReads = 0;
    const expectedMd5 = "d41d8cd98f00b204e9800998ecf8427e";
    const client = new AgentPetBleClient({
        serviceUuid: "service",
        characteristicUuid: "status",
        imageCharacteristicUuid: "image",
        imageDigestCharacteristicUuid: "digest",
        imageDataSizes: [235],
        imageFastBurstPackets: 4,
        imageFlowAckAttempts: 2,
        imageFlowAckDelayMs: 3,
        now: () => 0,
        encodeImage: () => Array.from({ length: 15 }, (_value, index) =>
            Uint8Array.from([index])),
        encodeReset: () => [new Uint8Array(20)],
        parseImageDigest: () => ({
            available: 11 <= digestReads,
            md5: 11 <= digestReads ? expectedMd5 : null,
            received: 1 < digestReads ? 3 : 0
        }),
        wait: async (milliseconds) => waits.push(milliseconds),
        onStatus: (status, detail) => statuses.push([status, detail])
    });

    client.device = { name: "test", gatt: { connected: true } };
    client.characteristic = { writeValueWithResponse: async () => {} };
    client.imageCharacteristic = {
        writeValueWithResponse: async (frame) => responseWrites.push(frame[0]),
        writeValueWithoutResponse: async (frame) => commandWrites.push(frame[0])
    };
    client.imageDigestCharacteristic = {
        readValue: async () => {
            digestReads++;
            return new DataView(new ArrayBuffer(20));
        }
    };
    client.latestImage = {
        revision: "fast",
        md5: expectedMd5,
        data: Uint8Array.from([1, 2, 3])
    };

    await client.flushImage();

    assert.deepEqual(responseWrites, [0, 14]);
    assert.deepEqual(commandWrites, Array.from({ length: 13 }, (_value, index) => index + 1));
    assert.equal(waits.filter((milliseconds) => 3 === milliseconds).length, 4);
    assert.ok(waits.includes(400));
    assert.equal(digestReads, 11);
    assert.equal(waits.filter((milliseconds) => 400 === milliseconds).length, 6);
    assert.ok(statuses.some(([status, detail]) =>
        "transferring" === status && detail.includes("测速中")));
    assert.ok(statuses
        .filter(([status]) => "transferring" === status)
        .every(([_status, detail]) => !detail.startsWith("100%")));
    assert.equal(client.syncedImageRevision, "fast");
});

test("BLE client merges daily merit by keeping the larger same-day count", async () => {
    const updates = [];
    const writes = [];
    const client = new AgentPetBleClient({
        serviceUuid: "service",
        characteristicUuid: "status",
        imageCharacteristicUuid: "image",
        meritCharacteristicUuid: "merit",
        encodeImage: () => [],
        encodeReset: () => [],
        encodeDailyMerit,
        parseDailyMerit,
        getDailyMerit: () => ({ day: 20260806, count: 12 }),
        onDailyMerit: (value) => updates.push(value)
    });

    client.device = { name: "test", gatt: { connected: true } };
    client.characteristic = { writeValueWithResponse: async () => {} };
    client.imageCharacteristic = { writeValueWithResponse: async () => {} };
    client.meritCharacteristic = {
        readValue: async () => new DataView(encodeDailyMerit(20260806, 27).buffer),
        writeValueWithResponse: async (frame) => writes.push(parseDailyMerit(frame))
    };

    await client.flushMerit();
    assert.deepEqual(updates, [{ day: 20260806, count: 27 }]);
    assert.deepEqual(writes, []);

    client.getDailyMerit = () => ({ day: 20260806, count: 31 });
    await client.flushMerit();
    assert.deepEqual(writes, [{ day: 20260806, count: 31 }]);
});

test("BLE merit notification immediately applies a larger device-side count", async () => {
    const updates = [];
    let listener = null;
    let notificationStarts = 0;
    const client = new AgentPetBleClient({
        serviceUuid: "service",
        characteristicUuid: "status",
        imageCharacteristicUuid: "image",
        meritCharacteristicUuid: "merit",
        encodeImage: () => [],
        encodeReset: () => [],
        encodeDailyMerit,
        parseDailyMerit,
        getDailyMerit: () => ({ day: 20260806, count: 31 }),
        onDailyMerit: (value) => updates.push(value)
    });

    client.device = { name: "test", gatt: { connected: true } };
    client.characteristic = { writeValueWithResponse: async () => {} };
    client.imageCharacteristic = { writeValueWithResponse: async () => {} };
    client.meritCharacteristic = {
        startNotifications: async () => { notificationStarts++; },
        addEventListener: (_name, callback) => { listener = callback; },
        removeEventListener: () => {},
        writeValueWithResponse: async () => {}
    };

    await client.enableMeritNotifications();
    listener({ target: { value: new DataView(encodeDailyMerit(20260806, 32).buffer) } });
    await client.writeQueue;

    assert.equal(notificationStarts, 1);
    assert.deepEqual(updates, [{ day: 20260806, count: 32 }]);
});

test("BLE image transfer rejects a stalled progress read instead of hanging", async () => {
    const client = new AgentPetBleClient({
        serviceUuid: "service",
        characteristicUuid: "status",
        imageCharacteristicUuid: "image",
        imageDigestCharacteristicUuid: "digest",
        imageGattOperationTimeoutMs: 5,
        encodeImage: () => [new Uint8Array(20)],
        encodeReset: () => [new Uint8Array(20)],
        parseImageDigest: () => ({ available: false, received: 0 })
    });

    client.device = { name: "test", gatt: { connected: true } };
    client.characteristic = { writeValueWithResponse: async () => {} };
    client.imageCharacteristic = { writeValueWithResponse: async () => {} };
    client.imageDigestCharacteristic = { readValue: () => new Promise(() => {}) };
    client.latestImage = {
        revision: "stalled",
        md5: "d41d8cd98f00b204e9800998ecf8427e",
        data: Uint8Array.from([1, 2, 3])
    };

    await assert.rejects(
        client.flushImage(),
        (error) => "GattOperationTimeoutError" === error.name
    );
    assert.equal(client.syncedImageRevision, null);
});

test("BLE client releases a stale device so the next click performs a fresh scan", async () => {
    const statuses = [];
    const freshDevice = connectedDevice();
    let scanCount = 0;
    const client = new AgentPetBleClient({
        bluetooth: {
            requestDevice: async () => {
                scanCount++;
                return freshDevice;
            }
        },
        serviceUuid: "service",
        characteristicUuid: "status",
        imageCharacteristicUuid: "image",
        encodeImage: () => [],
        encodeReset: () => [new Uint8Array(20)],
        onStatus: (status, detail) => statuses.push([status, detail])
    });
    client.device = {
        name: "AgentPet-HS52",
        addEventListener: () => {},
        removeEventListener: () => {},
        gatt: {
            connected: false,
            connect: async () => { throw new Error("Bluetooth Device is no longer in range."); }
        }
    };

    assert.equal(await client.connect(), false);
    assert.equal(client.device, null);
    assert.ok(statuses.some(([status]) => "scan_required" === status));

    assert.equal(await client.connect(), true);
    assert.equal(scanCount, 1);
    assert.equal(client.device, freshDevice);
    assert.equal(client.isConnected(), true);
});

test("automatic reconnect gives up a stale handle and requests a rescan", async () => {
    const statuses = [];
    const client = new AgentPetBleClient({
        serviceUuid: "service",
        characteristicUuid: "status",
        imageCharacteristicUuid: "image",
        encodeImage: () => [],
        encodeReset: () => [new Uint8Array(20)],
        maxReconnectAttempts: 1,
        onStatus: (status, detail) => statuses.push([status, detail])
    });
    client.device = {
        name: "AgentPet-HS52",
        addEventListener: () => {},
        removeEventListener: () => {},
        gatt: {
            connected: false,
            connect: async () => { throw new Error("Bluetooth Device is no longer in range."); }
        }
    };

    assert.equal(await client.attemptReconnect(), false);
    assert.equal(client.device, null);
    assert.ok(statuses.some(([status, detail]) =>
        "scan_required" === status && detail.includes("点击重新扫描")));
    assert.equal(deviceIsUnavailable(new Error("Bluetooth Device is no longer in range.")), true);
});
