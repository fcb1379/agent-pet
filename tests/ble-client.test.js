"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { AgentPetBleClient } = require("../src/renderer/ble-client");

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
