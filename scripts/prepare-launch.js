"use strict";

const path = require("node:path");
const { ensureDependencies } = require("./dependency-bootstrap");
const { prepareSttRuntime } = require("./prepare-stt-runtime");

async function prepareLaunch(projectDirectory)
{
    ensureDependencies(projectDirectory);
    await prepareSttRuntime(projectDirectory);
}

if (require.main === module)
{
    prepareLaunch(path.resolve(__dirname, "..")).catch((error) => {
        process.stderr.write(`Agent Pet 启动准备失败：${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { prepareLaunch };
