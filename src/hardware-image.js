"use strict";

const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const HARDWARE_MASCOT_SIZE = 336;
const HARDWARE_MASCOT_MAX_BYTES = 128 * 1024;
const HARDWARE_MASCOT_BACKGROUND = Object.freeze({ r: 16, g: 35, b: 43, alpha: 1 });
const JPEG_QUALITIES = Object.freeze([88, 82, 76, 70, 64, 58, 52, 46]);
const MAX_SOURCE_PIXEL_DIFFERENCE = 4;
const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JFIF_APP0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01,
    0x00, 0x00
]);

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
        const encoded = await sharp(sourcePath, { animated: false, limitInputPixels: 25 * 1024 * 1024 })
            .rotate()
            .resize(HARDWARE_MASCOT_SIZE, HARDWARE_MASCOT_SIZE, {
                fit: "contain",
                background: HARDWARE_MASCOT_BACKGROUND,
                withoutEnlargement: false
            })
            .flatten({ background: HARDWARE_MASCOT_BACKGROUND })
            .jpeg({
                quality,
                chromaSubsampling: "4:4:4",
                mozjpeg: false,
                progressive: false
            })
            .toBuffer();
        const image = ensureFirmwareJfifHeader(encoded);
        if (image.length <= HARDWARE_MASCOT_MAX_BYTES)
        {
            return image;
        }
    }

    throw new Error(`处理后的桌宠图片超过 ${HARDWARE_MASCOT_MAX_BYTES / 1024} KB`);
}

async function prepareHardwareMascot(sourcePath, assetDirectory)
{
    const targetDirectory = path.join(assetDirectory, "mascot");
    const targetPath = path.join(targetDirectory, "hardware-mascot.jpg");
    const temporaryPath = `${targetPath}.tmp`;
    const image = await encodeHardwareMascot(sourcePath);

    fs.mkdirSync(targetDirectory, { recursive: true });
    fs.writeFileSync(temporaryPath, image);
    if (fs.existsSync(targetPath))
    {
        fs.unlinkSync(targetPath);
    }
    fs.renameSync(temporaryPath, targetPath);
    return targetPath;
}

async function isFirmwareCompatibleMascot(hardwarePath)
{
    if ("string" !== typeof hardwarePath || !fs.existsSync(hardwarePath))
    {
        return false;
    }

    const image = fs.readFileSync(hardwarePath);
    if (4 > image.length || HARDWARE_MASCOT_MAX_BYTES < image.length ||
        10 > image.length ||
        "ffd8ffe000104a464946" !== image.subarray(0, 10).toString("hex"))
    {
        return false;
    }

    try
    {
        const metadata = await sharp(image).metadata();
        return "jpeg" === metadata.format &&
            HARDWARE_MASCOT_SIZE === metadata.width &&
            HARDWARE_MASCOT_SIZE === metadata.height &&
            false === metadata.isProgressive;
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
    findHardwareMascotSource,
    HARDWARE_MASCOT_BACKGROUND,
    HARDWARE_MASCOT_MAX_BYTES,
    HARDWARE_MASCOT_SIZE,
    isFirmwareCompatibleMascot,
    prepareHardwareMascot
};
