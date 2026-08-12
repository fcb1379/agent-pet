"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");
const {
    downloadVerifiedFile,
    pruneRuntimeExecutables,
    runtimeIsComplete,
    runtimeManifest,
    runtimePaths
} = require("../src/stt-runtime-installer");

function temporaryDirectory()
{
    return fs.mkdtempSync(path.join(os.tmpdir(), "agent-pet-stt-installer-"));
}

function responseFor(value)
{
    const body = Buffer.from(value);
    return {
        ok: true,
        status: 200,
        headers: { get: (name) => "content-length" === name ? String(body.length) : null },
        body: Readable.from([body])
    };
}

test("Windows launch and packaging automatically prepare the STT runtime", () => {
    const manifest = require("../package.json");
    assert.equal(manifest.scripts.prestart, "node scripts/prepare-launch.js");
    assert.equal(manifest.scripts.predev, "node scripts/prepare-launch.js");
    assert.equal(manifest.scripts["predist:win"], "node scripts/prepare-stt-runtime.js");
    assert.equal(manifest.build.win.extraResources.some((resource) =>
        "vendor/stt" === resource.from && "stt" === resource.to), true);
    assert.equal(manifest.dependencies["ogg-opus-decoder"], "^1.7.3");
});

test("STT runtime completeness requires its pinned manifest and files", () => {
    const root = temporaryDirectory();
    try
    {
        const paths = runtimePaths(root);
        fs.mkdirSync(path.dirname(paths.server), { recursive: true });
        fs.mkdirSync(path.dirname(paths.model), { recursive: true });
        fs.writeFileSync(paths.server, "server");
        fs.writeFileSync(paths.model, "model");
        fs.writeFileSync(paths.manifest, JSON.stringify(runtimeManifest()));
        assert.equal(runtimeIsComplete(root), true);

        fs.writeFileSync(paths.manifest, JSON.stringify({ ...runtimeManifest(), runtimeVersion: "other" }));
        assert.equal(runtimeIsComplete(root), false);
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("STT runtime packaging keeps only the required server executable", () => {
    const root = temporaryDirectory();
    try
    {
        const release = path.join(root, "Release");
        fs.mkdirSync(release, { recursive: true });
        fs.writeFileSync(path.join(release, "whisper-server.exe"), "server");
        fs.writeFileSync(path.join(release, "whisper-cli.exe"), "cli");
        fs.writeFileSync(path.join(release, "whisper.dll"), "dll");

        assert.deepEqual(pruneRuntimeExecutables(root), ["whisper-cli.exe"]);
        assert.equal(fs.existsSync(path.join(release, "whisper-server.exe")), true);
        assert.equal(fs.existsSync(path.join(release, "whisper.dll")), true);
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("STT downloads are streamed, reported and checksum verified", async () => {
    const root = temporaryDirectory();
    const destination = path.join(root, "asset.bin");
    const content = Buffer.from("verified speech runtime");
    const expectedHash = crypto.createHash("sha256").update(content).digest("hex");
    const progress = [];
    try
    {
        const result = await downloadVerifiedFile("https://example.invalid/asset", destination, {
            algorithm: "sha256",
            expectedHash,
            fetch: async () => responseFor(content),
            onProgress: (update) => progress.push(update)
        });
        assert.deepEqual(fs.readFileSync(destination), content);
        assert.equal(result.hash, expectedHash);
        assert.equal(progress.at(-1).receivedBytes, content.length);
        assert.equal(progress.at(-1).totalBytes, content.length);
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("STT checksum failures do not leave a usable asset", async () => {
    const root = temporaryDirectory();
    const destination = path.join(root, "asset.bin");
    try
    {
        await assert.rejects(downloadVerifiedFile("https://example.invalid/asset", destination, {
            algorithm: "sha1",
            expectedHash: "0000000000000000000000000000000000000000",
            fetch: async () => responseFor("tampered")
        }), /校验失败/);
        assert.equal(fs.existsSync(destination), false);
        assert.equal(fs.existsSync(`${destination}.tmp`), false);
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
