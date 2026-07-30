"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
    pruneUnusedElectronFiles,
    UNUSED_WINDOWS_WEBGPU_FILES
} = require("../scripts/after-pack");

test("Windows packaging removes only unused WebGPU compiler files", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pet-after-pack-"));
    const preservedFile = path.join(directory, "resources.pak");
    try
    {
        fs.writeFileSync(preservedFile, "preserved");
        for (const fileName of UNUSED_WINDOWS_WEBGPU_FILES)
        {
            fs.writeFileSync(path.join(directory, fileName), "unused");
        }
        await pruneUnusedElectronFiles({
            appOutDir: directory,
            electronPlatformName: "win32"
        });
        assert.equal(fs.existsSync(preservedFile), true);
        for (const fileName of UNUSED_WINDOWS_WEBGPU_FILES)
        {
            assert.equal(fs.existsSync(path.join(directory, fileName)), false);
        }
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
