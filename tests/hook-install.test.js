"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
    CLAUDE_EVENTS,
    CODEX_EVENTS,
    addManagedHandlers,
    commandFor
} = require("../scripts/hook-config");
const {
    bundledNodeExecutable,
    resolveNodeExecutable,
    verifyInstalledBridge
} = require("../scripts/install-hooks");

test("one-click setup registers session start for Codex and Claude", () => {
    assert.ok(CODEX_EVENTS.includes("SessionStart"));
    assert.ok(CLAUDE_EVENTS.includes("SessionStart"));

    const config = addManagedHandlers(
        {},
        ["SessionStart"],
        "codex",
        "C:\\Users\\tester\\.agent-pet\\agent-pet-bridge.js",
        "C:\\Program Files\\nodejs\\node.exe"
    );
    assert.equal(
        config.hooks.SessionStart[0].hooks[0].command,
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\tester\\.agent-pet\\agent-pet-bridge.js" codex SessionStart'
    );
    assert.equal(
        commandFor("/home/tester/.agent-pet/agent-pet-bridge.js", "claude", "SessionStart", "/usr/bin/node"),
        '"/usr/bin/node" "/home/tester/.agent-pet/agent-pet-bridge.js" claude SessionStart'
    );
});
test("WSL never selects the bundled Windows Node runtime", () => {
    assert.equal(bundledNodeExecutable("linux"), null);
});


test("bridge self-test writes and removes Codex and Claude diagnostic sessions", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pet-hook-self-test-"));
    try
    {
        const result = verifyInstalledBridge({
            installedBridge: path.resolve(__dirname, "..", "bridge", "agent-pet-bridge.js"),
            nodeExecutable: resolveNodeExecutable()
        }, {
            stateDirectory: directory
        });
        assert.equal(result.stateDirectory, directory);
        assert.deepEqual(fs.readdirSync(directory), []);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});