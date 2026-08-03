"use strict";

(function exposeHardwareStatus(globalObject)
{
    const LABELS = Object.freeze({
        scanning: "扫描中",
        connecting: "连接中",
        connected: "已连接",
        synced: "已同步",
        transferring: "图片",
        disconnected: "BLE",
        error: "重试"
    });

    function transferPercent(detail)
    {
        const match = String(detail || "").trim().match(/^(\d{1,3})%$/);
        return match ? Math.max(0, Math.min(100, Number(match[1]))) : null;
    }

    function hardwareStatusPresentation(status, detail)
    {
        const label = LABELS[status] || "BLE";
        const percent = "transferring" === status ? transferPercent(detail) : null;
        const text = null === percent ? label : `${label} ${percent}%`;
        return {
            percent,
            text,
            title: detail ? `${label} - ${detail}` : label
        };
    }

    globalObject.AgentPetHardwareStatus = { hardwareStatusPresentation, transferPercent };
    if ("undefined" !== typeof module && module.exports)
    {
        module.exports = { hardwareStatusPresentation, transferPercent };
    }
})("undefined" !== typeof window ? window : globalThis);
