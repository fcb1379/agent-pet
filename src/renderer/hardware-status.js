"use strict";

(function exposeHardwareStatus(globalObject)
{
    const LABELS = Object.freeze({
        scanning: "扫描中",
        connecting: "连接中",
        connected: "已连接",
        synced: "已同步",
        transferring: "图片",
        scan_required: "重新扫描",
        disconnected: "BLE",
        error: "重试"
    });

    function transferPercent(detail)
    {
        const match = String(detail || "").trim().match(/^(\d{1,3})%(?:\s|$)/);
        return match ? Math.max(0, Math.min(100, Number(match[1]))) : null;
    }

    function transferSpeed(detail)
    {
        const match = String(detail || "").match(/(\d+(?:\.\d+)?\s+(?:B|KB|MB)\/s)/i);
        return match ? match[1] : null;
    }

    function hardwareStatusPresentation(status, detail)
    {
        const label = LABELS[status] || "BLE";
        const percent = "transferring" === status ? transferPercent(detail) : null;
        const speed = transferSpeed(detail);
        const warmingUp = "transferring" === status && String(detail || "").includes("测速中");
        const showSpeed = speed && ("transferring" === status || "synced" === status);
        const text = null === percent
            ? `${label}${showSpeed ? ` · ${speed}` : ""}`
            : `${label} ${percent}%${showSpeed ? ` · ${speed}` : warmingUp ? " · 测速中" : ""}`;
        return {
            percent,
            text,
            title: detail ? `${label} - ${detail}` : label
        };
    }

    globalObject.AgentPetHardwareStatus = { hardwareStatusPresentation, transferPercent, transferSpeed };
    if ("undefined" !== typeof module && module.exports)
    {
        module.exports = { hardwareStatusPresentation, transferPercent, transferSpeed };
    }
})("undefined" !== typeof window ? window : globalThis);
