"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const {
    findHardwareMascotSource,
    firmwareJpegInfo,
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

test("animated GIF hardware mascot uses frame zero and safe baseline 4:2:0 JPEG", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pet-hardware-gif-"));

    try
    {
        const sourcePath = path.join(directory, "animated.gif");
        const width = 16;
        const height = 12;
        const first = Buffer.alloc(width * height * 4);
        const second = Buffer.alloc(width * height * 4);
        for (let index = 0; index < width * height; index++)
        {
            first[(index * 4)] = 240;
            first[(index * 4) + 3] = 255;
            second[(index * 4) + 2] = 240;
            second[(index * 4) + 3] = 255;
        }
        await sharp(Buffer.concat([first, second]), {
            raw: { width, height: height * 2, channels: 4, pageHeight: height }
        }).gif({ delay: [40, 80], loop: 0 }).toFile(sourcePath);

        const targetPath = await prepareHardwareMascot(sourcePath, directory);
        const image = fs.readFileSync(targetPath);
        const info = firmwareJpegInfo(image);
        const center = await sharp(image)
            .extract({ left: 168, top: 168, width: 1, height: 1 })
            .raw()
            .toBuffer();

        assert.deepEqual(info.sampling, [0x22, 0x11, 0x11]);
        assert.ok(center[0] > center[2], "frame zero must be used instead of the blue second frame");
        assert.equal(await isFirmwareCompatibleMascot(targetPath), true);
    }
    finally
    {
        sharp.cache(false);
        await fs.promises.rm(directory, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 100
        });
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
