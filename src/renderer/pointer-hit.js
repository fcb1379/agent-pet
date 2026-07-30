"use strict";

(function initializePointerHitTracking()
{
    const mascot = document.getElementById("mascot");
    if (!mascot || !window.agentPet || "function" !== typeof window.agentPet.setPointerHitState)
    {
        return;
    }

    const interactiveElements = [
        document.getElementById("speech-bubble"),
        document.getElementById("resource-panel"),
        document.getElementById("session-summary"),
        document.getElementById("state-badge"),
        document.getElementById("hide-button"),
        document.querySelector("#traffic-view .traffic-shell"),
        document.getElementById("traffic-label")
    ];

    let alphaMask = null;
    let dragActive = false;
    let framePending = false;
    let lastPointerEvent = null;
    let lastPublishedState = null;

    function publish(active)
    {
        const nextState = true === active;
        if (lastPublishedState === nextState)
        {
            return;
        }
        lastPublishedState = nextState;
        window.agentPet.setPointerHitState(nextState);
    }

    function isVisible(element)
    {
        if (!element || element.hidden)
        {
            return false;
        }

        const style = window.getComputedStyle(element);
        return "none" !== style.display
            && "hidden" !== style.visibility
            && 0.05 < Number(style.opacity || 1);
    }

    function containsPoint(element, clientX, clientY, padding = 0)
    {
        if (!isVisible(element))
        {
            return false;
        }

        const rect = element.getBoundingClientRect();
        return rect.left - padding <= clientX
            && clientX <= rect.right + padding
            && rect.top - padding <= clientY
            && clientY <= rect.bottom + padding;
    }

    function rebuildMascotMask()
    {
        alphaMask = null;
        if (!mascot.complete || 0 === mascot.naturalWidth || 0 === mascot.naturalHeight)
        {
            return;
        }

        try
        {
            const maximumDimension = 256;
            const scale = Math.min(1, maximumDimension / Math.max(mascot.naturalWidth, mascot.naturalHeight));
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(mascot.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(mascot.naturalHeight * scale));
            const context = canvas.getContext("2d", { willReadFrequently: true });
            if (!context)
            {
                return;
            }
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.drawImage(mascot, 0, 0, canvas.width, canvas.height);
            alphaMask = {
                width: canvas.width,
                height: canvas.height,
                pixels: context.getImageData(0, 0, canvas.width, canvas.height).data
            };
        }
        catch (_error)
        {
            alphaMask = null;
        }
    }

    function mascotContainsPoint(clientX, clientY)
    {
        if (!containsPoint(mascot, clientX, clientY))
        {
            return false;
        }

        const rect = mascot.getBoundingClientRect();
        const naturalWidth = mascot.naturalWidth;
        const naturalHeight = mascot.naturalHeight;
        if (0 === naturalWidth || 0 === naturalHeight || 0 === rect.width || 0 === rect.height)
        {
            return false;
        }

        const displayScale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight);
        const imageWidth = naturalWidth * displayScale;
        const imageHeight = naturalHeight * displayScale;
        const imageLeft = rect.left + ((rect.width - imageWidth) / 2);
        const imageTop = rect.top + ((rect.height - imageHeight) / 2);
        const imageX = clientX - imageLeft;
        const imageY = clientY - imageTop;

        if (0 > imageX || imageX >= imageWidth || 0 > imageY || imageY >= imageHeight)
        {
            return false;
        }

        if (!alphaMask)
        {
            const normalizedX = ((imageX / imageWidth) * 2) - 1;
            const normalizedY = ((imageY / imageHeight) * 2) - 1;
            return 1 >= ((normalizedX * normalizedX) + (normalizedY * normalizedY));
        }

        const maskX = Math.min(alphaMask.width - 1, Math.floor((imageX / imageWidth) * alphaMask.width));
        const maskY = Math.min(alphaMask.height - 1, Math.floor((imageY / imageHeight) * alphaMask.height));
        const alphaOffset = ((maskY * alphaMask.width) + maskX) * 4 + 3;
        return 24 < alphaMask.pixels[alphaOffset];
    }

    function isInteractivePoint(clientX, clientY)
    {
        if (dragActive
            || document.body.classList.contains("is-position-adjusting")
            || document.body.classList.contains("has-approval")
            || document.body.classList.contains("has-session-details"))
        {
            return true;
        }

        if (mascotContainsPoint(clientX, clientY))
        {
            return true;
        }

        return interactiveElements.some((element) => containsPoint(
            element,
            clientX,
            clientY,
            element && "speech-bubble" === element.id ? 10 : 0
        ));
    }

    function evaluatePointer()
    {
        framePending = false;
        if (!lastPointerEvent)
        {
            publish(false);
            return;
        }
        publish(isInteractivePoint(lastPointerEvent.clientX, lastPointerEvent.clientY));
    }

    function scheduleEvaluation(event)
    {
        lastPointerEvent = event;
        if (!framePending)
        {
            framePending = true;
            window.requestAnimationFrame(evaluatePointer);
        }
    }

    mascot.addEventListener("load", () => {
        rebuildMascotMask();
        if (lastPointerEvent)
        {
            scheduleEvaluation(lastPointerEvent);
        }
    });
    mascot.addEventListener("mousedown", (event) => {
        if (0 === event.button)
        {
            dragActive = true;
            publish(true);
        }
    });
    document.addEventListener("mousemove", scheduleEvaluation);
    document.addEventListener("mouseup", (event) => {
        if (0 === event.button)
        {
            dragActive = false;
            scheduleEvaluation(event);
        }
    });
    window.addEventListener("blur", () => publish(false));
    window.addEventListener("mouseout", (event) => {
        if (!event.relatedTarget)
        {
            lastPointerEvent = null;
            publish(false);
        }
    });

    rebuildMascotMask();
    publish(false);
})();
