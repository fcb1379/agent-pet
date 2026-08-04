"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const {
    HARDWARE_MASCOT_MAX_BYTES,
    HARDWARE_MASCOT_SIZE,
    prepareHardwareMascot
} = require("../src/hardware-image");

test("hardware mascot is persisted as a bounded 336px JPEG", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pet-hardware-image-"));

    try
    {
        const sourcePath = path.join(directory, "source.png");
        await sharp({
            create: {
                width: 120,
                height: 80,
                channels: 4,
                background: { r: 25, g: 180, b: 210, alpha: 0.8 }
            }
        }).png().toFile(sourcePath);

        const targetPath = await prepareHardwareMascot(sourcePath, directory);
        const image = fs.readFileSync(targetPath);
        const metadata = await sharp(targetPath).metadata();
        const stat = fs.statSync(targetPath);

        assert.equal(path.basename(targetPath), "hardware-mascot.jpg");
        assert.equal(metadata.format, "jpeg");
        assert.equal(metadata.width, HARDWARE_MASCOT_SIZE);
        assert.equal(metadata.height, HARDWARE_MASCOT_SIZE);
        assert.equal(metadata.isProgressive, false);
        assert.equal(image.subarray(0, 10).toString("hex"), "ffd8ffe000104a464946");
        assert.ok(4 < stat.size && stat.size <= HARDWARE_MASCOT_MAX_BYTES);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
