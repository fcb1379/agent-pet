"use strict";

const os = require("node:os");
const path = require("node:path");

function agentDataDirectory(options = {})
{
    const platform = options.platform || process.platform;
    const environment = options.environment || process.env;
    const homeDirectory = options.homeDirectory || os.homedir();

    if ("win32" === platform)
    {
        const localAppData = environment.LOCALAPPDATA
            || path.join(homeDirectory, "AppData", "Local");
        return path.join(localAppData, "AgentPet");
    }

    if ("darwin" === platform)
    {
        return path.join(homeDirectory, "Library", "Application Support", "AgentPet");
    }

    const dataHome = environment.XDG_DATA_HOME
        || path.join(homeDirectory, ".local", "share");
    return path.join(dataHome, "AgentPet");
}

function stateDirectory(options = {})
{
    return path.join(agentDataDirectory(options), "states");
}

function approvalDirectory(options = {})
{
    return path.join(agentDataDirectory(options), "approvals");
}

function platformLabel(platform = process.platform)
{
    if ("darwin" === platform)
    {
        return "macOS";
    }
    if ("win32" === platform)
    {
        return "Windows";
    }
    return "Linux";
}

module.exports = {
    agentDataDirectory,
    approvalDirectory,
    platformLabel,
    stateDirectory
};
