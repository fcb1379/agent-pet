"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
    hardwareStatusPresentation,
    transferPercent,
    transferSpeed
} = require("../src/renderer/hardware-status");

test("hardware image transfer progress is visible and bounded", () => {
    assert.equal(transferPercent("37%"), 37);
    assert.equal(transferPercent("120%"), 100);
    assert.equal(transferPercent("unknown"), null);
    assert.equal(transferPercent("37% · 244 B"), 37);
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
    assert.equal(hardwareStatusPresentation("scan_required").text, "重新扫描");
});

test("hardware status displays live and completed image transfer speed", () => {
    assert.equal(transferSpeed("42% · 96.4 KB/s · fast"), "96.4 KB/s");
    assert.equal(transferSpeed("no speed"), null);
    assert.match(
        hardwareStatusPresentation("transferring", "42% · 96.4 KB/s · fast").text,
        /42%.*96\.4 KB\/s/
    );
    assert.match(
        hardwareStatusPresentation("synced", "AgentPet-HS52 · 5.2 s · 94.1 KB/s").text,
        /94\.1 KB\/s/
    );
    assert.match(
        hardwareStatusPresentation("transferring", "8% · 测速中 · fast").text,
        /8%.*测速中/
    );
});
