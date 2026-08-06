"use strict";

const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const HARDWARE_MASCOT_SIZE = 192;
const HARDWARE_MASCOT_GIF_SIZE = HARDWARE_MASCOT_SIZE;
const HARDWARE_MASCOT_JPEG_MAX_BYTES = 128 * 1024;
const HARDWARE_MASCOT_GIF_MAX_BYTES = 512 * 1024;
const HARDWARE_MASCOT_MAX_BYTES = HARDWARE_MASCOT_GIF_MAX_BYTES;
const HARDWARE_MASCOT_BACKGROUND = Object.freeze({ r: 16, g: 35, b: 43, alpha: 1 });
const JPEG_QUALITIES = Object.freeze([88, 82, 76, 70, 64, 58, 52, 46]);
const GIF_COLOUR_COUNTS = Object.freeze([256, 192, 128, 96, 64, 48, 32]);
const GIF_CANVAS_SIZES = Object.freeze([HARDWARE_MASCOT_GIF_SIZE, 160, 128]);
const GIF_FRAME_TARGETS = Object.freeze([60, 45, 30, 24, 18, 12, 8, 4, 2]);
const GIF_MAX_FRAMES = 60;
const GIF_MIN_DELAY_MS = 20;
const GIF_TARGET_MIN_DELAY_MS = 50;
const GIF_MAX_DELAY_MS = 1000;
const GIF_MAX_AGGREGATED_DELAY_MS = 600000;
const GIF_SOURCE_PIXEL_LIMIT = 256 * 1024 * 1024;
const MAX_SOURCE_PIXEL_DIFFERENCE = 4;
const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JFIF_APP0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01,
    0x00, 0x00
]);

function isStartOfFrameMarker(marker)
{
    return (0xc0 <= marker && 0xcf >= marker &&
        0xc4 !== marker && 0xc8 !== marker && 0xcc !== marker);
}

function firmwareJpegInfo(image)
{
    if (!Buffer.isBuffer(image) || 32 > image.length ||
        0xff !== image[0] || 0xd8 !== image[1] ||
        0xff !== image[image.length - 2] || 0xd9 !== image[image.length - 1])
    {
        throw new Error("Hardware mascot is not a complete JPEG");
    }

    let offset = 2;
    let frame = null;
    while (offset < image.length - 2)
    {
        if (0xff !== image[offset++])
        {
            throw new Error("Hardware mascot has an invalid JPEG marker");
        }
        while (offset < image.length && 0xff === image[offset])
        {
            offset++;
        }
        if (offset >= image.length)
        {
            break;
        }

        const marker = image[offset++];
        if (0x00 === marker)
        {
            throw new Error("Hardware mascot has an escaped marker before scan data");
        }
        if (0xd9 === marker)
        {
            break;
        }
        if (0xd8 === marker || 0x01 === marker || (0xd0 <= marker && 0xd7 >= marker))
        {
            continue;
        }
        if (offset + 2 > image.length)
        {
            throw new Error("Hardware mascot has a truncated JPEG segment");
        }

        const segmentLength = image.readUInt16BE(offset);
        if (2 > segmentLength || offset + segmentLength > image.length)
        {
            throw new Error("Hardware mascot has an invalid JPEG segment length");
        }
        const payload = offset + 2;
        if (0xc0 === marker)
        {
            if (17 !== segmentLength || 8 !== image[payload] || 3 !== image[payload + 5])
            {
                throw new Error("Hardware mascot must use 8-bit three-component baseline JPEG");
            }
            frame = {
                height: image.readUInt16BE(payload + 1),
                width: image.readUInt16BE(payload + 3),
                sampling: [image[payload + 7], image[payload + 10], image[payload + 13]]
            };
        }
        else if (isStartOfFrameMarker(marker))
        {
            throw new Error("Hardware mascot must not use progressive or extended JPEG");
        }
        if (0xda === marker)
        {
            if (!frame || HARDWARE_MASCOT_SIZE !== frame.width ||
                HARDWARE_MASCOT_SIZE !== frame.height ||
                0x22 !== frame.sampling[0] ||
                0x11 !== frame.sampling[1] ||
                0x11 !== frame.sampling[2])
            {
                throw new Error("Hardware mascot must be 336px baseline JPEG with 4:2:0 sampling");
            }
            return frame;
        }
        offset += segmentLength;
    }

    throw new Error("Hardware mascot JPEG has no valid image scan");
}

function ensureFirmwareJfifHeader(image)
{
    if (!Buffer.isBuffer(image) || image.length < JPEG_SOI.length ||
        !image.subarray(0, JPEG_SOI.length).equals(JPEG_SOI))
    {
        throw new Error("硬件桌宠编码结果不是 JPEG");
    }

    if (image.length >= 10 &&
        image.subarray(2, 10).equals(JFIF_APP0.subarray(0, 8)))
    {
        return image;
    }

    return Buffer.concat([
        JPEG_SOI,
        JFIF_APP0,
        image.subarray(JPEG_SOI.length)
    ]);
}

async function encodeHardwareMascot(sourcePath)
{
    if ("string" !== typeof sourcePath || !fs.existsSync(sourcePath))
    {
        throw new Error("桌宠图片不存在");
    }

    for (const quality of JPEG_QUALITIES)
    {
        const encoded = await sharp(sourcePath, {
            animated: false,
            page: 0,
            pages: 1,
            limitInputPixels: 25 * 1024 * 1024
        })
            .rotate()
            .resize(HARDWARE_MASCOT_SIZE, HARDWARE_MASCOT_SIZE, {
                fit: "contain",
                background: HARDWARE_MASCOT_BACKGROUND,
                withoutEnlargement: false
            })
            .flatten({ background: HARDWARE_MASCOT_BACKGROUND })
            .toColourspace("srgb")
            .jpeg({
                quality,
                chromaSubsampling: "4:2:0",
                mozjpeg: false,
                progressive: false
            })
            .toBuffer();
        const image = ensureFirmwareJfifHeader(encoded);
        if (image.length <= HARDWARE_MASCOT_JPEG_MAX_BYTES)
        {
            firmwareJpegInfo(image);
            return image;
        }
    }

    throw new Error(`处理后的桌宠图片超过 ${HARDWARE_MASCOT_JPEG_MAX_BYTES / 1024} KB`);
}

function boundedGifDelay(value)
{
    const delay = Number(value);

    return Number.isFinite(delay)
        ? Math.max(GIF_MIN_DELAY_MS, Math.min(GIF_MAX_DELAY_MS, Math.round(delay)))
        : 100;
}

function buildHardwareGifFramePlan(delays, sourceFrameCount, targetFrameCount)
{
    const outputFrameCount = Math.max(
        2,
        Math.min(sourceFrameCount, targetFrameCount, GIF_MAX_FRAMES)
    );
    const sourceDelays = Array.from(
        { length: sourceFrameCount },
        (_value, index) => boundedGifDelay(delays[index])
    );

    return Array.from({ length: outputFrameCount }, (_value, outputIndex) => {
        const sourceIndex = Math.floor((outputIndex * sourceFrameCount) / outputFrameCount);
        const nextSourceIndex = Math.floor(
            ((outputIndex + 1) * sourceFrameCount) / outputFrameCount
        );
        const delay = sourceDelays
            .slice(sourceIndex, Math.max(sourceIndex + 1, nextSourceIndex))
            .reduce((total, frameDelay) => total + frameDelay, 0);
        return {
            sourceIndex,
            delay: Math.min(GIF_MAX_AGGREGATED_DELAY_MS, delay)
        };
    });
}

async function encodeHardwareGifCandidate(input, inputOptions, canvasSize, delays, loop)
{
    for (const colours of GIF_COLOUR_COUNTS)
    {
        let pipeline = sharp(input, inputOptions);
        const raw = inputOptions && inputOptions.raw;
        if (!raw || raw.width !== canvasSize || raw.pageHeight !== canvasSize)
        {
            pipeline = pipeline.resize(canvasSize, canvasSize, {
                fit: "contain",
                background: HARDWARE_MASCOT_BACKGROUND,
                withoutEnlargement: false
            });
        }
        const image = await pipeline.gif({
                colours,
                effort: 7,
                dither: 1,
                interFrameMaxError: 0,
                interPaletteMaxError: 3,
                loop,
                delay: delays
            })
            .toBuffer();
        if (image.length <= HARDWARE_MASCOT_GIF_MAX_BYTES &&
            "GIF89a" === image.subarray(0, 6).toString("ascii"))
        {
            const outputMetadata = await sharp(image, { animated: true }).metadata();
            const outputFrameCount = Number(outputMetadata.pages) || 1;
            if (2 <= outputFrameCount && GIF_MAX_FRAMES >= outputFrameCount &&
                canvasSize === Number(outputMetadata.width) &&
                canvasSize === Number(outputMetadata.pageHeight))
            {
                return image;
            }
        }
    }

    return null;
}

async function renderHardwareGifFrames(sourcePath, framePlan, canvasSize)
{
    const frames = [];

    for (const frame of framePlan)
    {
        const pixels = await sharp(sourcePath, {
            page: frame.sourceIndex,
            pages: 1,
            failOn: "warning",
            limitInputPixels: GIF_SOURCE_PIXEL_LIMIT
        })
            .rotate()
            .resize(canvasSize, canvasSize, {
                fit: "contain",
                background: HARDWARE_MASCOT_BACKGROUND,
                withoutEnlargement: false
            })
            .ensureAlpha()
            .raw()
            .toBuffer();
        frames.push(pixels);
    }

    return Buffer.concat(frames);
}

async function encodeHardwareMascotGif(sourcePath)
{
    if ("string" !== typeof sourcePath || !fs.existsSync(sourcePath))
    {
        throw new Error("桌宠 GIF 不存在");
    }

    const metadata = await sharp(sourcePath, {
        animated: true,
        failOn: "warning",
        limitInputPixels: GIF_SOURCE_PIXEL_LIMIT
    }).metadata();
    const frameCount = Number(metadata.pages) || 1;
    if (2 > frameCount)
    {
        throw new Error("所选 GIF 不包含动画帧");
    }
    const delays = Array.from(
        { length: frameCount },
        (_value, index) => boundedGifDelay((metadata.delay || [])[index])
    );
    const loop = Number.isInteger(metadata.loop) ? Math.max(0, metadata.loop) : 0;
    const totalDurationMs = delays.reduce((total, delay) => total + delay, 0);
    const playbackFrameLimit = Math.max(
        2,
        Math.floor(totalDurationMs / GIF_TARGET_MIN_DELAY_MS)
    );

    if ((GIF_MAX_FRAMES >= frameCount) && (playbackFrameLimit >= frameCount))
    {
        for (const canvasSize of GIF_CANVAS_SIZES)
        {
            const image = await encodeHardwareGifCandidate(
                sourcePath,
                {
                    animated: true,
                    failOn: "warning",
                    limitInputPixels: GIF_SOURCE_PIXEL_LIMIT
                },
                canvasSize,
                delays,
                loop
            );
            if (image)
            {
                return image;
            }
        }
    }

    const frameTargets = [playbackFrameLimit, ...GIF_FRAME_TARGETS]
        .map((target) => Math.min(frameCount, target))
        .filter((target, index, values) =>
            2 <= target && values.indexOf(target) === index);
    for (const targetFrameCount of frameTargets)
    {
        const framePlan = buildHardwareGifFramePlan(
            metadata.delay || [],
            frameCount,
            targetFrameCount
        );
        for (const canvasSize of GIF_CANVAS_SIZES)
        {
            const renderedFrames = await renderHardwareGifFrames(
                sourcePath,
                framePlan,
                canvasSize
            );
            const image = await encodeHardwareGifCandidate(
                renderedFrames,
                {
                    raw: {
                        width: canvasSize,
                        height: canvasSize * framePlan.length,
                        channels: 4,
                        pageHeight: canvasSize
                    }
                },
                canvasSize,
                framePlan.map((frame) => frame.delay),
                loop
            );
            if (image)
            {
                return image;
            }
        }
    }

    throw new Error("该 GIF 无法转换为硬件可播放动画，请尝试更短的动画");
}

async function prepareHardwareMascot(sourcePath, assetDirectory)
{
    const targetDirectory = path.join(assetDirectory, "mascot");
    const animatedGif = ".gif" === path.extname(sourcePath).toLowerCase();
    const targetPath = path.join(
        targetDirectory,
        animatedGif ? "hardware-mascot-v2.gif" : "hardware-mascot.jpg"
    );
    const temporaryPath = `${targetPath}.tmp`;
    const image = animatedGif
        ? await encodeHardwareMascotGif(sourcePath)
        : await encodeHardwareMascot(sourcePath);

    fs.mkdirSync(targetDirectory, { recursive: true });
    fs.writeFileSync(temporaryPath, image);
    if (fs.existsSync(targetPath))
    {
        fs.unlinkSync(targetPath);
    }
    fs.renameSync(temporaryPath, targetPath);
    const staleFileNames = animatedGif
        ? ["hardware-mascot.jpg", "hardware-mascot.gif"]
        : ["hardware-mascot-v2.gif", "hardware-mascot.gif"];
    for (const staleFileName of staleFileNames)
    {
        const stalePath = path.join(targetDirectory, staleFileName);
        if (fs.existsSync(stalePath))
        {
            fs.unlinkSync(stalePath);
        }
    }
    return targetPath;
}

async function isFirmwareCompatibleMascot(hardwarePath)
{
    if ("string" !== typeof hardwarePath || !fs.existsSync(hardwarePath))
    {
        return false;
    }

    const image = fs.readFileSync(hardwarePath);
    if (4 > image.length || HARDWARE_MASCOT_MAX_BYTES < image.length)
    {
        return false;
    }

    try
    {
        if ("GIF89a" === image.subarray(0, 6).toString("ascii"))
        {
            const metadata = await sharp(image, { animated: true }).metadata();
            const frameCount = Number(metadata.pages) || 1;
            const delays = Array.from(
                { length: frameCount },
                (_value, index) => boundedGifDelay((metadata.delay || [])[index])
            );
            const totalDurationMs = delays.reduce((total, delay) => total + delay, 0);
            const playbackFrameLimit = Math.max(
                2,
                Math.floor(totalDurationMs / GIF_TARGET_MIN_DELAY_MS)
            );
            return HARDWARE_MASCOT_GIF_MAX_BYTES >= image.length &&
                2 <= frameCount && GIF_MAX_FRAMES >= frameCount &&
                playbackFrameLimit >= frameCount &&
                0 < Number(metadata.width) &&
                HARDWARE_MASCOT_SIZE >= Number(metadata.width) &&
                0 < Number(metadata.pageHeight) &&
                HARDWARE_MASCOT_SIZE >= Number(metadata.pageHeight);
        }
        if (10 > image.length ||
            "ffd8ffe000104a464946" !== image.subarray(0, 10).toString("hex"))
        {
            return false;
        }
        const info = firmwareJpegInfo(image);
        const decoded = await sharp(image, {
            animated: false,
            limitInputPixels: HARDWARE_MASCOT_SIZE * HARDWARE_MASCOT_SIZE
        }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        return HARDWARE_MASCOT_SIZE === info.width &&
            HARDWARE_MASCOT_SIZE === info.height &&
            HARDWARE_MASCOT_SIZE === decoded.info.width &&
            HARDWARE_MASCOT_SIZE === decoded.info.height;
    }
    catch (_error)
    {
        return false;
    }
}
async function findHardwareMascotSource(hardwarePath)
{
    if ("string" !== typeof hardwarePath || !fs.existsSync(hardwarePath))
    {
        return null;
    }

    const hardwareImage = fs.readFileSync(hardwarePath);
    const hardwarePixels = await sharp(hardwareImage).removeAlpha().raw().toBuffer();
    const hardwareName = path.basename(hardwarePath).toLowerCase();
    const candidatePaths = fs.readdirSync(path.dirname(hardwarePath), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase() !== hardwareName)
        .map((entry) => path.join(path.dirname(hardwarePath), entry.name))
        .sort((left, right) => {
            const leftExtracted = /-extracted\.png$/i.test(left);
            const rightExtracted = /-extracted\.png$/i.test(right);
            return Number(rightExtracted) - Number(leftExtracted);
        });
    let bestCandidatePath = null;
    let bestPixelDifference = Number.POSITIVE_INFINITY;

    for (const candidatePath of candidatePaths)
    {
        try
        {
            const candidateImage = await encodeHardwareMascot(candidatePath);
            if (hardwareImage.equals(candidateImage))
            {
                return candidatePath;
            }

            const candidatePixels = await sharp(candidateImage).removeAlpha().raw().toBuffer();
            if (candidatePixels.length !== hardwarePixels.length)
            {
                continue;
            }
            let totalDifference = 0;
            for (let index = 0; index < hardwarePixels.length; index++)
            {
                totalDifference += Math.abs(hardwarePixels[index] - candidatePixels[index]);
            }
            const pixelDifference = totalDifference / hardwarePixels.length;
            if (pixelDifference < bestPixelDifference)
            {
                bestPixelDifference = pixelDifference;
                bestCandidatePath = candidatePath;
            }
        }
        catch (_error)
        {
            /* Ignore unrelated or unreadable files in the mascot asset directory. */
        }
    }

    return bestPixelDifference <= MAX_SOURCE_PIXEL_DIFFERENCE
        ? bestCandidatePath
        : null;
}

module.exports = {
    encodeHardwareMascot,
    encodeHardwareMascotGif,
    findHardwareMascotSource,
    firmwareJpegInfo,
    HARDWARE_MASCOT_BACKGROUND,
    HARDWARE_MASCOT_MAX_BYTES,
    HARDWARE_MASCOT_GIF_MAX_BYTES,
    HARDWARE_MASCOT_GIF_SIZE,
    HARDWARE_MASCOT_JPEG_MAX_BYTES,
    HARDWARE_MASCOT_SIZE,
    isFirmwareCompatibleMascot,
    prepareHardwareMascot
};
