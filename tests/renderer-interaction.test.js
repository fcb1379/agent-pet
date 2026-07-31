"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const rendererDirectory = path.join(__dirname, "..", "src", "renderer");

test("status bubble remains a native window drag handle", () => {
    const styles = fs.readFileSync(path.join(rendererDirectory, "styles.css"), "utf8");
    const rule = styles.match(/#speech-bubble\s*\{([^}]+)\}/);

    assert.ok(rule, "missing #speech-bubble CSS rule");
    assert.match(rule[1], /-webkit-app-region:\s*drag/);
});

test("wooden fish pointer policy loads before pointer tracking", () => {
    const html = fs.readFileSync(path.join(rendererDirectory, "index.html"), "utf8");

    assert.ok(
        html.indexOf("pointer-hit-policy.js") < html.indexOf("pointer-hit.js"),
        "pointer policy must load before pointer tracking"
    );
});

test("session header actions opt out of the native drag region", () => {
    const styles = fs.readFileSync(path.join(rendererDirectory, "styles.css"), "utf8");
    const rule = styles.match(/\.session-header-actions\s*\{([^}]+)\}/);

    assert.ok(rule, "missing .session-header-actions CSS rule");
    assert.match(rule[1], /-webkit-app-region:\s*no-drag/);
});
