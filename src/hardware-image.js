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
        if (image.length <= HARDWARE_MASCOT_MAX_BYTES)
        {
            firmwareJpegInfo(image);
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
    findHardwareMascotSource,
    firmwareJpegInfo,
    HARDWARE_MASCOT_BACKGROUND,
    HARDWARE_MASCOT_MAX_BYTES,
    HARDWARE_MASCOT_SIZE,
    isFirmwareCompatibleMascot,
    prepareHardwareMascot
};
