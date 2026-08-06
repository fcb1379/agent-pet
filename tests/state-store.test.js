"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { StateStore, effectiveState, selectAggregate } = require("../src/state-store");
const { messageFor, normalizeEvent, shouldPreserveFinalState, windowsPathToWsl } = require("../bridge/agent-pet-bridge");

test("aggregate chooses the highest-priority active state", () => {
    const now = Date.now();
    const sessions = [
        { state: "running", updatedAt: new Date(now).toISOString() },
        { state: "needs_input", updatedAt: new Date(now).toISOString() },
        { state: "completed", updatedAt: new Date(now).toISOString() }
    ];

    assert.equal(selectAggregate(sessions, now).state, "needs_input");
});

test("a recent completion is visible above another running session", () => {
    const now = Date.now();
    const sessions = [
        { state: "running", updatedAt: new Date(now).toISOString() },
        { state: "completed", updatedAt: new Date(now).toISOString() }
    ];

    assert.equal(selectAggregate(sessions, now).state, "completed");
});

test("completed state returns to idle after its display lifetime", () => {
    const now = Date.now();
    const session = {
        state: "completed",
        updatedAt: new Date(now - 16000).toISOString()
    };

    assert.equal(effectiveState(session, now), "idle");
});

test("stale input requests return to idle so closed sessions can be cleaned", () => {
    const now = Date.now();
    const session = {
        state: "needs_input",
        updatedAt: new Date(now - (6 * 60 * 60 * 1000) - 1).toISOString()
    };

    assert.equal(effectiveState(session, now), "idle");
});

test("maps Codex and Claude lifecycle events", () => {
    assert.equal(normalizeEvent("UserPromptSubmit", {}), "running");
    assert.equal(normalizeEvent("PermissionRequest", {}), "needs_input");
    assert.equal(normalizeEvent("Notification", { notification_type: "idle_prompt" }), "needs_input");
    assert.equal(normalizeEvent("Stop", {}), "completed");
    assert.equal(normalizeEvent("StopFailure", {}), "error");
    assert.equal(normalizeEvent("SessionEnd", {}), "idle");
});

test("session end preserves a recent completion but not an old one", () => {
    const now = Date.now();
    assert.equal(shouldPreserveFinalState({
        state: "completed",
        updatedAt: new Date(now - 1000).toISOString()
    }, "idle", now), true);
    assert.equal(shouldPreserveFinalState({
        state: "completed",
        updatedAt: new Date(now - 16000).toISOString()
    }, "idle", now), false);
});

test("converts a Windows local app data path to WSL", () => {
    assert.equal(
        windowsPathToWsl("C:\\Users\\woan\\AppData\\Local"),
        "/mnt/c/Users/woan/AppData/Local"
    );
});

test("submitted prompts become concise session progress summaries", () => {
    assert.equal(messageFor("running", { prompt: "检查   当前工程的构建错误" }), "任务：检查 当前工程的构建错误");
    assert.ok(messageFor("running", { prompt: "x".repeat(400) }).length <= 403);
});
test("finished sessions can be removed without touching active sessions", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pet-state-"));
    const now = Date.now();
    try
    {
        fs.writeFileSync(path.join(directory, "done.json"), JSON.stringify({ id: "done", state: "completed", updatedAt: new Date(now).toISOString() }));
        fs.writeFileSync(path.join(directory, "active.json"), JSON.stringify({ id: "active", state: "running", updatedAt: new Date(now).toISOString() }));
        fs.writeFileSync(path.join(directory, "input.json"), JSON.stringify({ id: "input", state: "needs_input", updatedAt: new Date(now).toISOString() }));
        const store = new StateStore(directory);
        assert.equal(store.remove("../escape"), false);
        assert.equal(store.clearFinished(now), 1);
        assert.equal(fs.existsSync(path.join(directory, "done.json")), false);
        assert.equal(fs.existsSync(path.join(directory, "active.json")), true);
        assert.equal(fs.existsSync(path.join(directory, "input.json")), true);
        assert.equal(store.remove("active"), true);
        assert.equal(fs.existsSync(path.join(directory, "active.json")), false);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("approval waits return to running after the request is handled outside Agent Pet", () => {
    const now = Date.now();
    const session = {
        state: "needs_input",
        approvalId: "approval-1",
        updatedAt: new Date(now).toISOString()
    };

    assert.equal(effectiveState(session, now, new Set(["approval-1"])), "needs_input");
    assert.equal(effectiveState(session, now, new Set()), "running");
    assert.equal(effectiveState(session, now), "needs_input");
});

test("text input waits remain pending when approval requests change", () => {
    const now = Date.now();
    const session = {
        state: "needs_input",
        updatedAt: new Date(now).toISOString()
    };

    assert.equal(effectiveState(session, now, new Set()), "needs_input");
});

test("state store refreshes approval-backed sessions when requests disappear", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pet-state-"));
    const now = Date.now();
    try
    {
        fs.writeFileSync(path.join(directory, "input.json"), JSON.stringify({
            id: "input",
            state: "needs_input",
            approvalId: "approval-1",
            updatedAt: new Date(now).toISOString()
        }));
        const store = new StateStore(directory);
        const snapshots = [];
        store.on("change", (snapshot) => snapshots.push(snapshot));

        store.setApprovalRequests([{ id: "approval-1" }]);
        assert.equal(snapshots.at(-1).state, "needs_input");

        store.setApprovalRequests([]);
        assert.equal(snapshots.at(-1).state, "running");
        assert.equal(snapshots.at(-1).sessions[0].approvalId, undefined);
        assert.equal(snapshots.at(-1).sessions[0].message, "授权请求已在原会话处理，继续执行中");
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
