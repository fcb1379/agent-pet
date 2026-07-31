"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { shouldPreserveWoodenFishHit } = require("../src/renderer/pointer-hit-policy");

const woodenFishRect = Object.freeze({
    left: 20,
    right: 220,
    top: 80,
    bottom: 280
});

test("wooden fish animation preserves rapid clicks inside its active bounds", () => {
    assert.equal(shouldPreserveWoodenFishHit(true, woodenFishRect, 120, 160), true);
});

test("wooden fish preservation ends with the animation or outside its active bounds", () => {
    assert.equal(shouldPreserveWoodenFishHit(false, woodenFishRect, 120, 160), false);
    assert.equal(shouldPreserveWoodenFishHit(true, woodenFishRect, 250, 160), false);
});
