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

test("BLE client retains typing state while disconnected and flushes it on reconnect", async () => {
    const writes = [];
    const client = new AgentPetBleClient({
        serviceUuid: "service",
        characteristicUuid: "status",
        imageCharacteristicUuid: "image",
        encodeImage: () => [],
        encodeReset: () => []
    });

    assert.equal(
        await client.setTypingAnimation([Uint8Array.from([4, 3, 0])]),
        false
    );
    client.device = { name: "test", gatt: { connected: true } };
    client.characteristic = {
        writeValueWithResponse: async (frame) => writes.push(Array.from(frame))
    };
    client.imageCharacteristic = { writeValueWithResponse: async () => {} };

    await client.flushTypingAnimation();
    assert.deepEqual(writes, [[4, 3, 0]]);

    await client.setTypingAnimation([Uint8Array.from([4, 4, 0])]);
    assert.deepEqual(writes, [[4, 3, 0], [4, 4, 0]]);
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

test("BLE restores an already authorized AgentPet device without scanning", async () => {
    const device = connectedDevice();
    let authorizedDeviceReads = 0;
    let scanCount = 0;
    const client = new AgentPetBleClient({
        bluetooth: {
            getDevices: async () => {
                authorizedDeviceReads++;
                return [device];
            },
            requestDevice: async () => {
                scanCount++;
                return device;
            }
        },
        serviceUuid: "service",
        characteristicUuid: "status",
        imageCharacteristicUuid: "image",
        encodeImage: () => [],
        encodeReset: () => [new Uint8Array(1)]
    });

    assert.equal(await client.restoreAuthorizedDevice(), true);
    assert.equal(authorizedDeviceReads, 1);
    assert.equal(scanCount, 0);
    assert.equal(client.device, device);
});

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
    assert.equal(waits.filter((milliseconds) => 3 === milliseconds).length, 5);
    assert.ok(waits.includes(400));
    assert.equal(digestReads, 11);
    assert.equal(waits.filter((milliseconds) => 400 === milliseconds).length, 5);
    assert.ok(statuses.some(([status, detail]) =>
        "transferring" === status && detail.includes("测速中")));
    assert.ok(statuses
        .filter(([status]) => "transferring" === status)
        .every(([_status, detail]) => !detail.startsWith("100%")));
    assert.equal(client.syncedImageRevision, "fast");
});


test("BLE image response-write path tolerates a slow committed MD5", async () => {
    const writes = [];
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
        imageFlowAckDelayMs: 1,
        imagePacketDelayMs: 0,
        encodeImage: () => [
            Uint8Array.from([1]),
            Uint8Array.from([2]),
            Uint8Array.from([3])
        ],
        encodeReset: () => [new Uint8Array(20)],
        parseImageDigest: () => ({
            available: 40 <= digestReads,
            md5: 40 <= digestReads ? expectedMd5 : null,
            received: 0,
            total: 2 <= digestReads ? 3 : 0,
            state: 2 <= digestReads ? 1 : 0,
            result: 0
        }),
        wait: async (milliseconds) => waits.push(milliseconds),
        onStatus: (status, detail) => statuses.push([status, detail])
    });

    client.device = { name: "test", gatt: { connected: true } };
    client.characteristic = { writeValueWithResponse: async () => {} };
    client.imageCharacteristic = {
        writeValueWithResponse: async (frame) => writes.push(frame[0])
    };
    client.imageDigestCharacteristic = {
        readValue: async () => {
            digestReads++;
            return new DataView(new ArrayBuffer(32));
        }
    };
    client.latestImage = {
        revision: "response-md5",
        md5: expectedMd5,
        data: Uint8Array.from([1, 2, 3])
    };

    await client.flushImage();
    assert.deepEqual(writes, [1, 2, 3]);
    assert.equal(digestReads, 40);
    assert.equal(waits.filter((milliseconds) => 400 === milliseconds).length, 38);
    assert.equal(client.syncedImageRevision, "response-md5");
    assert.equal(statuses.at(-1)[0], "synced");
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
test("BLE audio notifications use an independent callback queue", async () => {
    const frames = [];
    let listener = null;
    let starts = 0;
    let removes = 0;
    let disconnects = 0;
    const client = new AgentPetBleClient({
        serviceUuid: "service",
        characteristicUuid: "status",
        imageCharacteristicUuid: "image",
        audioCharacteristicUuid: "audio",
        encodeImage: () => [],
        encodeReset: () => [],
        onAudioFrame: async (frame) => frames.push(Array.from(frame)),
        onAudioDisconnect: async () => { disconnects++; }
    });

    client.audioCharacteristic = {
        startNotifications: async () => { starts++; },
        addEventListener: (_name, callback) => { listener = callback; },
        removeEventListener: () => { removes++; }
    };
    await client.enableAudioNotifications();
    assert.equal(starts, 1);
    assert.equal(typeof listener, "function");

    const value = new DataView(Uint8Array.from([0x41, 0x4f, 1]).buffer);
    listener({ target: { value } });
    await client.audioQueue;
    assert.deepEqual(frames, [[0x41, 0x4f, 1]]);

    client.disconnect(true);
    await client.audioQueue;
    assert.equal(removes, 1);
    assert.equal(disconnects, 1);
});

test("BLE subscribes to audio before waiting for normal synchronization", async () => {
    const events = [];
    const audioCharacteristic = {
        startNotifications: async () => events.push("audio-start"),
        addEventListener: () => events.push("audio-listener"),
        removeEventListener: () => {}
    };
    const statusCharacteristic = {
        writeValueWithResponse: async () => events.push("status-write")
    };
    const imageCharacteristic = { writeValueWithResponse: async () => {} };
    const client = new AgentPetBleClient({
        serviceUuid: "service",
        characteristicUuid: "status",
        imageCharacteristicUuid: "image",
        audioCharacteristicUuid: "audio",
        encodeImage: () => [],
        encodeReset: () => [new Uint8Array(1)],
        encodeTimeSync: () => [Uint8Array.from([1])]
    });
    client.setDevice({
        name: "AgentPet-HS52",
        addEventListener: () => {},
        removeEventListener: () => {},
        gatt: {
            connected: true,
            connect: async () => ({
                getPrimaryService: async () => ({
                    getCharacteristic: async (uuid) => ({
                        status: statusCharacteristic,
                        image: imageCharacteristic,
                        audio: audioCharacteristic
                    })[uuid]
                })
            })
        }
    });

    await client.connectGatt();

    assert.deepEqual(events.slice(0, 2), ["audio-start", "audio-listener"]);
    assert.ok(events.indexOf("audio-start") < events.indexOf("status-write"));
});

test("BLE retries audio subscription and reports a visible audio error", async () => {
    const statuses = [];
    const waits = [];
    let audioDiscoveries = 0;
    const statusCharacteristic = { writeValueWithResponse: async () => {} };
    const imageCharacteristic = { writeValueWithResponse: async () => {} };
    const client = new AgentPetBleClient({
        serviceUuid: "service",
        characteristicUuid: "status",
        imageCharacteristicUuid: "image",
        audioCharacteristicUuid: "audio",
        audioNotificationRetryAttempts: 3,
        audioNotificationRetryDelayMs: 7,
        wait: async (milliseconds) => waits.push(milliseconds),
        encodeImage: () => [],
        encodeReset: () => [new Uint8Array(1)],
        onStatus: (status, detail) => statuses.push([status, detail])
    });
    client.setDevice({
        name: "AgentPet-HS52",
        addEventListener: () => {},
        removeEventListener: () => {},
        gatt: {
            connected: true,
            connect: async () => ({
                getPrimaryService: async () => ({
                    getCharacteristic: async (uuid) => {
                        if ("audio" === uuid)
                        {
                            audioDiscoveries++;
                            throw new Error("characteristic unavailable");
                        }
                        return "image" === uuid ? imageCharacteristic : statusCharacteristic;
                    }
                })
            })
        }
    });

    assert.equal(await client.connectGatt(), true);
    assert.equal(audioDiscoveries, 3);
    assert.deepEqual(waits, [7, 7]);
    assert.ok(statuses.some(([status, detail]) =>
        "audio_error" === status && detail.includes("characteristic unavailable")));
});

test("BLE image flow control stops polling immediately after a device state rejection", async () => {
    const waits = [];
    let digestReads = 0;
    const client = new AgentPetBleClient({
        serviceUuid: "service",
        characteristicUuid: "status",
        imageCharacteristicUuid: "image",
        imageDigestCharacteristicUuid: "digest",
        imageDataSizes: [235],
        imageFastBurstPackets: 1,
        imageFlowAckAttempts: 100,
        imageFlowAckDelayMs: 7,
        encodeImage: () => [
            Uint8Array.from([1]),
            Uint8Array.from([2]),
            Uint8Array.from([3])
        ],
        encodeReset: () => [new Uint8Array(20)],
        parseImageDigest: () => ({
            available: false,
            received: 0,
            result: 2 <= digestReads ? 103 : 0
        }),
        wait: async (milliseconds) => waits.push(milliseconds)
    });

    client.device = { name: "test", gatt: { connected: true } };
    client.characteristic = { writeValueWithResponse: async () => {} };
    client.imageCharacteristic = {
        writeValueWithResponse: async () => {},
        writeValueWithoutResponse: async () => {}
    };
    client.imageDigestCharacteristic = {
        readValue: async () => {
            digestReads++;
            return new DataView(new ArrayBuffer(32));
        }
    };
    client.latestImage = {
        revision: "state-rejected",
        md5: "d41d8cd98f00b204e9800998ecf8427e",
        data: Uint8Array.from([1, 2, 3])
    };

    await assert.rejects(client.flushImage(), /result 103/);

    assert.equal(digestReads, 2);
    assert.deepEqual(waits, [7]);
    assert.equal(client.syncedImageRevision, null);
});

test("BLE client defers mascot transfer while hardware audio is active and resumes once", async () => {
    const writes = [];
    const client = new AgentPetBleClient({
        serviceUuid: "service",
        characteristicUuid: "status",
        imageCharacteristicUuid: "image",
        imageDataSizes: [235],
        imagePacketDelayMs: 0,
        encodeImage: () => [Uint8Array.from([1]), Uint8Array.from([2])],
        encodeReset: () => [new Uint8Array(20)]
    });

    client.device = { name: "test", gatt: { connected: true } };
    client.characteristic = { writeValueWithResponse: async () => {} };
    client.imageCharacteristic = {
        writeValueWithResponse: async (frame) => writes.push(Array.from(frame))
    };
    client.latestImage = {
        revision: "after-audio",
        data: Uint8Array.from([1, 2, 3])
    };
    client.latestImages.set(0, client.latestImage);

    client.setAudioStreamActive(true);
    await client.flushImage();
    assert.deepEqual(writes, []);
    assert.equal(client.imageSyncPending, true);

    client.setAudioStreamActive(false);
    await client.writeQueue;

    assert.deepEqual(writes, [[1], [2]]);
    assert.equal(client.imageSyncPending, false);
    assert.equal(client.syncedImageRevision, "after-audio");
});

test("BLE audio control is written with response after pending GATT work", async () => {
    const events = [];
    let releasePending;
    const pending = new Promise((resolve) => {
        releasePending = resolve;
    });
    const client = new AgentPetBleClient({
        serviceUuid: "service",
        characteristicUuid: "status",
        imageCharacteristicUuid: "image",
        audioCharacteristicUuid: "audio",
        encodeAudioControl: (active) => Uint8Array.from([active ? 1 : 2])
    });

    client.device = { name: "test", gatt: { connected: true } };
    client.characteristic = { writeValueWithResponse: async () => {} };
    client.imageCharacteristic = { writeValueWithResponse: async () => {} };
    client.audioCharacteristic = {
        writeValueWithResponse: async (frame) => events.push(Array.from(frame))
    };
    client.writeQueue = pending;

    const request = client.requestAudioStream(true);
    await Promise.resolve();
    assert.deepEqual(events, []);
    assert.equal(client.audioStreamActive, true);

    releasePending();
    await request;
    assert.deepEqual(events, [[1]]);

    await client.requestAudioStream(false);
    assert.deepEqual(events, [[1], [2]]);
});
