"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const {
    runtimeManifest,
    runtimePaths
} = require("../src/stt-runtime-installer");
const { SttRuntimeManager } = require("../src/stt-runtime-manager");

function completeRuntime(root)
{
    const paths = runtimePaths(root);
    fs.mkdirSync(path.dirname(paths.server), { recursive: true });
    fs.mkdirSync(path.dirname(paths.model), { recursive: true });
    fs.writeFileSync(paths.server, "server");
    fs.writeFileSync(paths.model, "model");
    fs.writeFileSync(paths.manifest, JSON.stringify(runtimeManifest()));
    return paths;
}

function fakeChild()
{
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
        child.killed = true;
        child.emit("exit", 0, null);
    };
    return child;
}

function nextTurn()
{
    return new Promise((resolve) => setImmediate(resolve));
}

test("STT manager launches the bundled server on a private dynamic port", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pet-stt-manager-"));
    const bundled = completeRuntime(path.join(root, "resources", "stt"));
    const children = [];
    const calls = [];
    try
    {
        const manager = new SttRuntimeManager({
            resourcesPath: path.join(root, "resources"),
            developmentRoot: path.join(root, "development"),
            userDataPath: path.join(root, "user-data"),
            portProvider: async () => 23145,
            probe: async () => true,
            delay: async () => {},
            spawn: (command, args, options) => {
                calls.push({ command, args, options });
                const child = fakeChild();
                children.push(child);
                return child;
            }
        });

        const status = await manager.start();
        assert.equal(status.ready, true);
        assert.equal(status.endpoint, "http://127.0.0.1:23145/inference");
        assert.equal(calls[0].command, bundled.server);
        assert.deepEqual(calls[0].args.slice(0, 6), [
            "--model", bundled.model,
            "--host", "127.0.0.1",
            "--port", "23145"
        ]);
        assert.equal(calls[0].args.includes("--language"), true);
        assert.equal(calls[0].args.includes("--no-gpu"), true);
        assert.equal(calls[0].options.windowsHide, true);

        manager.stop();
        assert.equal(children[0].killed, true);
        assert.equal(manager.currentStatus().status, "idle");
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("STT manager automatically restarts an unexpectedly exited server", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pet-stt-restart-"));
    completeRuntime(path.join(root, "resources", "stt"));
    const children = [];
    let restartCallback = null;
    try
    {
        const manager = new SttRuntimeManager({
            resourcesPath: path.join(root, "resources"),
            developmentRoot: path.join(root, "development"),
            userDataPath: path.join(root, "user-data"),
            portProvider: async () => 23146 + children.length,
            probe: async () => true,
            delay: async () => {},
            setTimeout: (callback) => {
                restartCallback = callback;
                return 1;
            },
            clearTimeout: () => {},
            spawn: () => {
                const child = fakeChild();
                children.push(child);
                return child;
            }
        });

        await manager.start();
        children[0].emit("exit", 1, null);
        assert.equal(manager.currentStatus().status, "restarting");
        assert.equal("function", typeof restartCallback);
        restartCallback();
        await nextTurn();
        await nextTurn();

        assert.equal(children.length, 2);
        assert.equal(manager.isReady(), true);
        manager.stop();
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
