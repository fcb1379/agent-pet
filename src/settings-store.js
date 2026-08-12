"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ANIMATION_STYLES = Object.freeze(["classic", "playful", "gentle", "still"]);
const DEFAULT_ANIMATION = Object.freeze({
    style: "classic",
    hoverEnabled: true,
    autoExtractMascot: true,
    mascotPath: null,
    hoverAnimations: [],
    hoverFrames: [],
    hoverFrameDurations: [],
    hoverFrameMs: 110
});

const DEFAULT_RESOURCES = Object.freeze({
    enabled: true,
    cpu: true,
    gpu: true,
    memory: true,
    network: true
});
const DEFAULT_HARDWARE = Object.freeze({
    enabled: false
});
const DEFAULT_STT = Object.freeze({
    enabled: true
});

const DEFAULT_SETTINGS = Object.freeze({
    clickThrough: false,
    displayMode: "pet",
    keyboardAnimation: true,
    updateSource: "github",
    opacity: 1,
    scale: 1,
    position: null,
    animation: DEFAULT_ANIMATION,
    resources: DEFAULT_RESOURCES,
    hardware: DEFAULT_HARDWARE,
    stt: DEFAULT_STT
});

function normalizeResources(value = {})
{
    return {
        enabled: false !== value.enabled,
        cpu: false !== value.cpu,
        gpu: false !== value.gpu,
        memory: false !== value.memory,
        network: false !== value.network
    };
}

function normalizeHardware(value = {})
{
    return {
        enabled: true === value.enabled
    };
}

function normalizeStt(value = {})
{
    return {
        enabled: false !== value.enabled
    };
}

function normalizeAnimation(value = {})
{
    const style = ANIMATION_STYLES.includes(value.style) ? value.style : DEFAULT_ANIMATION.style;
    const frameMs = Number(value.hoverFrameMs);
    const hoverFrames = Array.isArray(value.hoverFrames)
        ? value.hoverFrames.filter((item) => "string" === typeof item && 0 < item.length).slice(0, 48)
        : [];
    const hoverFrameDurations = Array.isArray(value.hoverFrameDurations)
        ? value.hoverFrameDurations
            .slice(0, hoverFrames.length)
            .map((item) => Math.max(20, Math.min(1000, Math.round(Number(item) || DEFAULT_ANIMATION.hoverFrameMs))))
        : [];
    const hoverAnimations = (Array.isArray(value.hoverAnimations) ? value.hoverAnimations : [])
        .slice(0, 4)
        .map((animation, index) => {
            const framePaths = Array.isArray(animation && animation.framePaths)
                ? animation.framePaths
                    .filter((item) => "string" === typeof item && 0 < item.length)
                    .slice(0, 48)
                : [];
            const frameDurations = Array.isArray(animation && animation.frameDurations)
                ? animation.frameDurations.slice(0, framePaths.length).map((item) =>
                    Math.max(20, Math.min(1000, Math.round(Number(item) || DEFAULT_ANIMATION.hoverFrameMs))))
                : [];
            return {
                id: "string" === typeof animation?.id && 0 < animation.id.length
                    ? animation.id
                    : `expression-${index + 1}`,
                framePaths,
                frameDurations,
                hardwarePath: "string" === typeof animation?.hardwarePath &&
                    0 < animation.hardwarePath.length
                    ? animation.hardwarePath
                    : null
            };
        })
        .filter((animation) => 0 < animation.framePaths.length);

    return {
        style,
        hoverEnabled: false !== value.hoverEnabled,
        autoExtractMascot: false !== value.autoExtractMascot,
        mascotPath: "string" === typeof value.mascotPath && 0 < value.mascotPath.length ? value.mascotPath : null,
        hoverAnimations,
        hoverFrames,
        hoverFrameDurations,
        hoverFrameMs: Number.isFinite(frameMs) && 60 <= frameMs && 500 >= frameMs ? Math.round(frameMs) : DEFAULT_ANIMATION.hoverFrameMs
    };
}

function normalizePosition(value)
{
    if (!value || !Number.isFinite(Number(value.x)) || !Number.isFinite(Number(value.y)))
    {
        return null;
    }
    return { x: Math.round(Number(value.x)), y: Math.round(Number(value.y)) };
}

function normalizeSettings(value = {})
{
    const scale = [0.75, 1, 1.25, 1.5].includes(Number(value.scale)) ? Number(value.scale) : 1;
    const opacity = [0.5, 0.75, 0.9, 1].includes(Number(value.opacity)) ? Number(value.opacity) : 1;

    return {
        clickThrough: true === value.clickThrough,
        displayMode: "traffic" === value.displayMode ? "traffic" : "pet",
        keyboardAnimation: false !== value.keyboardAnimation,
        updateSource: "gitee" === value.updateSource ? "gitee" : "github",
        opacity,
        scale,
        position: normalizePosition(value.position),
        animation: normalizeAnimation(value.animation),
        resources: normalizeResources(value.resources),
        hardware: normalizeHardware(value.hardware),
        stt: normalizeStt(value.stt)
    };
}

class SettingsStore
{
    constructor(filePath)
    {
        this.filePath = filePath;
        this.value = normalizeSettings(DEFAULT_SETTINGS);
    }

    load()
    {
        try
        {
            this.value = normalizeSettings(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
        }
        catch (_error)
        {
            this.value = normalizeSettings(DEFAULT_SETTINGS);
        }

        return this.value;
    }

    update(changes)
    {
        const resources = changes.resources
            ? { ...this.value.resources, ...changes.resources }
            : this.value.resources;
        const animation = changes.animation
            ? { ...this.value.animation, ...changes.animation }
            : this.value.animation;
        const hardware = changes.hardware
            ? { ...this.value.hardware, ...changes.hardware }
            : this.value.hardware;
        const stt = changes.stt
            ? { ...this.value.stt, ...changes.stt }
            : this.value.stt;
        this.value = normalizeSettings({ ...this.value, ...changes, animation, resources, hardware, stt });
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(this.filePath, `${JSON.stringify(this.value, null, 2)}\n`, "utf8");
        return this.value;
    }
}

module.exports = {
    ANIMATION_STYLES,
    DEFAULT_ANIMATION,
    DEFAULT_HARDWARE,
    DEFAULT_STT,
    DEFAULT_RESOURCES,
    DEFAULT_SETTINGS,
    SettingsStore,
    normalizeAnimation,
    normalizeHardware,
    normalizePosition,
    normalizeResources,
    normalizeStt,
    normalizeSettings
};
