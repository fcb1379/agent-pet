"use strict";

// Launch the Electron app while neutralizing ELECTRON_RUN_AS_NODE.
// If that variable leaks into the environment (e.g. a terminal session that
// set it before starting VS Code), Electron runs in pure-Node mode and
// require("electron") no longer exposes the app API. Delete it before
// spawning so `npm start` / `npm run dev` work regardless of the host
// environment. See package.json start/dev scripts.

delete process.env.ELECTRON_RUN_AS_NODE;

const { spawn } = require("node:child_process");
const electronPath = require("electron"); // resolves to the binary path outside Electron

const args = ["."];
for (const argument of process.argv.slice(2))
{
    args.push(argument);
}

const child = spawn(electronPath, args, { stdio: "inherit", shell: false });
child.on("error", (error) =>
{
    process.stderr.write(`Failed to launch Electron: ${error.message}\n`);
    process.exit(1);
});
child.on("exit", (code, signal) =>
{
    if (null !== signal)
    {
        process.kill(process.pid, signal);
    }
    else
    {
        process.exit(code ?? 1);
    }
});
