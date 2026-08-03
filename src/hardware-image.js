"use strict";

const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const HARDWARE_MASCOT_SIZE = 336;
const HARDWARE_MASCOT_MAX_BYTES = 128 * 1024;
const HARDWARE_MASCOT_BACKGROUND = Object.freeze({ r: 16, g: 35, b: 43, alpha: 1 });
const JPEG_QUALITIES = Object.freeze([88, 82, 76, 70, 64, 58, 52, 46]);

async function encodeHardwareMascot(sourcePath)
{
    if ("string" !== typeof sourcePath || !fs.existsSync(sourcePath))
    {
        throw new Error("桌宠图片不存在");
    }

    for (const quality of JPEG_QUALITIES)
    {
        const image = await sharp(sourcePath, { animated: false, limitInputPixels: 25 * 1024 * 1024 })
            .rotate()
            .resize(HARDWARE_MASCOT_SIZE, HARDWARE_MASCOT_SIZE, {
                fit: "contain",
                background: HARDWARE_MASCOT_BACKGROUND,
                withoutEnlargement: false
            })
            .flatten({ background: HARDWARE_MASCOT_BACKGROUND })
            .jpeg({ quality, chromaSubsampling: "4:4:4", mozjpeg: true })
            .toBuffer();
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

module.exports = {
    HARDWARE_MASCOT_BACKGROUND,
    HARDWARE_MASCOT_MAX_BYTES,
    HARDWARE_MASCOT_SIZE,
    encodeHardwareMascot,
    prepareHardwareMascot
};
