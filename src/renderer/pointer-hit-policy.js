"use strict";

(function exposePointerHitPolicy(root)
{
    function pointInsideRect(rect, clientX, clientY)
    {
        return Boolean(rect)
            && rect.left <= clientX
            && clientX <= rect.right
            && rect.top <= clientY
            && clientY <= rect.bottom;
    }

    function shouldPreserveWoodenFishHit(active, hitRect, clientX, clientY)
    {
        return true === active && pointInsideRect(hitRect, clientX, clientY);
    }

    const policy = {
        pointInsideRect,
        shouldPreserveWoodenFishHit
    };

    if ("undefined" !== typeof module && module.exports)
    {
        module.exports = policy;
    }
    if (root)
    {
        root.agentPetPointerHitPolicy = policy;
    }
})("undefined" === typeof window ? null : window);
