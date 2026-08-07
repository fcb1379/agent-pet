"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const {
    encodeHardwareMascotGifFrames,
    findHardwareMascotSource,
    firmwareJpegInfo,
    HARDWARE_MASCOT_GIF_MAX_BYTES,
    HARDWARE_MASCOT_GIF_SIZE,
    HARDWARE_MASCOT_MAX_BYTES,
    HARDWARE_MASCOT_SIZE,
    isFirmwareCompatibleMascot,
    prepareHardwareMascot
} = require("../src/hardware-image");

test("legacy PNG hover frames migrate into a hardware GIF", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pet-legacy-hover-"));

    try
    {
        const framePaths = [];
        for (const [index, colour] of [[0, "#ff3322"], [1, "#2277ff"]])
        {
            const framePath = path.join(directory, `frame-${index}.png`);
            await sharp({
                create: { width: 24, height: 18, channels: 4, background: colour }
            }).png().toFile(framePath);
            framePaths.push(framePath);
        }
        const image = await encodeHardwareMascotGifFrames(framePaths, [60, 120]);
        const metadata = await sharp(image, { animated: true }).metadata();

        assert.equal(image.subarray(0, 6).toString("ascii"), "GIF89a");
        assert.equal(metadata.pages, 2);
        assert.equal(metadata.width, HARDWARE_MASCOT_GIF_SIZE);
        assert.deepEqual(metadata.delay, [60, 120]);
        assert.ok(image.length <= HARDWARE_MASCOT_GIF_MAX_BYTES);
    }
    finally
    {
        sharp.cache(false);
        await fs.promises.rm(directory, { recursive: true, force: true });
    }
});

test("hardware mascot is persisted as a bounded 192px JPEG", async () => {
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

test("animated GIF hardware mascot preserves frames and delays at the safe hardware size", async () => {
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
        const metadata = await sharp(image, { animated: true }).metadata();

        assert.equal(path.basename(targetPath), "hardware-mascot-v2.gif");
        assert.equal(image.subarray(0, 6).toString("ascii"), "GIF89a");
        assert.equal(metadata.pages, 2);
        assert.equal(metadata.width, HARDWARE_MASCOT_GIF_SIZE);
        assert.equal(metadata.pageHeight, HARDWARE_MASCOT_GIF_SIZE);
        assert.deepEqual(metadata.delay, [40, 80]);
        assert.ok(image.length <= HARDWARE_MASCOT_GIF_MAX_BYTES);
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

test("oversized-frame-count GIF is sampled automatically for firmware transfer", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pet-hardware-gif-sampled-"));

    try
    {
        const sourcePath = path.join(directory, "many-frames.gif");
        const width = 2;
        const height = 2;
        const frameCount = 121;
        const delays = Array(frameCount).fill(40);
        const pixels = Buffer.alloc(width * height * 4 * frameCount);
        for (let frameIndex = 0; frameIndex < frameCount; frameIndex++)
        {
            for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex++)
            {
                const offset = ((frameIndex * width * height) + pixelIndex) * 4;
                pixels[offset] = (frameIndex * 17) & 0xff;
                pixels[offset + 1] = (frameIndex * 29) & 0xff;
                pixels[offset + 2] = (frameIndex * 43) & 0xff;
                pixels[offset + 3] = 255;
            }
        }
        await sharp(pixels, {
            raw: { width, height: height * frameCount, channels: 4, pageHeight: height }
        }).gif({ delay: delays, loop: 0 }).toFile(sourcePath);

        const targetPath = await prepareHardwareMascot(sourcePath, directory);
        const metadata = await sharp(targetPath, { animated: true }).metadata();

        assert.equal(path.basename(targetPath), "hardware-mascot-v2.gif");
        assert.ok(2 <= metadata.pages && 60 >= metadata.pages);
        assert.equal(metadata.delay.reduce((total, delay) => total + delay, 0), 4840);
        assert.ok(50 <= 4840 / metadata.pages);
        assert.ok(fs.statSync(targetPath).size <= HARDWARE_MASCOT_GIF_MAX_BYTES);
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
