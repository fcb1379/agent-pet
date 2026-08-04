"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ActivityPulse, POWERSHELL_PROBE } = require("../src/keyboard-activity");
const { ApprovalStore } = require("../src/approval-store");
const { normalizeSettings } = require("../src/settings-store");
const { windowsPathToWsl } = require("../src/ai-setup");
const { cpuPercent } = require("../src/resource-monitor");
const { importImageFiles, validateImageFile, versionedImageFileUrl } = require("../src/custom-assets");
const { createTrayBitmap, STATUS_RGB, TRAY_ICON_SIZE } = require("../src/tray-icon");
const { extractForegroundBitmap } = require("../src/foreground-extractor");

test("keyboard activity emits only active and idle transitions", () => {
    const events = [];
    let callback = null;
    const pulse = new ActivityPulse(900, {
        setTimeout: (next) => {
            callback = next;
            return { unref() {} };
        },
        clearTimeout: () => {}
    });

    pulse.on("change", (active) => events.push(active));
    pulse.pulse();
    pulse.pulse();
    assert.deepEqual(events, [true]);
    callback();
    assert.deepEqual(events, [true, false]);
});

test("keyboard probe emits activity only and never prints virtual key values", () => {
    assert.match(POWERSHELL_PROBE, /WriteLine\("1"\)/);
    assert.doesNotMatch(POWERSHELL_PROBE, /WriteLine\([^\n]*virtualKey/);
});

test("settings accept only supported size and opacity presets", () => {
    assert.deepEqual(normalizeSettings({ scale: 1.25, opacity: 0.75, clickThrough: true }), {
        clickThrough: true,
        displayMode: "pet",
        keyboardAnimation: true,
        updateSource: "github",
        opacity: 0.75,
        scale: 1.25,
        position: null,
        animation: {
            style: "classic",
            hoverEnabled: true,
            autoExtractMascot: true,
            mascotPath: null,
            hoverFrames: [],
            hoverFrameDurations: [],
            hoverFrameMs: 110
        },
        resources: {
            enabled: true,
            cpu: true,
            gpu: true,
            memory: true,
            network: true
        },
        hardware: {
            enabled: false
        }
    });
    assert.equal(normalizeSettings({ scale: 9 }).scale, 1);
    assert.equal(normalizeSettings({ updateSource: "gitee" }).updateSource, "gitee");
    assert.equal(normalizeSettings({ updateSource: "unknown" }).updateSource, "github");
    assert.equal(normalizeSettings({ hardware: { enabled: true } }).hardware.enabled, true);
    assert.equal(normalizeSettings({ hardware: { enabled: "yes" } }).hardware.enabled, false);
});

test("approval decisions are written only for existing safe requests", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pet-approval-"));
    try
    {
        const store = new ApprovalStore(directory);
        const request = {
            id: "request-1",
            sessionId: "session-1",
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60000).toISOString()
        };
        fs.writeFileSync(path.join(directory, "request-1.request.json"), JSON.stringify(request));
        store.refresh();
        assert.equal(store.active().id, "request-1");
        assert.equal(store.decide("request-1", "allow"), true);
        assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "request-1.decision.json"), "utf8")).decision, "allow");
        assert.equal(store.dismissSession("session-1"), 1);
        assert.equal(fs.existsSync(path.join(directory, "request-1.request.json")), false);
        assert.equal(fs.existsSync(path.join(directory, "request-1.decision.json")), false);
        assert.equal(store.active(), null);
        assert.equal(store.decide("../escape", "allow"), false);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
test("one-click setup converts its packaged installer path for WSL", () => {
    assert.equal(
        windowsPathToWsl("C:\\Users\\tester\\AppData\\Local\\AgentPet\\setup-package"),
        "/mnt/c/Users/tester/AppData/Local/AgentPet/setup-package"
    );
});
test("resource CPU usage is calculated from bounded time deltas", () => {
    assert.equal(cpuPercent({ idle: 100, total: 200 }, { idle: 125, total: 300 }), 75);
    assert.equal(cpuPercent({ idle: 100, total: 200 }, { idle: 100, total: 200 }), 0);
});

test("resource visibility settings merge without resetting other metrics", () => {
    const settings = normalizeSettings({ resources: { gpu: false, network: false } });
    assert.equal(settings.resources.enabled, true);
    assert.equal(settings.resources.cpu, true);
    assert.equal(settings.resources.gpu, false);
    assert.equal(settings.resources.network, false);
});
test("desktop position accepts finite coordinates and rejects invalid values", () => {
    assert.deepEqual(normalizeSettings({ position: { x: 120.4, y: -20.6 } }).position, { x: 120, y: -21 });
    assert.equal(normalizeSettings({ position: { x: "left", y: 2 } }).position, null);
});
test("animation settings support styles, custom images and bounded frame speed", () => {
    const settings = normalizeSettings({
        animation: {
            style: "playful",
            hoverEnabled: false,
            autoExtractMascot: false,
            mascotPath: "C:\\pet.png",
            hoverFrames: ["C:\\frame-1.png", "C:\\frame-2.png"],
            hoverFrameDurations: [45, 90],
            hoverFrameMs: 70
        }
    });
    assert.equal(settings.animation.style, "playful");
    assert.equal(settings.animation.hoverEnabled, false);
    assert.equal(settings.animation.autoExtractMascot, false);
    assert.equal(settings.animation.hoverFrames.length, 2);
    assert.deepEqual(settings.animation.hoverFrameDurations, [45, 90]);
    assert.equal(settings.animation.hoverFrameMs, 70);
    assert.equal(normalizeSettings({ animation: { style: "unknown", hoverFrameMs: 1 } }).animation.style, "classic");
});

test("foreground extraction removes edge-connected flat background and crops around subject", () => {
    const width = 12;
    const height = 10;
    const bitmap = Buffer.alloc(width * height * 4);
    for (let index = 0; index < width * height; index++)
    {
        bitmap[(index * 4)] = 245;
        bitmap[(index * 4) + 1] = 245;
        bitmap[(index * 4) + 2] = 245;
        bitmap[(index * 4) + 3] = 255;
    }
    for (let y = 3; y <= 7; y++)
    {
        for (let x = 4; x <= 8; x++)
        {
            const offset = ((y * width) + x) * 4;
            bitmap[offset] = 20;
            bitmap[offset + 1] = 70;
            bitmap[offset + 2] = 160;
        }
    }

    const result = extractForegroundBitmap(bitmap, width, height, { paddingRatio: 0 });
    assert.equal(result.changed, true);
    assert.equal(result.bitmap[3], 0);
    assert.equal(result.bitmap[(((5 * width) + 6) * 4) + 3], 255);
    assert.deepEqual(result.bounds, { x: 2, y: 1, width: 9, height: 9 });
});

test("foreground extraction ignores a thin dark image border", () => {
    const width = 20;
    const height = 20;
    const bitmap = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++)
    {
        for (let x = 0; x < width; x++)
        {
            const offset = ((y * width) + x) * 4;
            const border = 0 === x || 0 === y || width - 1 === x || height - 1 === y;
            const color = border ? 8 : 240;
            bitmap[offset] = color;
            bitmap[offset + 1] = color;
            bitmap[offset + 2] = color;
            bitmap[offset + 3] = 255;
        }
    }
    for (let y = 6; y <= 16; y++)
    {
        for (let x = 7; x <= 12; x++)
        {
            const offset = ((y * width) + x) * 4;
            bitmap[offset] = 30;
            bitmap[offset + 1] = 80;
            bitmap[offset + 2] = 170;
        }
    }
    const result = extractForegroundBitmap(bitmap, width, height);
    assert.deepEqual(result.bounds, { x: 5, y: 4, width: 10, height: 15 });
});

test("foreground extraction preserves a white subject connected to the bottom edge", () => {
    const width = 20;
    const height = 20;
    const bitmap = Buffer.alloc(width * height * 4);
    for (let index = 0; index < width * height; index++)
    {
        bitmap[(index * 4)] = 240;
        bitmap[(index * 4) + 1] = 240;
        bitmap[(index * 4) + 2] = 240;
        bitmap[(index * 4) + 3] = 255;
    }
    for (let y = 5; y < height; y++)
    {
        for (const x of [6, 13])
        {
            const offset = ((y * width) + x) * 4;
            bitmap[offset] = 25;
            bitmap[offset + 1] = 25;
            bitmap[offset + 2] = 25;
        }
    }
    for (let x = 6; x <= 13; x++)
    {
        const offset = ((5 * width) + x) * 4;
        bitmap[offset] = 25;
        bitmap[offset + 1] = 25;
        bitmap[offset + 2] = 25;
    }
    for (let y = 6; y < height; y++)
    {
        for (let x = 7; x <= 12; x++)
        {
            const offset = ((y * width) + x) * 4;
            bitmap[offset] = 245;
            bitmap[offset + 1] = 245;
            bitmap[offset + 2] = 245;
        }
    }
    const result = extractForegroundBitmap(bitmap, width, height);
    assert.equal(result.bitmap[(((18 * width) + 10) * 4) + 3], 255);
    assert.equal(result.bitmap[(((2 * width) + 2) * 4) + 3], 0);
});

test("custom animation assets are copied locally in natural filename order", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pet-assets-"));
    try
    {
        const source = path.join(directory, "source");
        const target = path.join(directory, "target");
        fs.mkdirSync(source);
        const frame10 = path.join(source, "frame-10.png");
        const frame2 = path.join(source, "frame-2.png");
        fs.writeFileSync(frame10, "png-10");
        fs.writeFileSync(frame2, "png-2");
        const imported = importImageFiles([frame10, frame2], target, "hover");
        assert.equal(imported.length, 2);
        assert.equal(fs.readFileSync(imported[0], "utf8"), "png-2");
        assert.throws(() => validateImageFile(path.join(source, "frame.svg")));
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
test("custom image URL changes when a fixed asset path is overwritten", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pet-asset-url-"));
    try
    {
        const imagePath = path.join(directory, "hardware-mascot.jpg");
        fs.writeFileSync(imagePath, "first-image");
        fs.utimesSync(imagePath, new Date(1000), new Date(1000));
        const firstUrl = versionedImageFileUrl(imagePath);

        fs.writeFileSync(imagePath, "second-image");
        fs.utimesSync(imagePath, new Date(2000), new Date(2000));
        const secondUrl = versionedImageFileUrl(imagePath);

        assert.match(firstUrl, /^file:/);
        assert.notEqual(firstUrl, secondUrl);
        assert.equal(versionedImageFileUrl(path.join(directory, "missing.jpg")), null);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
test("tray bitmap has transparent corners and a visible state-colored center", () => {
    const bitmap = createTrayBitmap("running");
    const centerOffset = ((TRAY_ICON_SIZE / 2) * TRAY_ICON_SIZE + (TRAY_ICON_SIZE / 2)) * 4;
    assert.equal(bitmap.length, TRAY_ICON_SIZE * TRAY_ICON_SIZE * 4);
    assert.equal(bitmap[3], 0);
    assert.equal(bitmap[centerOffset + 3], 255);
    assert.deepEqual(
        [bitmap[centerOffset + 2], bitmap[centerOffset + 1], bitmap[centerOffset]],
        STATUS_RGB.running
    );
});
