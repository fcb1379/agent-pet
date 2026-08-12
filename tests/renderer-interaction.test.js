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
    assert.match(rule[1], /width:\s*262px/);
});

test("resource status bar expands the native window drag area", () => {
    const styles = fs.readFileSync(path.join(rendererDirectory, "styles.css"), "utf8");
    const rule = styles.match(/#resource-panel\s*\{([^}]+)\}/);

    assert.ok(rule, "missing #resource-panel CSS rule");
    assert.match(rule[1], /-webkit-app-region:\s*drag/);
});

test("clear finished sessions remains clickable inside the draggable header", () => {
    const styles = fs.readFileSync(path.join(rendererDirectory, "styles.css"), "utf8");
    const rule = styles.match(/#clear-finished-sessions\s*\{([^}]+)\}/);

    assert.ok(rule, "missing #clear-finished-sessions CSS rule");
    assert.match(rule[1], /-webkit-app-region:\s*no-drag/);
});

test("active manual drag is not cancelled when the pointer leaves the window", () => {
    const script = fs.readFileSync(path.join(rendererDirectory, "pointer-hit.js"), "utf8");
    const mouseoutHandler = script.match(/window\.addEventListener\("mouseout",[\s\S]+?\n    \}\);/);

    assert.ok(mouseoutHandler, "missing pointer mouseout handler");
    assert.match(mouseoutHandler[0], /if \(dragActive\)[\s\S]+publish\(true\)/);
});

test("wooden fish pointer policy loads before pointer tracking", () => {
    const html = fs.readFileSync(path.join(rendererDirectory, "index.html"), "utf8");

    assert.ok(
        html.indexOf("pointer-hit-policy.js") < html.indexOf("pointer-hit.js"),
        "pointer policy must load before pointer tracking"
    );
});

test("hardware progress formatter loads before the renderer", () => {
    const html = fs.readFileSync(path.join(rendererDirectory, "index.html"), "utf8");

    assert.ok(
        html.indexOf("hardware-status.js") < html.indexOf("renderer.js"),
        "hardware status formatter must load before the renderer"
    );
});

test("local transcription exposes an editable conversation input panel", () => {
    const html = fs.readFileSync(path.join(rendererDirectory, "index.html"), "utf8");
    const renderer = fs.readFileSync(path.join(rendererDirectory, "renderer.js"), "utf8");

    assert.match(html, /id="transcription-panel"/);
    assert.match(html, /id="conversation-input"/);
    assert.match(renderer, /onLocalSttUpdate\(applyLocalSttUpdate\)/);
    assert.match(renderer, /clearLocalTranscription\(\)/);
});

test("transcription toggle remains above the visible input panel", () => {
    const styles = fs.readFileSync(path.join(rendererDirectory, "styles.css"), "utf8");
    const rule = styles.match(/\.has-transcription #transcription-toggle\s*\{([^}]+)\}/);

    assert.ok(rule, "missing visible transcription toggle CSS rule");
    assert.match(rule[1], /top:\s*11px/);
    assert.match(rule[1], /z-index:\s*26/);
});

test("visible transcription panel locks native interaction and exposes close control", () => {
    const html = fs.readFileSync(path.join(rendererDirectory, "index.html"), "utf8");
    const renderer = fs.readFileSync(path.join(rendererDirectory, "renderer.js"), "utf8");
    const preload = fs.readFileSync(path.join(rendererDirectory, "..", "preload.js"), "utf8");

    assert.match(html, /id="transcription-close"/);
    assert.match(renderer, /setTranscriptionPanelOpen\(visible\)/);
    assert.match(preload, /transcription-panel-state/);
});
