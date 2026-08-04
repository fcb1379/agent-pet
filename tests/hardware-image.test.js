"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const {
    findHardwareMascotSource,
    HARDWARE_MASCOT_MAX_BYTES,
    HARDWARE_MASCOT_SIZE,
    isFirmwareCompatibleMascot,
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
        assert.equal(await isFirmwareCompatibleMascot(targetPath), true);
        assert.ok(4 < stat.size && stat.size <= HARDWARE_MASCOT_MAX_BYTES);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("legacy progressive JPEG is rejected before hardware transfer", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pet-hardware-legacy-"));

    try
    {
        const hardwarePath = path.join(directory, "hardware-mascot.jpg");
        await sharp({
            create: {
                width: HARDWARE_MASCOT_SIZE,
                height: HARDWARE_MASCOT_SIZE,
                channels: 3,
                background: { r: 30, g: 60, b: 90 }
            }
        }).jpeg({ progressive: true }).toFile(hardwarePath);

        assert.equal(await isFirmwareCompatibleMascot(hardwarePath), false);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
test("hardware mascot source recovery prefers the matching extracted desktop image", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pet-hardware-source-"));

    try
    {
        const mascotDirectory = path.join(directory, "mascot");
        const sourcePath = path.join(mascotDirectory, "mascot-00-test-extracted.png");
        fs.mkdirSync(mascotDirectory, { recursive: true });
        await sharp({
            create: {
                width: 80,
                height: 100,
                channels: 4,
                background: { r: 220, g: 80, b: 40, alpha: 0.75 }
            }
        }).png().toFile(sourcePath);

        const hardwarePath = await prepareHardwareMascot(sourcePath, directory);
        const legacyImage = await sharp(fs.readFileSync(hardwarePath))
            .jpeg({ quality: 86, chromaSubsampling: "4:4:4" })
            .toBuffer();
        fs.writeFileSync(hardwarePath, legacyImage);
        assert.equal(await findHardwareMascotSource(hardwarePath), sourcePath);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
