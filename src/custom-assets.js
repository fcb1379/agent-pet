"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_HOVER_FRAMES = 48;

function validateImageFile(filePath)
{
    const extension = path.extname(String(filePath || "")).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension))
    {
        throw new Error(`不支持的图片格式：${extension || "未知"}`);
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || MAX_ASSET_BYTES < stat.size)
    {
        throw new Error(`图片必须小于 ${MAX_ASSET_BYTES / 1024 / 1024} MB`);
    }
    return { extension, size: stat.size };
}

function versionedImageFileUrl(filePath)
{
    if (!filePath || !fs.existsSync(filePath))
    {
        return null;
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile())
    {
        return null;
    }

    const url = pathToFileURL(filePath);
    url.searchParams.set("v", `${stat.size}-${stat.mtimeMs}`);
    return url.href;
}

function imageFileDigest(filePath)
{
    return crypto.createHash("sha256")
        .update(fs.readFileSync(filePath))
        .digest("hex");
}

function copyImageAsset(sourcePath, targetPath, sourceDigest)
{
    if (fs.existsSync(targetPath))
    {
        const targetStat = fs.statSync(targetPath);
        const sourceStat = fs.statSync(sourcePath);
        if (targetStat.isFile() && targetStat.size === sourceStat.size &&
            sourceDigest === imageFileDigest(targetPath))
        {
            return;
        }
        throw new Error("图片缓存文件名冲突，请重新选择图片");
    }

    fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
}

function importImageFiles(filePaths, assetDirectory, group)
{
    const files = [...new Set(filePaths.map((value) => path.resolve(value)))];
    const limit = "hover" === group ? MAX_HOVER_FRAMES : 1;
    if (0 === files.length || limit < files.length)
    {
        throw new Error(`请选择 1 到 ${limit} 张图片`);
    }

    const targetDirectory = path.join(assetDirectory, group);
    fs.mkdirSync(targetDirectory, { recursive: true });

    return files.sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true }))
        .map((sourcePath, index) => {
            const { extension } = validateImageFile(sourcePath);
            const sourceDigest = imageFileDigest(sourcePath);
            const digest = sourceDigest.slice(0, 12);
            const targetPath = path.join(targetDirectory, `${group}-${String(index).padStart(2, "0")}-${digest}${extension}`);
            copyImageAsset(sourcePath, targetPath, sourceDigest);
            return targetPath;
        });
}

module.exports = {
    ALLOWED_EXTENSIONS,
    importImageFiles,
    MAX_ASSET_BYTES,
    MAX_HOVER_FRAMES,
    validateImageFile,
    versionedImageFileUrl
};
