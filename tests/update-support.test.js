"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
    dependencyStatus,
    ensureDependencies,
    packageLockHash,
    writeDependencyStamp
} = require("../scripts/dependency-bootstrap");
const {
    compareVersions,
    downloadRelease,
    fetchLatestRelease,
    parseChecksum
} = require("../src/release-updater");

test("dependency bootstrap detects a changed package lock and stamps installed state", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pet-dependencies-"));
    try
    {
        fs.mkdirSync(path.join(directory, "node_modules", "demo"), { recursive: true });
        fs.writeFileSync(
            path.join(directory, "package.json"),
            JSON.stringify({ dependencies: { demo: "1.0.0" } })
        );
        fs.writeFileSync(path.join(directory, "package-lock.json"), "{\"lockfileVersion\":3}");
        fs.writeFileSync(path.join(directory, "node_modules", "demo", "package.json"), "{\"name\":\"demo\"}");
        assert.equal(dependencyStatus(directory).current, false);
        writeDependencyStamp(directory);
        assert.equal(dependencyStatus(directory).current, true);
        fs.writeFileSync(path.join(directory, "package-lock.json"), "{\"lockfileVersion\":3,\"changed\":true}");
        assert.equal(dependencyStatus(directory).current, false);
        assert.equal(packageLockHash(directory).length, 64);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("dependency bootstrap runs npm ci only when dependencies are stale", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pet-dependencies-run-"));
    try
    {
        fs.writeFileSync(path.join(directory, "package.json"), "{\"dependencies\":{}}");
        fs.writeFileSync(path.join(directory, "package-lock.json"), "{\"lockfileVersion\":3}");
        const calls = [];
        const result = ensureDependencies(directory, (command, args, options) => {
            calls.push({ command, args, options });
            writeDependencyStamp(directory);
            return { status: 0 };
        });
        assert.equal(result.installed, true);
        assert.equal(calls.length, 1);
        if ("win32" === process.platform)
        {
            assert.deepEqual(calls[0].args, ["/d", "/s", "/c", "npm.cmd ci --no-audit --no-fund"]);
        }
        else
        {
            assert.deepEqual(calls[0].args, ["ci", "--no-audit", "--no-fund"]);
        }
        assert.equal(calls[0].options.shell, false);
        assert.equal(ensureDependencies(directory).installed, false);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("release updater compares versions and selects a newer portable release", async () => {
    assert.equal(compareVersions("0.6.0", "0.5.9"), 1);
    assert.equal(compareVersions("0.5.0", "0.5.0"), 0);
    assert.equal(compareVersions("0.4.9", "0.5.0"), -1);
    const release = {
        tag_name: "v0.6.0",
        name: "Agent Pet v0.6.0",
        html_url: "https://github.com/fcb1379/agent-pet/releases/tag/v0.6.0",
        assets: [
            {
                name: "AgentPet-0.6.0-portable.exe",
                browser_download_url: "https://example.test/update.exe"
            },
            {
                name: "AgentPet-0.6.0-portable.exe.sha256",
                browser_download_url: "https://example.test/update.exe.sha256"
            }
        ]
    };
    const update = await fetchLatestRelease(
        async () => new Response(JSON.stringify(release), {
            status: 200,
            headers: { "content-type": "application/json" }
        }),
        "0.5.0"
    );
    assert.equal(update.updateAvailable, true);
    assert.equal(update.executable.name, "AgentPet-0.6.0-portable.exe");
});

test("release updater downloads and verifies the portable executable", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pet-update-"));
    try
    {
        const executable = Buffer.from("verified-agent-pet-update");
        const hash = require("node:crypto").createHash("sha256").update(executable).digest("hex");
        const update = {
            executable: { name: "AgentPet-0.6.0-portable.exe", url: "https://example.test/update.exe" },
            checksum: { name: "AgentPet-0.6.0-portable.exe.sha256", url: "https://example.test/update.exe.sha256" }
        };
        const result = await downloadRelease(
            async (url) => url.endsWith(".sha256")
                ? new Response(`${hash}  AgentPet-0.6.0-portable.exe`)
                : new Response(executable, { headers: { "content-length": String(executable.length) } }),
            update,
            directory
        );
        assert.equal(result.sha256, hash.toUpperCase());
        assert.deepEqual(fs.readFileSync(result.destinationPath), executable);
        assert.equal(
            parseChecksum(`${hash}  AgentPet-0.6.0-portable.exe`, "AgentPet-0.6.0-portable.exe"),
            hash.toUpperCase()
        );
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
