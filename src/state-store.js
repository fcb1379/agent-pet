"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const STATE_PRIORITY = Object.freeze({
    needs_input: 5,
    error: 4,
    completed: 3,
    running: 2,
    idle: 1
});

const COMPLETED_LIFETIME_MS = 15000;
const ERROR_LIFETIME_MS = 60000;
const ACTIVE_STALE_MS = 6 * 60 * 60 * 1000;
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{1,120}$/;
const DISMISSIBLE_STATES = new Set(["idle", "completed", "error"]);

function effectiveState(session, now = Date.now(), activeApprovalIds = null)
{
    const updatedAt = Date.parse(session.updatedAt || "");
    const age = Number.isFinite(updatedAt) ? now - updatedAt : Number.POSITIVE_INFINITY;

    if (
        "needs_input" === session.state &&
        session.approvalId &&
        activeApprovalIds instanceof Set &&
        !activeApprovalIds.has(session.approvalId)
    )
    {
        return "running";
    }

    if ("completed" === session.state && age > COMPLETED_LIFETIME_MS)
    {
        return "idle";
    }

    if ("error" === session.state && age > ERROR_LIFETIME_MS)
    {
        return "idle";
    }

    if (["running", "needs_input"].includes(session.state) && age > ACTIVE_STALE_MS)
    {
        return "idle";
    }

    return Object.hasOwn(STATE_PRIORITY, session.state) ? session.state : "idle";
}

function selectAggregate(sessions, now = Date.now(), activeApprovalIds = null)
{
    const normalized = sessions.map((session) => {
        const state = effectiveState(session, now, activeApprovalIds);
        if ("running" === state && "needs_input" === session.state && session.approvalId)
        {
            return {
                ...session,
                approvalId: undefined,
                state,
                event: "PermissionRequest:external",
                message: "授权请求已在原会话处理，继续执行中"
            };
        }

        return { ...session, state };
    });

    normalized.sort((left, right) => {
        const priorityDelta = STATE_PRIORITY[right.state] - STATE_PRIORITY[left.state];
        if (0 !== priorityDelta)
        {
            return priorityDelta;
        }

        return Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0);
    });

    const active = normalized.find((session) => "idle" !== session.state);
    const state = active ? active.state : "idle";

    return {
        state,
        active: active || null,
        sessions: normalized,
        counts: normalized.reduce((counts, session) => {
            counts[session.state] = (counts[session.state] || 0) + 1;
            return counts;
        }, {})
    };
}

class StateStore extends EventEmitter
{
    constructor(stateDirectory)
    {
        super();
        this.stateDirectory = stateDirectory;
        this.fileWatcher = null;
        this.refreshTimer = null;
        this.lastSnapshot = "";
        this.activeApprovalIds = null;
    }

    start()
    {
        fs.mkdirSync(this.stateDirectory, { recursive: true });
        this.refresh();
        this.fileWatcher = fs.watch(this.stateDirectory, () => this.refresh());
        this.refreshTimer = setInterval(() => this.refresh(), 1000);
    }

    refresh()
    {
        let sessions = [];

        try
        {
            sessions = fs.readdirSync(this.stateDirectory)
                .filter((fileName) => fileName.endsWith(".json"))
                .map((fileName) => {
                    const filePath = path.join(this.stateDirectory, fileName);
                    return JSON.parse(fs.readFileSync(filePath, "utf8"));
                })
                .filter((session) => session && "object" === typeof session);
        }
        catch (error)
        {
            sessions = [{
                id: "state-store",
                provider: "Agent Pet",
                source: "windows",
                state: "error",
                message: error.message,
                updatedAt: new Date().toISOString()
            }];
        }

        const snapshot = selectAggregate(sessions, Date.now(), this.activeApprovalIds);
        const serialized = JSON.stringify(snapshot);

        if (serialized !== this.lastSnapshot)
        {
            this.lastSnapshot = serialized;
            this.emit("change", snapshot);
        }
    }

    setApprovalRequests(requests)
    {
        this.activeApprovalIds = new Set(
            (Array.isArray(requests) ? requests : [])
                .map((request) => String(request && request.id || ""))
                .filter((id) => 0 < id.length)
        );
        this.refresh();
    }

    clear()
    {
        fs.mkdirSync(this.stateDirectory, { recursive: true });
        for (const fileName of fs.readdirSync(this.stateDirectory))
        {
            if (fileName.endsWith(".json"))
            {
                fs.rmSync(path.join(this.stateDirectory, fileName), { force: true });
            }
        }
        this.refresh();
    }

    remove(sessionId)
    {
        if (!SAFE_SESSION_ID.test(String(sessionId || "")))
        {
            return false;
        }

        const filePath = path.join(this.stateDirectory, `${sessionId}.json`);
        if (!fs.existsSync(filePath))
        {
            return false;
        }

        fs.rmSync(filePath, { force: true });
        this.refresh();
        return true;
    }

    clearFinished(now = Date.now())
    {
        fs.mkdirSync(this.stateDirectory, { recursive: true });
        let removed = 0;

        for (const fileName of fs.readdirSync(this.stateDirectory))
        {
            if (!fileName.endsWith(".json"))
            {
                continue;
            }

            const filePath = path.join(this.stateDirectory, fileName);
            try
            {
                const session = JSON.parse(fs.readFileSync(filePath, "utf8"));
                if (session && DISMISSIBLE_STATES.has(effectiveState(session, now)))
                {
                    fs.rmSync(filePath, { force: true });
                    removed++;
                }
            }
            catch (_error)
            {
                // Keep unreadable files so diagnostics remain available.
            }
        }

        this.refresh();
        return removed;
    }

    stop()
    {
        if (this.fileWatcher)
        {
            this.fileWatcher.close();
        }
        if (this.refreshTimer)
        {
            clearInterval(this.refreshTimer);
        }
    }
}

module.exports = {
    StateStore,
    effectiveState,
    selectAggregate
};
