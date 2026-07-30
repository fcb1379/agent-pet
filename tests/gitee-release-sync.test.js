"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough, Readable, Writable } = require("node:stream");
const test = require("node:test");
const {
    findRequiredAssets,
    GiteeClient,
    releaseFromEvent,
    requiredAssetNames,
    uploadFileWithCurl,
    uploadFileWithHttps
} = require("../scripts/sync-gitee-release");

function jsonResponse(value, status = 200)
{
    return new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" }
    });
}

test("Gitee release sync derives and validates required asset names", () => {
    assert.deepEqual(requiredAssetNames("v0.6.0"), [
        "AgentPet-0.6.0-portable.exe",
        "AgentPet-0.6.0-portable.exe.sha256"
    ]);
    assert.throws(() => requiredAssetNames("latest"), /不支持的 Release 标签/);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pet-gitee-assets-"));
    try
    {
        for (const name of requiredAssetNames("v0.6.0"))
        {
            fs.writeFileSync(path.join(directory, name), name);
        }
        assert.equal(findRequiredAssets(directory, "v0.6.0").length, 2);
        fs.rmSync(path.join(directory, "AgentPet-0.6.0-portable.exe.sha256"));
        assert.throws(() => findRequiredAssets(directory, "v0.6.0"), /缺少 GitHub Release 附件/);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("Gitee release sync reads GitHub release metadata", () => {
    assert.deepEqual(releaseFromEvent({
        release: {
            tag_name: "v0.6.0",
            target_commitish: "main",
            name: "Agent Pet v0.6.0",
            body: "changes",
            prerelease: false
        }
    }), {
        tagName: "v0.6.0",
        targetCommitish: "main",
        name: "Agent Pet v0.6.0",
        body: "changes",
        prerelease: false
    });
    assert.equal(releaseFromEvent({
        tag_name: "v0.6.0",
        target_commitish: "main",
        name: "Agent Pet v0.6.0",
        body: "changes",
        prerelease: false
    }).tagName, "v0.6.0");
});

test("Gitee release sync requests a remote mirror pull", async () => {
    const requests = [];
    const client = new GiteeClient("token", "reussss", "agent-pet", async (url, options) => {
        requests.push({ url, options });
        return jsonResponse({ message: "pulling" }, 202);
    });
    assert.equal(await client.triggerMirrorPull(), true);
    assert.equal(requests[0].options.method, "POST");
    assert.match(requests[0].url, /\/remote_mirror\/pull$/);
});

test("Gitee release sync waits for the mirrored tag", async () => {
    let calls = 0;
    const client = new GiteeClient("token", "reussss", "agent-pet", async () => {
        calls++;
        return jsonResponse(2 === calls ? [{ name: "v0.6.0" }] : []);
    });
    let sleeps = 0;
    await client.waitForTag("v0.6.0", 2, 1, async () => {
        sleeps++;
    });
    assert.equal(calls, 2);
    assert.equal(sleeps, 1);
});

test("Gitee release sync creates a missing release", async () => {
    const requests = [];
    const client = new GiteeClient("token", "reussss", "agent-pet", async (url, options) => {
        requests.push({ url, options });
        return "GET" === options.method
            ? jsonResponse({ message: "404 Not Found" }, 404)
            : jsonResponse({ id: 123, tag_name: "v0.6.0" }, 201);
    });
    const release = await client.synchronizeRelease({
        tagName: "v0.6.0",
        targetCommitish: "main",
        name: "Agent Pet v0.6.0",
        body: "changes",
        prerelease: false
    });
    assert.equal(release.id, 123);
    assert.equal(requests[1].options.method, "POST");
    assert.equal(JSON.parse(requests[1].options.body).tag_name, "v0.6.0");
    assert.equal(requests[1].options.headers.Authorization, "Bearer token");
});

test("Gitee release sync treats a null tag lookup as a missing release", async () => {
    const requests = [];
    const client = new GiteeClient("token", "reussss", "agent-pet", async (url, options) => {
        requests.push({ url, options });
        return "GET" === options.method
            ? jsonResponse(null)
            : jsonResponse({ id: 456, tag_name: "v0.6.0" }, 201);
    });
    const release = await client.synchronizeRelease({
        tagName: "v0.6.0",
        targetCommitish: "main",
        name: "Agent Pet v0.6.0",
        body: "changes",
        prerelease: false
    });
    assert.equal(release.id, 456);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].options.method, "POST");
});

test("Gitee release sync skips existing assets and uploads missing assets", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pet-gitee-upload-"));
    const executable = path.join(directory, "AgentPet-0.6.0-portable.exe");
    const checksum = `${executable}.sha256`;
    fs.writeFileSync(executable, "exe");
    fs.writeFileSync(checksum, "checksum");
    const requests = [];
    const uploads = [];
    try
    {
        const client = new GiteeClient("token", "reussss", "agent-pet", async (url, options) => {
            requests.push({ url, options });
            return jsonResponse([{ name: path.basename(executable) }]);
        }, async (options) => {
            uploads.push(options);
        });
        await client.uploadMissingAssets(123, [executable, checksum]);
        assert.equal(uploads.length, 1);
        assert.equal(uploads[0].token, "token");
        assert.equal(uploads[0].filePath, checksum);
        assert.equal(uploads[0].owner, "reussss");
        assert.equal(uploads[0].repository, "agent-pet");
        assert.equal(uploads[0].releaseId, 123);
        assert.match(uploads[0].url, /\/releases\/123\/attach_files$/);
        assert.equal(requests.length, 1);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("Gitee release sync streams multipart uploads without fetch", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pet-gitee-stream-"));
    const filePath = path.join(directory, "AgentPet-0.6.0-portable.exe");
    const chunks = [];
    let requestOptions;
    fs.writeFileSync(filePath, "portable executable");
    try
    {
        await uploadFileWithHttps({
            token: "token",
            url: "https://gitee.com/api/v5/repos/reussss/agent-pet/releases/123/attach_files",
            owner: "reussss",
            repository: "agent-pet",
            releaseId: 123,
            filePath
        }, (url, options, callback) => {
            assert.match(url, /^https:\/\/gitee\.com\/api\/v5\//);
            requestOptions = options;
            const request = new Writable({
                write(chunk, _encoding, done)
                {
                    chunks.push(Buffer.from(chunk));
                    done();
                }
            });
            request.on("finish", () => {
                const response = Readable.from(["{\"id\":9}"]);
                response.statusCode = 201;
                callback(response);
            });
            return request;
        });

        const body = Buffer.concat(chunks);
        assert.equal(requestOptions.method, "POST");
        assert.equal(requestOptions.headers.Authorization, "Bearer token");
        assert.equal(Number(requestOptions.headers["Content-Length"]), body.length);
        assert.match(
            requestOptions.headers["Content-Type"],
            /^multipart\/form-data; boundary=/
        );
        assert.match(body.toString(), /filename="AgentPet-0\.6\.0-portable\.exe"/);
        assert.match(body.toString(), /name="access_token"\r\n\r\ntoken\r\n/);
        assert.match(body.toString(), /name="owner"\r\n\r\nreussss\r\n/);
        assert.match(body.toString(), /name="repo"\r\n\r\nagent-pet\r\n/);
        assert.match(body.toString(), /name="release_id"\r\n\r\n123\r\n/);
        assert.match(body.toString(), /portable executable/);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("Gitee release sync invokes curl with the official multipart fields", async () => {
    let command;
    let argumentsList;
    let spawnOptions;
    await uploadFileWithCurl({
        token: "token",
        url: "https://gitee.com/api/v5/repos/reussss/agent-pet/releases/123/attach_files",
        owner: "reussss",
        repository: "agent-pet",
        releaseId: 123,
        filePath: "/tmp/AgentPet-0.6.0-portable.exe"
    }, (executable, argumentsValue, options) => {
        command = executable;
        argumentsList = argumentsValue;
        spawnOptions = options;
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        process.nextTick(() => {
            child.stdout.end("{\"id\":9}");
            child.emit("close", 0, null);
        });
        return child;
    });

    assert.equal(command, "curl");
    assert.deepEqual(spawnOptions.stdio, ["ignore", "pipe", "inherit"]);
    assert.ok(argumentsList.includes("access_token=token"));
    assert.ok(argumentsList.includes("owner=reussss"));
    assert.ok(argumentsList.includes("repo=agent-pet"));
    assert.ok(argumentsList.includes("release_id=123"));
    assert.ok(argumentsList.includes("file=@/tmp/AgentPet-0.6.0-portable.exe"));
    assert.equal(
        argumentsList.at(-1),
        "https://gitee.com/api/v5/repos/reussss/agent-pet/releases/123/attach_files"
    );
});
