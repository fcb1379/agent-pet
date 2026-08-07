"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const UPNG = require("upng-js");
const { MAX_ASSET_BYTES, MAX_HOVER_FRAMES } = require("./custom-assets");
const { encodeHardwareMascotGif } = require("./hardware-image");

const SUPPORTED_STICKER_EXTENSIONS = new Set([".gif", ".png", ".webp"]);
const MAX_DECODED_PIXELS = 64 * 1024 * 1024;
const MAX_CANVAS_SIZE = 512;
const MIN_FRAME_DELAY_MS = 20;
const MAX_FRAME_DELAY_MS = 1000;
const DEFAULT_FRAME_DELAY_MS = 100;
const CACHE_VERSION = "wechat-sticker-v2-hardware";

function boundedDelay(value)
{
    const delay = Number(value);
    return Number.isFinite(delay)
        ? Math.max(MIN_FRAME_DELAY_MS, Math.min(MAX_FRAME_DELAY_MS, Math.round(delay)))
        : DEFAULT_FRAME_DELAY_MS;
}

function buildFramePlan(delays, pageCount, frameLimit = MAX_HOVER_FRAMES)
{
    const normalizedDelays = Array.from(
        { length: pageCount },
        (_value, index) => boundedDelay(delays[index])
    );
    const outputCount = Math.min(pageCount, frameLimit);

    return Array.from({ length: outputCount }, (_value, outputIndex) => {
        const sourceIndex = Math.floor((outputIndex * pageCount) / outputCount);
        const nextSourceIndex = Math.floor(((outputIndex + 1) * pageCount) / outputCount);
        const duration = normalizedDelays
            .slice(sourceIndex, Math.max(sourceIndex + 1, nextSourceIndex))
            .reduce((total, delay) => total + delay, 0);
        return { sourceIndex, duration };
    });
}

function validateStickerFile(filePath)
{
    const resolvedPath = path.resolve(String(filePath || ""));
    const extension = path.extname(resolvedPath).toLowerCase();
    if (!SUPPORTED_STICKER_EXTENSIONS.has(extension))
    {
        throw new Error("仅支持动态 GIF、APNG 和动态 WebP 表情");
    }

    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile() || MAX_ASSET_BYTES < stat.size)
    {
        throw new Error(`动态表情必须小于 ${MAX_ASSET_BYTES / 1024 / 1024} MB`);
    }
    return { extension, resolvedPath };
}

function decodeApng(fileBuffer)
{
    const decoded = UPNG.decode(fileBuffer.buffer.slice(
        fileBuffer.byteOffset,
        fileBuffer.byteOffset + fileBuffer.byteLength
    ));
    if (!Array.isArray(decoded.frames) || 1 >= decoded.frames.length)
    {
        return null;
    }
    if (MAX_DECODED_PIXELS < decoded.width * decoded.height * decoded.frames.length)
    {
        throw new Error("动态表情解码后过大，请压缩后重试");
    }
    return {
        format: "apng",
        width: decoded.width,
        height: decoded.height,
        delays: decoded.frames.map((frame) => frame.delay),
        frames: UPNG.toRGBA8(decoded).map((frame) => Buffer.from(frame))
    };
}

async function inspectSharpAnimation(filePath)
{
    const metadata = await sharp(filePath, {
        animated: true,
        failOn: "warning",
        limitInputPixels: MAX_DECODED_PIXELS
    }).metadata();
    const pageCount = Number(metadata.pages) || 1;
    const pageHeight = Number(metadata.pageHeight) || Number(metadata.height) || 0;
    const width = Number(metadata.width) || 0;
    if (1 >= pageCount)
    {
        return null;
    }
    if (1 > width || 1 > pageHeight || MAX_DECODED_PIXELS < width * pageHeight * pageCount)
    {
        throw new Error("动态表情尺寸或总帧像素过大");
    }
    return {
        format: metadata.format,
        width,
        height: pageHeight,
        delays: Array.isArray(metadata.delay) ? metadata.delay : [],
        pageCount
    };
}

async function renderFrame(input, inputOptions, canvasSize, outputPath)
{
    await sharp(input, {
        ...inputOptions,
        failOn: "warning",
        limitInputPixels: MAX_DECODED_PIXELS
    })
        .rotate()
        .resize({
            width: canvasSize,
            height: canvasSize,
            fit: "contain",
            background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .png({ compressionLevel: 9 })
        .toFile(outputPath);
}

function loadCachedImport(targetDirectory)
{
    const manifestPath = path.join(targetDirectory, "manifest.json");
    if (!fs.existsSync(manifestPath))
    {
        return null;
    }
    try
    {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        const framePaths = manifest.frameFiles.map((fileName) => path.join(targetDirectory, fileName));
        const hardwarePath = manifest.hardwareFile
            ? path.join(targetDirectory, manifest.hardwareFile)
            : null;
        if (framePaths.every((framePath) => fs.existsSync(framePath)) &&
            (!hardwarePath || fs.existsSync(hardwarePath)))
        {
            return { ...manifest, framePaths, hardwarePath };
        }
    }
    catch (_error)
    {
        return null;
    }
    return null;
}

async function importStickerAnimation(filePath, assetDirectory)
{
    const { extension, resolvedPath } = validateStickerFile(filePath);
    const fileBuffer = fs.readFileSync(resolvedPath);
    const digest = crypto.createHash("sha256")
        .update(CACHE_VERSION)
        .update(fileBuffer)
        .digest("hex")
        .slice(0, 16);
    const stickerRoot = path.join(assetDirectory, "stickers");
    const targetDirectory = path.join(stickerRoot, digest);
    const cached = loadCachedImport(targetDirectory);
    if (cached)
    {
        return cached;
    }

    let animation = null;
    if (".png" === extension)
    {
        animation = decodeApng(fileBuffer);
    }
    if (!animation)
    {
        animation = await inspectSharpAnimation(resolvedPath);
    }
    if (!animation)
    {
        throw new Error("所选文件不是动态表情，请选择 GIF、APNG 或动态 WebP");
    }

    const pageCount = animation.frames ? animation.frames.length : animation.pageCount;
    const framePlan = buildFramePlan(animation.delays, pageCount);
    const canvasSize = Math.min(MAX_CANVAS_SIZE, Math.max(animation.width, animation.height));
    const temporaryDirectory = `${targetDirectory}.tmp-${process.pid}-${Date.now()}`;
    fs.mkdirSync(temporaryDirectory, { recursive: true });

    try
    {
        const frameFiles = [];
        for (let index = 0; index < framePlan.length; index++)
        {
            const frame = framePlan[index];
            const fileName = `frame-${String(index).padStart(2, "0")}.png`;
            const outputPath = path.join(temporaryDirectory, fileName);
            if (animation.frames)
            {
                await renderFrame(
                    animation.frames[frame.sourceIndex],
                    { raw: { width: animation.width, height: animation.height, channels: 4 } },
                    canvasSize,
                    outputPath
                );
            }
            else
            {
                await renderFrame(
                    resolvedPath,
                    { page: frame.sourceIndex, pages: 1 },
                    canvasSize,
                    outputPath
                );
            }
            frameFiles.push(fileName);
        }

        const hardwareFile = ".gif" === extension ? "hardware.gif" : null;
        if (hardwareFile)
        {
            fs.writeFileSync(
                path.join(temporaryDirectory, hardwareFile),
                await encodeHardwareMascotGif(resolvedPath)
            );
        }
        const manifest = {
            format: animation.format,
            sourceFrameCount: pageCount,
            frameCount: frameFiles.length,
            frameDurations: framePlan.map((frame) => frame.duration),
            frameFiles,
            canvasSize,
            hardwareFile
        };
        fs.writeFileSync(
            path.join(temporaryDirectory, "manifest.json"),
            `${JSON.stringify(manifest, null, 2)}\n`,
            "utf8"
        );
        fs.mkdirSync(stickerRoot, { recursive: true });
        if (fs.existsSync(targetDirectory))
        {
            fs.rmSync(targetDirectory, { recursive: true, force: true });
        }
        fs.renameSync(temporaryDirectory, targetDirectory);
        return {
            ...manifest,
            framePaths: frameFiles.map((fileName) => path.join(targetDirectory, fileName)),
            hardwarePath: hardwareFile ? path.join(targetDirectory, hardwareFile) : null
        };
    }
    catch (error)
    {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
        throw error;
    }
}

module.exports = {
    buildFramePlan,
    importStickerAnimation,
    SUPPORTED_STICKER_EXTENSIONS,
    validateStickerFile
};
