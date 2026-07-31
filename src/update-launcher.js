"use strict";

function launchDownloadedUpdate(application, filePath, options = {})
{
    const platform = options.platform || process.platform;
    const openPath = options.openPath || (() => Promise.resolve(""));

    if ("darwin" === platform)
    {
        return openPath(filePath);
    }
    if ("win32" !== platform)
    {
        throw new Error(`Agent Pet 暂不支持在 ${platform} 上自动启动更新`);
    }

    application.relaunch({
        execPath: filePath,
        args: []
    });
    application.exit(0);
    return undefined;
}

module.exports = {
    launchDownloadedUpdate
};
