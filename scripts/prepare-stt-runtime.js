"use strict";

const path = require("node:path");
const {
    ensureSttRuntime,
    pruneRuntimeExecutables,
    runtimeIsComplete
} = require("../src/stt-runtime-installer");

async function prepareSttRuntime(projectDirectory, options = {})
{
    const destination = options.destination || path.join(projectDirectory, "vendor", "stt");
    if (runtimeIsComplete(destination))
    {
        pruneRuntimeExecutables(destination);
        process.stdout.write("本地 STT 运行环境已就绪。\n");
        return { installed: false, destination };
    }

    let previousMessage = "";
    process.stdout.write("正在自动准备本地 STT 运行环境，首次执行需要下载中文模型…\n");
    await ensureSttRuntime(destination, {
        ...options,
        onProgress: (progress) => {
            const totalBytes = Number(progress.totalBytes) || 0;
            const receivedBytes = Number(progress.receivedBytes) || 0;
            const percent = 0 < totalBytes ? Math.round((receivedBytes / totalBytes) * 100) : null;
            const stageName = {
                runtime: "语音引擎",
                extracting: "解压语音引擎",
                model: "中文模型",
                complete: "完成"
            }[progress.stage] || "准备";
            const message = Number.isInteger(percent)
                ? `${stageName} ${Math.floor(percent / 10) * 10}%`
                : stageName;
            if (message !== previousMessage)
            {
                previousMessage = message;
                process.stdout.write(`${message}\n`);
            }
            options.onProgress?.(progress);
        }
    });
    process.stdout.write("本地 STT 运行环境准备完成。\n");
    return { installed: true, destination };
}

if (require.main === module)
{
    prepareSttRuntime(path.resolve(__dirname, "..")).catch((error) => {
        process.stderr.write(`本地 STT 运行环境准备失败：${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { prepareSttRuntime };
