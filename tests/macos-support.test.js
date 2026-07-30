"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
    agentDataDirectory,
    approvalDirectory,
    platformLabel,
    stateDirectory
} = require("../bridge/platform-paths");
const { installNodeRuntime } = require("../scripts/install-hooks");
const { releaseAssetNames, selectReleaseAssets } = require("../src/release-updater");

function portablePath(value)
{
    return String(value).replaceAll("\\", "/");
}

test("macOS uses one shared Agent Pet data directory", () => {
    const options = {
        platform: "darwin",
        environment: {},
        homeDirectory: "/Users/tester"
    };
    assert.equal(
        portablePath(agentDataDirectory(options)),
        "/Users/tester/Library/Application Support/AgentPet"
    );
    assert.equal(
        portablePath(stateDirectory(options)),
        "/Users/tester/Library/Application Support/AgentPet/states"
    );
    assert.equal(
        portablePath(approvalDirectory(options)),
        "/Users/tester/Library/Application Support/AgentPet/approvals"
    );
    assert.equal(platformLabel("darwin"), "macOS");
});

test("macOS hook runtime launches the packaged Electron binary as Node", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pet-mac-runtime-"));
    try
    {
        const executable = "/Applications/Agent Pet.app/Contents/MacOS/Agent Pet";
        const runtime = installNodeRuntime(directory, executable, "darwin");
        const script = fs.readFileSync(runtime, "utf8");
        assert.match(script, /^#!\/bin\/sh/);
        assert.match(script, /ELECTRON_RUN_AS_NODE=1/);
        assert.match(script, /'\/Applications\/Agent Pet\.app\/Contents\/MacOS\/Agent Pet'/);
        assert.match(script, /"\$@"/);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("release updater selects the Apple Silicon DMG", () => {
    assert.deepEqual(
        releaseAssetNames("0.6.0", "darwin", "arm64"),
        { executableName: "AgentPet-0.6.0-mac-arm64.dmg" }
    );
    const selected = selectReleaseAssets({
        tag_name: "v0.6.0",
        assets: [
            {
                name: "AgentPet-0.6.0-mac-arm64.dmg",
                browser_download_url: "https://example.test/AgentPet.dmg"
            },
            {
                name: "AgentPet-0.6.0-mac-arm64.dmg.sha256",
                browser_download_url: "https://example.test/AgentPet.dmg.sha256"
            }
        ]
    }, "darwin", "arm64");
    assert.equal(selected.executable.name, "AgentPet-0.6.0-mac-arm64.dmg");
    assert.throws(
        () => releaseAssetNames("0.6.0", "darwin", "x64"),
        /暂不提供 macOS x64/
    );
});
