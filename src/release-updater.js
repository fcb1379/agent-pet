"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const RELEASE_SOURCES = Object.freeze({
    github: Object.freeze({
        label: "GitHub",
        apiUrl: "https://api.github.com/repos/fcb1379/agent-pet/releases/latest",
        headers: Object.freeze({
            Accept: "application/vnd.github+json",
            "User-Agent": "agent-pet-updater",
            "X-GitHub-Api-Version": "2022-11-28"
        })
    }),
    gitee: Object.freeze({
        label: "Gitee",
        apiUrl: "https://gitee.com/api/v5/repos/reussss/agent-pet/releases/latest",
        headers: Object.freeze({
            Accept: "application/json",
            "User-Agent": "agent-pet-updater"
        })
    })
});
const RELEASE_API_URL = RELEASE_SOURCES.github.apiUrl;

function versionParts(value)
{
    const match = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
    return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right)
{
    const leftParts = versionParts(left);
    const rightParts = versionParts(right);
    if (!leftParts || !rightParts)
    {
        throw new Error("Release 版本号格式无效");
    }
    for (let index = 0; index < leftParts.length; index++)
    {
        if (leftParts[index] !== rightParts[index])
        {
            return leftParts[index] > rightParts[index] ? 1 : -1;
        }
    }
    return 0;
}

function selectReleaseAssets(release)
{
    const version = String(release.tag_name || "").replace(/^v/, "");
    const executableName = `AgentPet-${version}-portable.exe`;
    const checksumName = `${executableName}.sha256`;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const executable = assets.find((asset) => executableName === asset.name);
    const checksum = assets.find((asset) => checksumName === asset.name);
    if (!executable || !checksum)
    {
        throw new Error("最新 Release 缺少 Windows 便携版或 SHA256 校验文件");
    }
    return {
        version,
        tagName: release.tag_name,
        releaseName: release.name || release.tag_name,
        releaseNotes: release.body || "",
        releaseUrl: release.html_url,
        executable: {
            name: executable.name,
            url: executable.browser_download_url
        },
        checksum: {
            name: checksum.name,
            url: checksum.browser_download_url
        }
    };
}

async function fetchLatestRelease(fetchImplementation, currentVersion, sourceName = "github")
{
    const source = RELEASE_SOURCES[sourceName] || RELEASE_SOURCES.github;
    const response = await fetchImplementation(source.apiUrl, {
        headers: source.headers
    });
    if (!response.ok)
    {
        if ("gitee" === sourceName && 404 === response.status)
        {
            throw new Error("Gitee 暂无可用 Release，请先在 Gitee 发布包含便携版和 SHA256 校验文件的版本");
        }
        throw new Error(`${source.label} Release 查询失败（HTTP ${response.status}）`);
    }
    const release = await response.json();
    const update = selectReleaseAssets(release);
    return {
        ...update,
        source: sourceName,
        sourceLabel: source.label,
        updateAvailable: 0 < compareVersions(update.version, currentVersion)
    };
}

function parseChecksum(value, expectedFileName)
{
    const line = String(value || "").trim().split(/\r?\n/)[0] || "";
    const match = line.match(/^([a-f\d]{64})(?:\s+\*?(.+))?$/i);
    if (!match)
    {
        throw new Error("Release SHA256 文件格式无效");
    }
    if (match[2] && path.basename(match[2].trim()) !== expectedFileName)
    {
        throw new Error("Release SHA256 文件名不匹配");
    }
    return match[1].toUpperCase();
}

async function responseText(response, label)
{
    if (!response.ok)
    {
        throw new Error(`${label}下载失败（HTTP ${response.status}）`);
    }
    return response.text();
}

async function downloadRelease(fetchImplementation, update, downloadsDirectory, onProgress = () => {})
{
    const checksumResponse = await fetchImplementation(update.checksum.url);
    const expectedHash = parseChecksum(
        await responseText(checksumResponse, "校验文件"),
        update.executable.name
    );
    const destinationPath = path.join(downloadsDirectory, update.executable.name);
    const temporaryPath = `${destinationPath}.download`;
    fs.mkdirSync(downloadsDirectory, { recursive: true });
    fs.rmSync(temporaryPath, { force: true });

    const response = await fetchImplementation(update.executable.url);
    if (!response.ok || !response.body)
    {
        throw new Error(`更新文件下载失败（HTTP ${response.status}）`);
    }
    const totalBytes = Number(response.headers.get("content-length")) || 0;
    const hash = crypto.createHash("sha256");
    let downloadedBytes = 0;
    const progress = new Transform({
        transform(chunk, _encoding, callback)
        {
            hash.update(chunk);
            downloadedBytes += chunk.length;
            onProgress({ downloadedBytes, totalBytes });
            callback(null, chunk);
        }
    });

    try
    {
        await pipeline(
            Readable.fromWeb(response.body),
            progress,
            fs.createWriteStream(temporaryPath)
        );
        const actualHash = hash.digest("hex").toUpperCase();
        if (actualHash !== expectedHash)
        {
            throw new Error("更新文件 SHA256 校验失败，文件可能不完整");
        }
        fs.rmSync(destinationPath, { force: true });
        fs.renameSync(temporaryPath, destinationPath);
        return { destinationPath, sha256: actualHash };
    }
    catch (error)
    {
        fs.rmSync(temporaryPath, { force: true });
        throw error;
    }
}

module.exports = {
    compareVersions,
    downloadRelease,
    fetchLatestRelease,
    parseChecksum,
    RELEASE_API_URL,
    RELEASE_SOURCES,
    selectReleaseAssets,
    versionParts
};
