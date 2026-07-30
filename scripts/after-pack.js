"use strict";

const fs = require("node:fs");
const path = require("node:path");

const UNUSED_WINDOWS_WEBGPU_FILES = Object.freeze([
    "dxcompiler.dll",
    "dxil.dll"
]);

async function pruneUnusedElectronFiles(context)
{
    if ("win32" !== context.electronPlatformName)
    {
        return;
    }

    for (const fileName of UNUSED_WINDOWS_WEBGPU_FILES)
    {
        fs.rmSync(path.join(context.appOutDir, fileName), { force: true });
    }
}

module.exports = pruneUnusedElectronFiles;
module.exports.UNUSED_WINDOWS_WEBGPU_FILES = UNUSED_WINDOWS_WEBGPU_FILES;
module.exports.pruneUnusedElectronFiles = pruneUnusedElectronFiles;
