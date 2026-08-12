"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { shouldIgnoreMouse } = require("../src/interaction-policy");

test("transparent window background passes pointer input to nearby apps", () => {
    assert.equal(shouldIgnoreMouse({
        clickThrough: false,
        hasApproval: false,
        positionAdjusting: false,
        sessionDetailsOpen: false,
        rendererHitActive: false
    }), true);
});

test("visible pet controls remain interactive", () => {
    assert.equal(shouldIgnoreMouse({
        clickThrough: false,
        rendererHitActive: true
    }), false);
});

test("explicit click-through ignores ordinary renderer hit regions", () => {
    assert.equal(shouldIgnoreMouse({
        clickThrough: true,
        rendererHitActive: true
    }), true);
});

test("modal and position states override click-through", () => {
    assert.equal(shouldIgnoreMouse({ clickThrough: true, hasApproval: true }), false);
    assert.equal(shouldIgnoreMouse({ clickThrough: true, sessionDetailsOpen: true }), false);
    assert.equal(shouldIgnoreMouse({ clickThrough: true, positionAdjusting: true }), false);
});
    assert.equal(shouldIgnoreMouse({ clickThrough: true, transcriptionPanelOpen: true }), false);
