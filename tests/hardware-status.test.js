"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
    hardwareStatusPresentation,
    transferPercent
} = require("../src/renderer/hardware-status");

test("hardware image transfer progress is visible and bounded", () => {
    assert.equal(transferPercent("37%"), 37);
    assert.equal(transferPercent("120%"), 100);
    assert.equal(transferPercent("unknown"), null);
    assert.deepEqual(hardwareStatusPresentation("transferring", "37%"), {
        percent: 37,
        text: "图片 37%",
        title: "图片 - 37%"
    });
});

test("hardware status clears transfer progress outside image transfer", () => {
    assert.deepEqual(hardwareStatusPresentation("synced", "AgentPet-HS52"), {
        percent: null,
        text: "已同步",
        title: "已同步 - AgentPet-HS52"
    });
    assert.equal(hardwareStatusPresentation("disconnected").text, "BLE");
});
