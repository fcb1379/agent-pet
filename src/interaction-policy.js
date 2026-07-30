"use strict";

function shouldIgnoreMouse(options = {})
{
    const forcedInteractive = true === options.hasApproval
        || true === options.positionAdjusting
        || true === options.sessionDetailsOpen;

    if (forcedInteractive)
    {
        return false;
    }
    if (true === options.clickThrough)
    {
        return true;
    }
    return true !== options.rendererHitActive;
}

module.exports = {
    shouldIgnoreMouse
};
