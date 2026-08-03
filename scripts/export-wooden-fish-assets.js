"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const OUTPUT_DIRECTORY = path.resolve(process.argv[2] || path.join(process.cwd(), "dist", "wooden-fish-assets"));

const ASSETS = Object.freeze([
    { id: "fish-export", fileName: "agent_pet_wooden_fish.png" },
    { id: "mallet-export", fileName: "agent_pet_wooden_fish_mallet.png" },
    { id: "merit-export", fileName: "agent_pet_merit_plus_one.png" }
]);

const HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
html, body { margin: 0; background: transparent; overflow: hidden; font-family: "Segoe UI", sans-serif; }
.export { position: absolute; overflow: visible; }
.asset { position: absolute; transform-origin: center; }
#fish-export { left: 0; top: 0; width: 170px; height: 125px; }
#wooden-fish { left: 43px; top: 33px; width: 76px; height: 50px; border: 4px solid #4f250f;
    border-radius: 54% 46% 48% 52% / 60% 58% 42% 40%;
    background: linear-gradient(155deg, #f6a839 0%, #c8651d 58%, #86360f 100%);
    box-shadow: 0 7px 11px rgba(0, 0, 0, 0.4), inset 0 4px rgba(255, 223, 143, 0.45);
    transform: rotate(-4deg) scale(1.6); }
#wooden-fish::before { content: ""; position: absolute; left: 14px; top: 10px; width: 40px; height: 8px;
    border-radius: 50%; background: #3d1b0d; box-shadow: inset 0 2px 2px rgba(0, 0, 0, 0.58); transform: rotate(-3deg); }
#wooden-fish::after { content: ""; position: absolute; right: 9px; bottom: 7px; width: 11px; height: 10px;
    border-radius: 50%; background: rgba(255, 216, 119, 0.76); }
#mallet-export { left: 180px; top: 0; width: 175px; height: 100px; }
#wooden-fish-mallet { left: 38px; top: 37px; width: 64px; height: 9px; border: 2px solid #633514;
    border-radius: 7px; background: linear-gradient(180deg, #f1bd72 0%, #c77a32 55%, #8b451d 100%);
    box-shadow: 0 3px 5px rgba(0, 0, 0, 0.34), inset 0 1px rgba(255, 235, 185, 0.62); transform: scale(1.6); }
#wooden-fish-mallet i { position: absolute; left: -17px; top: -8px; width: 24px; height: 24px;
    border: 2px solid #633514; border-radius: 50% 45% 48% 52%;
    background: radial-gradient(circle at 35% 28%, #ffe0aa 0%, #d99348 48%, #8e471f 100%);
    box-shadow: 0 3px 5px rgba(0, 0, 0, 0.34), inset 2px 2px rgba(255, 241, 203, 0.55); }
#merit-export { left: 0; top: 140px; width: 180px; height: 72px; }
#merit-toast { left: 26px; top: 22px; padding: 4px 9px; border: 1px solid rgba(255, 224, 120, 0.9);
    border-radius: 13px; color: #fff3a4; background: rgba(83, 43, 12, 0.92);
    box-shadow: 0 3px 12px rgba(255, 183, 44, 0.38); font-size: 12px; font-weight: 900;
    white-space: nowrap; transform: scale(1.6); }
</style>
</head>
<body>
<div id="fish-export" class="export"><div id="wooden-fish" class="asset"></div></div>
<div id="mallet-export" class="export"><div id="wooden-fish-mallet" class="asset"><i></i></div></div>
<div id="merit-export" class="export"><div id="merit-toast" class="asset">功德 +1</div></div>
</body>
</html>`;

async function exportAssets()
{
    fs.mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
    const browserWindow = new BrowserWindow({
        width: 380,
        height: 240,
        show: false,
        transparent: true,
        backgroundColor: "#00000000",
        webPreferences: { offscreen: true }
    });

    await browserWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`);
    await browserWindow.webContents.executeJavaScript("document.fonts.ready");

    for (const asset of ASSETS)
    {
        const rectangle = await browserWindow.webContents.executeJavaScript(`(() => {
            const bounds = document.getElementById(${JSON.stringify(asset.id)}).getBoundingClientRect();
            return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
        })()`);
        const image = await browserWindow.webContents.capturePage(rectangle);
        fs.writeFileSync(path.join(OUTPUT_DIRECTORY, asset.fileName), image.toPNG());
    }

    browserWindow.destroy();
}

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.whenReady()
    .then(exportAssets)
    .then(() => app.quit())
    .catch((error) => {
        console.error(error);
        app.exit(1);
    });
