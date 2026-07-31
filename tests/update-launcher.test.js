"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { launchDownloadedUpdate } = require("../src/update-launcher");

test("Windows update uses Electron relaunch before exiting the current version", () => {
    const calls = [];
    const application = {
        relaunch(options)
        {
            calls.push({ operation: "relaunch", options });
        },
        exit(code)
        {
            calls.push({ operation: "exit", code });
        }
    };

    launchDownloadedUpdate(application, "C:\\Downloads\\AgentPet-0.5.5-portable.exe", {
        platform: "win32"
    });

    assert.deepEqual(calls, [
        {
            operation: "relaunch",
            options: {
                execPath: "C:\\Downloads\\AgentPet-0.5.5-portable.exe",
                args: []
            }
        },
        { operation: "exit", code: 0 }
    ]);
});

test("macOS update opens the downloaded DMG without exiting", async () => {
    const opened = [];
    const application = {
        relaunch()
        {
            assert.fail("macOS DMG must not be relaunched as an application");
        },
        exit()
        {
            assert.fail("opening a DMG must not exit Agent Pet");
        }
    };

    await launchDownloadedUpdate(application, "/Users/test/Downloads/AgentPet-0.5.5-mac-arm64.dmg", {
        platform: "darwin",
        openPath(filePath)
        {
            opened.push(filePath);
            return Promise.resolve("");
        }
    });

    assert.deepEqual(opened, ["/Users/test/Downloads/AgentPet-0.5.5-mac-arm64.dmg"]);
});
