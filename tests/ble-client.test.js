"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { AgentPetBleClient, deviceIsUnavailable } = require("../src/renderer/ble-client");

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
