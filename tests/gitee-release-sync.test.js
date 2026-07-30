"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
    findRequiredAssets,
    GiteeClient,
    releaseFromEvent,
    requiredAssetNames
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
    try
    {
        const client = new GiteeClient("token", "reussss", "agent-pet", async (url, options) => {
            requests.push({ url, options });
            return "GET" === options.method
                ? jsonResponse([{ name: path.basename(executable) }])
                : jsonResponse({ id: 9, name: path.basename(checksum) }, 201);
        });
        await client.uploadMissingAssets(123, [executable, checksum]);
        const uploads = requests.filter((request) => "POST" === request.options.method);
        assert.equal(uploads.length, 1);
        assert.ok(uploads[0].options.body instanceof FormData);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
