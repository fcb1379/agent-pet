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

    function shouldPreserveWoodenFishHit(active, hitRects, clientX, clientY)
    {
        if (true !== active)
        {
            return false;
        }

        const rects = Array.isArray(hitRects) ? hitRects : [hitRects];
        return rects.some((rect) => pointInsideRect(rect, clientX, clientY));
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
