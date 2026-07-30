"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");

const GITEE_API_BASE = "https://gitee.com/api/v5";
const DEFAULT_TAG_WAIT_ATTEMPTS = 20;
const DEFAULT_TAG_WAIT_INTERVAL_MS = 30000;

function versionFromTag(tagName)
{
    const match = String(tagName || "").trim().match(/^v?(\d+\.\d+\.\d+)$/);
    if (!match)
    {
        throw new Error(`不支持的 Release 标签：${tagName}`);
    }
    return match[1];
}

function requiredAssetNames(tagName)
{
    const version = versionFromTag(tagName);
    const executableName = `AgentPet-${version}-portable.exe`;
    return [executableName, `${executableName}.sha256`];
}

function findRequiredAssets(directory, tagName)
{
    const names = requiredAssetNames(tagName);
    const files = names.map((name) => path.join(directory, name));
    const missing = files.filter((filePath) => !fs.existsSync(filePath));
    if (0 < missing.length)
    {
        throw new Error(`缺少 GitHub Release 附件：${missing.map((filePath) => path.basename(filePath)).join("、")}`);
    }
    return files;
}

function positiveInteger(value, fallback)
{
    const number = Number(value);
    return Number.isInteger(number) && 0 < number ? number : fallback;
}

function delay(milliseconds)
{
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function uploadFileWithHttps(options, requestImplementation = https.request)
{
    const fileName = path.basename(options.filePath).replace(/["\r\n]/g, "_");
    const boundary = `----agent-pet-${crypto.randomUUID()}`;
    const prefix = Buffer.from(
        `--${boundary}\r\n`
        + `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`
        + "Content-Type: application/octet-stream\r\n\r\n"
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const contentLength = prefix.length + fs.statSync(options.filePath).size + suffix.length;

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
            if (settled)
            {
                return;
            }
            settled = true;
            if (error)
            {
                reject(error);
                return;
            }
            resolve(value);
        };
        const request = requestImplementation(options.url, {
            method: "POST",
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${options.token}`,
                "Content-Length": String(contentLength),
                "Content-Type": `multipart/form-data; boundary=${boundary}`,
                "User-Agent": "agent-pet-gitee-release-sync"
            }
        }, (response) => {
            let responseText = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
                responseText += chunk;
            });
            response.on("error", (error) => finish(error));
            response.on("end", () => {
                if (200 <= response.statusCode && 300 > response.statusCode)
                {
                    finish(null, responseText);
                    return;
                }
                finish(new Error(
                    `Gitee 附件上传失败（HTTP ${response.statusCode}）：${responseText || "未知错误"}`
                ));
            });
        });
        request.on("error", (error) => finish(error));
        request.write(prefix);

        const fileStream = fs.createReadStream(options.filePath);
        fileStream.on("error", (error) => request.destroy(error));
        fileStream.on("end", () => request.end(suffix));
        fileStream.pipe(request, { end: false });
    });
}

class GiteeClient
{
    constructor(
        token,
        owner,
        repository,
        fetchImplementation = globalThis.fetch,
        uploadImplementation = uploadFileWithHttps
    )
    {
        if (!token)
        {
            throw new Error("缺少 GITEE_TOKEN，请在 GitHub Actions Secrets 中配置");
        }
        if (!owner || !repository)
        {
            throw new Error("缺少 Gitee 仓库信息");
        }
        if ("function" !== typeof fetchImplementation)
        {
            throw new Error("当前 Node.js 不支持 fetch");
        }
        this.token = token;
        this.owner = owner;
        this.repository = repository;
        this.fetchImplementation = fetchImplementation;
        this.uploadImplementation = uploadImplementation;
    }

    async request(method, apiPath, options = {})
    {
        const headers = {
            Accept: "application/json",
            Authorization: `Bearer ${this.token}`,
            "User-Agent": "agent-pet-gitee-release-sync",
            ...options.headers
        };
        const response = await this.fetchImplementation(`${GITEE_API_BASE}${apiPath}`, {
            method,
            headers,
            body: options.body
        });
        const text = await response.text();
        let data = null;
        if (text)
        {
            try
            {
                data = JSON.parse(text);
            }
            catch (_error)
            {
                data = text;
            }
        }
        if (!response.ok && !options.allowedStatuses?.includes(response.status))
        {
            const message = data && "object" === typeof data ? data.message : data;
            throw new Error(`Gitee API 请求失败（HTTP ${response.status}）：${message || "未知错误"}`);
        }
        return { response, data };
    }

    repositoryPath(suffix)
    {
        return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repository)}${suffix}`;
    }

    async triggerMirrorPull()
    {
        const result = await this.request("POST", this.repositoryPath("/remote_mirror/pull"), {
            allowedStatuses: [400, 404, 409, 422]
        });
        if (result.response.ok)
        {
            console.log("已请求 Gitee 拉取 GitHub 仓库镜像");
            return true;
        }
        console.warn(`Gitee 镜像拉取请求未被接受（HTTP ${result.response.status}），继续等待现有镜像任务`);
        return false;
    }

    async waitForTag(tagName, attempts, intervalMilliseconds, sleep = delay)
    {
        for (let attempt = 1; attempt <= attempts; attempt++)
        {
            const { data } = await this.request(
                "GET",
                this.repositoryPath("/tags?sort=updated&direction=desc&per_page=100&page=1")
            );
            if (Array.isArray(data) && data.some((tag) => tagName === tag.name))
            {
                return;
            }
            if (attempt < attempts)
            {
                console.log(`等待 Gitee 同步标签 ${tagName}（${attempt}/${attempts}）…`);
                await sleep(intervalMilliseconds);
            }
        }
        throw new Error(`Gitee 在等待时间内未同步标签 ${tagName}，请检查仓库镜像状态后重试工作流`);
    }

    async synchronizeRelease(release)
    {
        const tagPath = this.repositoryPath(`/releases/tags/${encodeURIComponent(release.tagName)}`);
        const lookup = await this.request("GET", tagPath, { allowedStatuses: [404] });
        const requestBody = JSON.stringify({
            tag_name: release.tagName,
            target_commitish: release.targetCommitish,
            name: release.name,
            body: release.body,
            prerelease: release.prerelease
        });
        const headers = { "Content-Type": "application/json" };

        if (
            404 === lookup.response.status
            || !lookup.data
            || !Number.isInteger(Number(lookup.data.id))
        )
        {
            const created = await this.request("POST", this.repositoryPath("/releases"), {
                headers,
                body: requestBody
            });
            return created.data;
        }

        const updated = await this.request(
            "PATCH",
            this.repositoryPath(`/releases/${lookup.data.id}`),
            { headers, body: requestBody }
        );
        return updated.data;
    }

    async uploadMissingAssets(releaseId, filePaths)
    {
        const assetsPath = this.repositoryPath(`/releases/${releaseId}/attach_files`);
        const { data } = await this.request("GET", `${assetsPath}?per_page=100&page=1`);
        const existingNames = new Set(Array.isArray(data) ? data.map((asset) => asset.name) : []);

        for (const filePath of filePaths)
        {
            const fileName = path.basename(filePath);
            if (existingNames.has(fileName))
            {
                console.log(`Gitee Release 已存在附件，跳过：${fileName}`);
                continue;
            }
            await this.uploadImplementation({
                token: this.token,
                url: `${GITEE_API_BASE}${assetsPath}`,
                filePath
            });
            console.log(`已上传 Gitee Release 附件：${fileName}`);
        }
    }
}

function releaseFromEvent(event)
{
    const release = event && (event.release || event);
    if (!release)
    {
        throw new Error("GitHub Release 事件缺少 release 数据");
    }
    return {
        tagName: release.tag_name,
        targetCommitish: release.target_commitish || "main",
        name: release.name || release.tag_name,
        body: release.body || "",
        prerelease: true === release.prerelease
    };
}

async function run(environment = process.env, dependencies = {})
{
    const eventPath = environment.RELEASE_EVENT_PATH || environment.GITHUB_EVENT_PATH;
    if (!eventPath)
    {
        throw new Error("缺少 RELEASE_EVENT_PATH 或 GITHUB_EVENT_PATH");
    }
    const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    const release = releaseFromEvent(event);
    const assetsDirectory = path.resolve(environment.RELEASE_ASSETS_DIR || "release-assets");
    const filePaths = findRequiredAssets(assetsDirectory, release.tagName);
    const client = new GiteeClient(
        environment.GITEE_TOKEN,
        environment.GITEE_OWNER,
        environment.GITEE_REPO,
        dependencies.fetchImplementation
    );
    const attempts = positiveInteger(
        environment.GITEE_TAG_WAIT_ATTEMPTS,
        DEFAULT_TAG_WAIT_ATTEMPTS
    );
    const intervalMilliseconds = positiveInteger(
        environment.GITEE_TAG_WAIT_INTERVAL_MS,
        DEFAULT_TAG_WAIT_INTERVAL_MS
    );

    await client.triggerMirrorPull();
    await client.waitForTag(
        release.tagName,
        attempts,
        intervalMilliseconds,
        dependencies.sleep
    );
    const synchronized = await client.synchronizeRelease(release);
    if (!synchronized || !Number.isInteger(Number(synchronized.id)))
    {
        throw new Error("Gitee Release 创建或更新后未返回有效 ID");
    }
    await client.uploadMissingAssets(Number(synchronized.id), filePaths);
    console.log(`Gitee Release ${release.tagName} 同步完成`);
}

if (require.main === module)
{
    run().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    findRequiredAssets,
    GiteeClient,
    positiveInteger,
    releaseFromEvent,
    requiredAssetNames,
    run,
    uploadFileWithHttps,
    versionFromTag
};
