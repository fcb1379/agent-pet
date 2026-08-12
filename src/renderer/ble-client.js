"use strict";

(function exposeAgentPetBleClient(globalObject)
{
    const RECONNECT_DELAY_MS = 2000;
    const DEFAULT_RECONNECT_ATTEMPTS = 3;
    const IMAGE_PACKET_DELAY_MS = 10;
    const IMAGE_RETRY_DELAY_MS = 150;
    const IMAGE_FAST_BURST_PACKETS = 4;
    const IMAGE_FLOW_ACK_ATTEMPTS = 100;
    const IMAGE_FLOW_ACK_DELAY_MS = 20;
    const IMAGE_COMMIT_VERIFY_ATTEMPTS = 150;
    const IMAGE_COMMIT_VERIFY_DELAY_MS = 400;
    const IMAGE_SPEED_WARMUP_MS = 500;
    const IMAGE_GATT_OPERATION_TIMEOUT_MS = 6000;
    const IMAGE_BACKGROUND_RETRY_DELAY_MS = 1500;
    const AUDIO_NOTIFICATION_RETRY_ATTEMPTS = 3;
    const AUDIO_NOTIFICATION_RETRY_DELAY_MS = 300;

    function wait(milliseconds)
    {
        return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }

    function formatTransferSpeed(bytesPerSecond)
    {
        const speed = Math.max(0, Number(bytesPerSecond) || 0);
        if (1024 * 1024 <= speed)
        {
            return `${(speed / (1024 * 1024)).toFixed(1)} MB/s`;
        }
        if (1024 <= speed)
        {
            const kilobytesPerSecond = speed / 1024;
            return `${kilobytesPerSecond.toFixed(100 <= kilobytesPerSecond ? 0 : 1)} KB/s`;
        }
        return `${Math.round(speed)} B/s`;
    }

    function formatTransferDuration(milliseconds)
    {
        const seconds = Math.max(0, Number(milliseconds) || 0) / 1000;
        return `${seconds.toFixed(1)} s`;
    }

    function deviceIsUnavailable(error)
    {
        const message = String(error && error.message || error || "").toLowerCase();
        return [
            "no longer in range",
            "device unavailable",
            "device is unavailable",
            "failed to connect",
            "gatt server is disconnected"
        ].some((fragment) => message.includes(fragment));
    }

    function gattOperationTimedOut(error)
    {
        return "GattOperationTimeoutError" === (error && error.name);
    }

    function makeDeviceImageRejectedError(slot, result)
    {
        const error = new Error(`Device rejected image slot ${slot} (result ${result})`);
        error.name = "DeviceImageRejectedError";
        error.slot = slot;
        error.result = Number(result);
        return error;
    }

    function deviceImageWasRejected(error)
    {
        return "DeviceImageRejectedError" === (error && error.name);
    }

    function deviceImageCanRecover(error)
    {
        if (!deviceImageWasRejected(error))
        {
            return true;
        }
        return [102, 103, 105, 108].includes(Number(error.result));
    }


    class AgentPetBleClient
    {
        constructor(options)
        {
            this.serviceUuid = options.serviceUuid;
            this.characteristicUuid = options.characteristicUuid;
            this.imageCharacteristicUuid = options.imageCharacteristicUuid;
            this.imageDigestCharacteristicUuid = options.imageDigestCharacteristicUuid;
            this.meritCharacteristicUuid = options.meritCharacteristicUuid;
            this.audioCharacteristicUuid = options.audioCharacteristicUuid;
            this.bluetooth = options.bluetooth
                || (globalObject.navigator && globalObject.navigator.bluetooth);
            this.encodeImage = options.encodeImage;
            this.imageDataSizes = Array.isArray(options.imageDataSizes) && 0 < options.imageDataSizes.length
                ? [...new Set(options.imageDataSizes.filter((value) => Number.isInteger(value) && 0 < value))]
                : [235, 176, 120, 64, 11];
            this.encodeReset = options.encodeReset;
            this.encodeImageSelect = options.encodeImageSelect;
            this.parseImageDigest = options.parseImageDigest;
            this.encodeTimeSync = options.encodeTimeSync;
            this.encodeDailyMerit = options.encodeDailyMerit;
            this.encodeAudioControl = options.encodeAudioControl;
            this.parseDailyMerit = options.parseDailyMerit;
            this.getDailyMerit = options.getDailyMerit || (() => null);
            this.onDailyMerit = options.onDailyMerit || (() => {});
            this.onAudioFrame = options.onAudioFrame || (async () => {});
            this.onAudioDisconnect = options.onAudioDisconnect || (async () => {});
            this.onStatus = options.onStatus || (() => {});
            this.wait = options.wait || wait;
            this.now = "function" === typeof options.now ? options.now : () => Date.now();
            this.imagePacketDelayMs = Number.isInteger(options.imagePacketDelayMs)
                ? Math.max(0, options.imagePacketDelayMs)
                : IMAGE_PACKET_DELAY_MS;
            this.imageRetryDelayMs = Number.isInteger(options.imageRetryDelayMs)
                ? Math.max(0, options.imageRetryDelayMs)
                : IMAGE_RETRY_DELAY_MS;
            this.imageFastBurstPackets = Number.isInteger(options.imageFastBurstPackets)
                ? Math.max(1, options.imageFastBurstPackets)
                : IMAGE_FAST_BURST_PACKETS;
            this.imageFlowAckAttempts = Number.isInteger(options.imageFlowAckAttempts)
                ? Math.max(1, options.imageFlowAckAttempts)
                : IMAGE_FLOW_ACK_ATTEMPTS;
            this.imageFlowAckDelayMs = Number.isInteger(options.imageFlowAckDelayMs)
                ? Math.max(0, options.imageFlowAckDelayMs)
                : IMAGE_FLOW_ACK_DELAY_MS;
            this.imageSpeedWarmupMs = Number.isInteger(options.imageSpeedWarmupMs)
                ? Math.max(0, options.imageSpeedWarmupMs)
                : IMAGE_SPEED_WARMUP_MS;
            this.imageGattOperationTimeoutMs = Number.isInteger(options.imageGattOperationTimeoutMs)
                ? Math.max(1, options.imageGattOperationTimeoutMs)
                : IMAGE_GATT_OPERATION_TIMEOUT_MS;
            this.audioNotificationRetryAttempts = Number.isInteger(options.audioNotificationRetryAttempts)
                ? Math.max(1, options.audioNotificationRetryAttempts)
                : AUDIO_NOTIFICATION_RETRY_ATTEMPTS;
            this.audioNotificationRetryDelayMs = Number.isInteger(options.audioNotificationRetryDelayMs)
                ? Math.max(0, options.audioNotificationRetryDelayMs)
                : AUDIO_NOTIFICATION_RETRY_DELAY_MS;
            this.enabled = false !== options.enabled;
            this.device = null;
            this.characteristic = null;
            this.imageCharacteristic = null;
            this.imageDigestCharacteristic = null;
            this.meritCharacteristic = null;
            this.audioCharacteristic = null;
            this.latestFrames = [];
            this.latestTypingFrames = [];
            this.latestImage = { revision: "default", data: null };
            this.latestImages = new Map([[0, this.latestImage]]);
            this.syncedImageRevision = null;
            this.syncedImageRevisions = new Map();
            this.writeQueue = Promise.resolve();
            this.audioQueue = Promise.resolve();
            this.audioStreamActive = false;
            this.imageSyncPending = false;
            this.reconnectTimer = null;
            this.imageRetryTimer = null;
            this.reconnectAttempts = 0;
            this.maxReconnectAttempts = Number.isInteger(options.maxReconnectAttempts)
                ? Math.max(1, options.maxReconnectAttempts)
                : DEFAULT_RECONNECT_ATTEMPTS;
            this.manualDisconnect = false;
            this.handleDisconnected = this.handleDisconnected.bind(this);
            this.handleMeritNotification = this.handleMeritNotification.bind(this);
            this.handleAudioNotification = this.handleAudioNotification.bind(this);
        }

        async runImageGattOperation(operation, description)
        {
            let timeoutId = null;
            const timeout = new Promise((_resolve, reject) => {
                timeoutId = setTimeout(() => {
                    const error = new Error(`${description} timed out`);
                    error.name = "GattOperationTimeoutError";
                    reject(error);
                }, this.imageGattOperationTimeoutMs);
            });

            try
            {
                return await Promise.race([
                    Promise.resolve().then(operation),
                    timeout
                ]);
            }
            finally
            {
                clearTimeout(timeoutId);
            }
        }

        readImageDigestValue()
        {
            return this.runImageGattOperation(
                () => this.imageDigestCharacteristic.readValue(),
                "Image progress read"
            );
        }

        writeImageValueWithResponse(frame)
        {
            return this.runImageGattOperation(
                () => this.imageCharacteristic.writeValueWithResponse(frame),
                "Image packet write"
            );
        }

        writeImageValueWithoutResponse(frame)
        {
            return this.runImageGattOperation(
                () => this.imageCharacteristic.writeValueWithoutResponse(frame),
                "Image packet write"
            );
        }

        async waitForImageBegin(slot, total)
        {
            let lastDigest = null;

            for (let attempt = 0; attempt < this.imageFlowAckAttempts; attempt++)
            {
                if (0 < this.imageFlowAckDelayMs)
                {
                    await this.wait(this.imageFlowAckDelayMs);
                }
                if (this.deferImageTransfer())
                {
                    return false;
                }
                try
                {
                    lastDigest = this.parseImageDigest(await this.readImageDigestValue());
                }
                catch (error)
                {
                    if (gattOperationTimedOut(error))
                    {
                        throw error;
                    }
                    continue;
                }

                if (100 <= Number(lastDigest.result))
                {
                    throw makeDeviceImageRejectedError(slot, lastDigest.result);
                }
                if (!Number.isInteger(lastDigest.state) ||
                    !Number.isInteger(lastDigest.total))
                {
                    return true;
                }
                if (1 === lastDigest.state && total === lastDigest.total &&
                    0 === lastDigest.received && 100 > (Number(lastDigest.result) || 0))
                {
                    return true;
                }
            }

            if (lastDigest && 100 <= Number(lastDigest.result))
            {
                throw makeDeviceImageRejectedError(slot, lastDigest.result);
            }
            throw new Error(
                `Device did not acknowledge image slot ${slot} BEGIN ` +
                `(state ${lastDigest?.state ?? "?"}, total ${lastDigest?.total ?? "?"})`
            );
        }

        async waitForCommittedImage(slot, image)
        {
            if (!this.imageDigestCharacteristic ||
                "function" !== typeof this.parseImageDigest || !image?.md5)
            {
                return;
            }

            for (let attempt = 0; attempt < IMAGE_COMMIT_VERIFY_ATTEMPTS; attempt++)
            {
                await this.wait(IMAGE_COMMIT_VERIFY_DELAY_MS);
                if (this.deferImageTransfer())
                {
                    return;
                }
                try
                {
                    const digest = this.parseImageDigest(await this.readImageDigestValue());
                    if (100 <= Number(digest.result))
                    {
                        throw makeDeviceImageRejectedError(slot, digest.result);
                    }
                    if (digest.available && image.md5 === digest.md5)
                    {
                        return;
                    }
                }
                catch (error)
                {
                    if (gattOperationTimedOut(error) || deviceImageWasRejected(error))
                    {
                        throw error;
                    }
                    /* Flash commit can briefly make the digest characteristic unavailable. */
                }
            }

            throw new Error(`Image slot ${slot} commit digest was not confirmed`);
        }

        isEnabled()
        {
            return this.enabled;
        }

        setEnabled(enabled)
        {
            const nextEnabled = true === enabled;
            if (nextEnabled === this.enabled)
            {
                return;
            }
            this.enabled = nextEnabled;
            if (!this.enabled)
            {
                this.disconnect(true);
            }
            else
            {
                this.manualDisconnect = false;
            }
        }

        isConnected()
        {
            return Boolean(this.enabled && this.device && this.device.gatt && this.device.gatt.connected && this.characteristic && this.imageCharacteristic);
        }

        clearImageRetry()
        {
            clearTimeout(this.imageRetryTimer);
            this.imageRetryTimer = null;
        }

        queueImageSync()
        {
            if (!this.isConnected())
            {
                return;
            }
            this.clearImageRetry();
            this.writeQueue = this.writeQueue
                .then(() => this.flushImages())
                .catch((error) => this.handleImageSyncFailure(error));
        }

        handleImageSyncFailure(error)
        {
            if (!this.isConnected())
            {
                return;
            }
            if (!deviceImageCanRecover(error))
            {
                this.onStatus("error", error.message);
                return;
            }

            this.imageSyncPending = true;
            this.onStatus(
                "transferring",
                `\u8bbe\u5907\u6062\u590d\u4e2d\uff0c${IMAGE_BACKGROUND_RETRY_DELAY_MS / 1000}s \u540e\u7ee7\u7eed\u540c\u6b65`
            );
            this.clearImageRetry();
            this.imageRetryTimer = setTimeout(() => {
                this.imageRetryTimer = null;
                if (!this.isConnected())
                {
                    return;
                }
                if (this.audioStreamActive)
                {
                    this.imageSyncPending = true;
                    return;
                }
                this.imageSyncPending = false;
                this.queueImageSync();
            }, IMAGE_BACKGROUND_RETRY_DELAY_MS);
        }

        deferImageTransfer()
        {
            if (!this.audioStreamActive)
            {
                return false;
            }
            this.imageSyncPending = true;
            return true;
        }

        setAudioStreamActive(active)
        {
            const nextActive = true === active;
            if (nextActive === this.audioStreamActive)
            {
                return;
            }

            this.audioStreamActive = nextActive;
            if (this.audioStreamActive)
            {
                this.imageSyncPending = true;
                return;
            }
            if (!this.imageSyncPending || !this.isConnected())
            {
                return;
            }

            this.imageSyncPending = false;
            this.queueImageSync();
        }

        async restoreAuthorizedDevice()
        {
            if (!this.enabled || this.device || !this.bluetooth ||
                "function" !== typeof this.bluetooth.getDevices)
            {
                return false;
            }

            const devices = await this.bluetooth.getDevices();
            const device = devices.find((candidate) =>
                String(candidate?.name || "").startsWith("AgentPet-"));
            if (!device)
            {
                return false;
            }

            this.manualDisconnect = false;
            this.setDevice(device);
            try
            {
                return await this.connectGatt();
            }
            catch (error)
            {
                this.releaseDevice();
                this.onStatus("error", `自动连接失败：${error.message}`);
                return false;
            }
        }

        async connect()
        {
            if (!this.enabled)
            {
                return false;
            }
            if (!this.bluetooth)
            {
                throw new Error("当前系统或 Electron 版本不支持 Web Bluetooth");
            }

            this.manualDisconnect = false;
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
            this.reconnectAttempts = 0;
            if (!this.device)
            {
                this.onStatus("scanning");
                const device = await this.bluetooth.requestDevice({
                    acceptAllDevices: true,
                    optionalServices: [this.serviceUuid]
                });
                if (!this.enabled)
                {
                    return false;
                }
                this.setDevice(device);
            }

            try
            {
                return await this.connectGatt();
            }
            catch (error)
            {
                if (deviceIsUnavailable(error))
                {
                    this.releaseDevice();
                    this.onStatus("scan_required", "设备句柄已失效，请点击重新扫描");
                    return false;
                }
                throw error;
            }
        }

        setDevice(device)
        {
            if (this.device && this.device.removeEventListener)
            {
                this.device.removeEventListener("gattserverdisconnected", this.handleDisconnected);
            }
            this.device = device || null;
            if (this.device && this.device.addEventListener)
            {
                this.device.addEventListener("gattserverdisconnected", this.handleDisconnected);
            }
        }

        releaseDevice()
        {
            this.clearImageRetry();
            this.detachMeritNotifications();
            this.detachAudioNotifications();
            this.cancelAudioStream();
            this.setDevice(null);
            this.characteristic = null;
            this.imageCharacteristic = null;
            this.imageDigestCharacteristic = null;
            this.meritCharacteristic = null;
            this.audioCharacteristic = null;
            this.syncedImageRevision = null;
            this.syncedImageRevisions.clear();
            this.writeQueue = Promise.resolve();
            this.audioStreamActive = false;
            this.imageSyncPending = false;
        }

        async connectGatt()
        {
            if (!this.enabled || !this.device)
            {
                return false;
            }
            this.onStatus("connecting");
            const server = await this.device.gatt.connect();
            if (!this.enabled)
            {
                if (server.disconnect)
                {
                    server.disconnect();
                }
                return false;
            }
            const service = await server.getPrimaryService(this.serviceUuid);
            this.characteristic = await service.getCharacteristic(this.characteristicUuid);
            this.imageCharacteristic = await service.getCharacteristic(this.imageCharacteristicUuid);
            this.imageDigestCharacteristic = null;
            this.meritCharacteristic = null;
            this.audioCharacteristic = null;
            if (this.imageDigestCharacteristicUuid)
            {
                try
                {
                    this.imageDigestCharacteristic = await service.getCharacteristic(this.imageDigestCharacteristicUuid);
                }
                catch (_error)
                {
                    this.imageDigestCharacteristic = null;
                }
            }
            if (this.meritCharacteristicUuid)
            {
                try
                {
                    this.meritCharacteristic = await service.getCharacteristic(this.meritCharacteristicUuid);
                }
                catch (_error)
                {
                    this.meritCharacteristic = null;
                }
            }
            let audioNotificationError = null;
            try
            {
                await this.enableAudioNotificationsWithRetry(service);
            }
            catch (error)
            {
                audioNotificationError = error;
            }
            this.reconnectAttempts = 0;
            this.syncedImageRevision = null;
            this.syncedImageRevisions.clear();
            this.onStatus(
                audioNotificationError ? "audio_error" : "connected",
                audioNotificationError
                    ? audioNotificationError.message
                    : this.device.name || "Agent Pet"
            );
            this.writeQueue = Promise.resolve()
                .then(() => this.flushTime())
                .then(() => this.flushMerit())
                .then(() => this.flushLatest())
                .then(() => this.flushTypingAnimation())
                .then(() => this.flushImages().catch(
                    (error) => this.handleImageSyncFailure(error)
                ));
            await this.writeQueue;
            await this.enableMeritNotifications();
            if (audioNotificationError)
            {
                this.onStatus("audio_error", audioNotificationError.message);
            }
            return true;
        }

        setSnapshot(frames)
        {
            this.latestFrames = Array.isArray(frames)
                ? frames.map((frame) => Uint8Array.from(frame))
                : [];
            if (this.isConnected())
            {
                this.writeQueue = this.writeQueue
                    .then(() => this.flushLatest())
                    .catch((error) => this.onStatus("error", error.message));
            }
        }

        setImage(image)
        {
            const revision = image && "string" === typeof image.revision
                ? image.revision
                : "default";
            const data = image && image.data
                ? Uint8Array.from(image.data)
                : null;
            const md5 = image && "string" === typeof image.md5 && /^[0-9a-f]{32}$/i.test(image.md5)
                ? image.md5.toLowerCase()
                : null;
            if (revision === this.latestImage.revision)
            {
                return;
            }

            this.latestImage = { revision, md5, data };
            this.latestImages.set(0, this.latestImage);
            if (this.isConnected())
            {
                this.queueImageSync();
            }
        }

        setImages(images)
        {
            let changed = false;
            for (const image of Array.isArray(images) ? images : [])
            {
                const slot = Number(image && image.slot);
                if (!Number.isInteger(slot) || 0 > slot)
                {
                    continue;
                }
                const revision = image && "string" === typeof image.revision
                    ? image.revision
                    : `slot-${slot}-default`;
                const data = image && image.data ? Uint8Array.from(image.data) : null;
                const md5 = image && "string" === typeof image.md5 &&
                    /^[0-9a-f]{32}$/i.test(image.md5)
                    ? image.md5.toLowerCase()
                    : null;
                const previous = this.latestImages.get(slot);
                if (previous && revision === previous.revision)
                {
                    continue;
                }
                const normalized = { slot, revision, md5, data };
                this.latestImages.set(slot, normalized);
                changed = true;
                if (0 === slot)
                {
                    this.latestImage = normalized;
                }
            }
            if (changed && this.isConnected())
            {
                this.queueImageSync();
            }
        }

        async flushImages()
        {
            const slots = [...this.latestImages.keys()].sort((left, right) => left - right);
            for (const slot of slots)
            {
                await this.flushImage(slot);
            }
        }

        async flushImage(slot = 0)
        {
            const image = 0 === slot ? this.latestImage : this.latestImages.get(slot);
            const syncedRevision = 0 === slot
                ? this.syncedImageRevision
                : this.syncedImageRevisions.get(slot);
            if (!this.isConnected() || !image || syncedRevision === image.revision)
            {
                return;
            }
            if (this.deferImageTransfer())
            {
                return;
            }

            let supportsFlowControl = false;
            if (this.imageDigestCharacteristic && "function" === typeof this.parseImageDigest)
            {
                try
                {
                    if ("function" === typeof this.encodeImageSelect)
                    {
                        await this.writeImageValueWithResponse(this.encodeImageSelect(slot));
                    }
                    const digest = this.parseImageDigest(await this.readImageDigestValue());
                    supportsFlowControl = Number.isInteger(digest.received);
                    const sameImage = image.data
                        ? Boolean(image.md5 && digest.available && image.md5 === digest.md5)
                        : !digest.available;
                    if (sameImage)
                    {
                        this.syncedImageRevisions.set(slot, image.revision);
                        if (0 === slot)
                        {
                            this.syncedImageRevision = image.revision;
                        }
                        this.onStatus("synced", this.device.name || "Agent Pet");
                        return;
                    }
                }
                catch (error)
                {
                    if (gattOperationTimedOut(error))
                    {
                        throw error;
                    }
                    /* Older firmware or a transient read failure falls back to a normal transfer. */
                }
            }
            const dataSizes = image.data ? this.imageDataSizes : [null];
            let lastError = null;

            for (let attempt = 0; attempt < dataSizes.length; attempt++)
            {
                const dataSize = dataSizes[attempt];
                const frames = image.data
                    ? this.encodeImage(image.data, dataSize, slot)
                    : this.encodeReset(slot);
                const progressStep = Math.max(1, Math.floor(frames.length / 20));
                const packetSize = image.data ? dataSize + 9 : frames[0].length;
                const transferStartedAt = this.now();
                const imageByteLength = image.data ? image.data.byteLength : 0;
                const transferDetail = (dataFrameCount, percent, mode = "") => {
                    const bytesSent = Math.min(imageByteLength, dataFrameCount * dataSize);
                    const elapsedMs = Math.max(0, this.now() - transferStartedAt);
                    if (this.imageSpeedWarmupMs > elapsedMs)
                    {
                        return `${percent}% · 测速中${mode ? ` · ${mode}` : ""}`;
                    }
                    const speed = formatTransferSpeed((bytesSent * 1000) / Math.max(1, elapsedMs));
                    return `${percent}% · ${speed}${mode ? ` · ${mode}` : ""}`;
                };
                const useFastWrite = Boolean(
                    image.data &&
                    supportsFlowControl &&
                    this.imageDigestCharacteristic &&
                    "function" === typeof this.parseImageDigest &&
                    "function" === typeof this.imageCharacteristic.writeValueWithoutResponse
                );

                try
                {
                    if (useFastWrite)
                    {
                        if (this.deferImageTransfer())
                        {
                            return;
                        }
                        await this.writeImageValueWithResponse(frames[0]);
                        if (!await this.waitForImageBegin(slot, imageByteLength))
                        {
                            return;
                        }
                        for (let index = 1; index < frames.length - 1; index++)
                        {
                            if (this.deferImageTransfer())
                            {
                                return;
                            }
                            const isLastDataFrame = index + 2 === frames.length;
                            const isFlowControlBoundary =
                                0 === index % this.imageFastBurstPackets || isLastDataFrame;
                            await this.writeImageValueWithoutResponse(frames[index]);
                            if (isFlowControlBoundary)
                            {
                                const requiredBytes = Math.min(imageByteLength, index * dataSize);
                                let acknowledged = false;
                                for (let ackAttempt = 0;
                                    ackAttempt < this.imageFlowAckAttempts;
                                    ackAttempt++)
                                {
                                    if (0 < this.imageFlowAckDelayMs)
                                    {
                                        await this.wait(this.imageFlowAckDelayMs);
                                    }
                                    try
                                    {
                                        const digest = this.parseImageDigest(
                                            await this.readImageDigestValue()
                                        );
                                        if (100 <= Number(digest.result))
                                        {
                                            throw makeDeviceImageRejectedError(
                                                slot, digest.result
                                            );
                                        }
                                        if (Number.isInteger(digest.received) &&
                                            requiredBytes <= digest.received)
                                        {
                                            acknowledged = true;
                                            break;
                                        }
                                    }
                                    catch (error)
                                    {
                                        if (gattOperationTimedOut(error))
                                        {
                                            throw error;
                                        }
                                        if (deviceImageWasRejected(error))
                                        {
                                            throw error;
                                        }
                                        /* A busy firmware worker is polled again without blocking the UI. */
                                    }
                                }
                                if (!acknowledged)
                                {
                                    throw new Error(`Device stopped at ${requiredBytes} image bytes`);
                                }
                                const percent = Math.min(
                                    99,
                                    Math.round((requiredBytes * 100) / imageByteLength)
                                );
                                this.onStatus("transferring", transferDetail(index, percent, "flow"));
                            }
                        }
                        if (this.deferImageTransfer())
                        {
                            return;
                        }
                        await this.writeImageValueWithResponse(frames.at(-1));

                        await this.waitForCommittedImage(slot, image);
                    }
                    else
                    {
                        for (let index = 0; index < frames.length; index++)
                        {
                            if (this.deferImageTransfer())
                            {
                                return;
                            }
                            await this.writeImageValueWithResponse(frames[index]);
                            if (0 === index && image.data && supportsFlowControl &&
                                !await this.waitForImageBegin(slot, imageByteLength))
                            {
                                return;
                            }
                            if (0 === index % progressStep || index + 1 === frames.length)
                            {
                                const dataFrameCount = Math.max(0, Math.min(index, frames.length - 2));
                                const bytesSent = Math.min(imageByteLength, dataFrameCount * dataSize);
                                const percent = 0 < imageByteLength
                                    ? Math.round((bytesSent * 100) / imageByteLength)
                                    : Math.round(((index + 1) * 100) / frames.length);
                                const detail = 0 < dataFrameCount
                                    ? transferDetail(dataFrameCount, percent)
                                    : `${percent}% · ${packetSize} B`;
                                this.onStatus("transferring", detail);
                            }
                            if (index + 1 < frames.length && 0 < this.imagePacketDelayMs)
                            {
                                await this.wait(this.imagePacketDelayMs);
                            }
                        }
                        if (image.data && supportsFlowControl)
                        {
                            await this.waitForCommittedImage(slot, image);
                        }
                    }
                    this.imageSyncPending = false;
                    this.syncedImageRevisions.set(slot, image.revision);
                    if (0 === slot)
                    {
                        this.syncedImageRevision = image.revision;
                    }
                    const elapsedMs = Math.max(1, this.now() - transferStartedAt);
                    const averageSpeed = formatTransferSpeed((imageByteLength * 1000) / elapsedMs);
                    this.onStatus(
                        "synced",
                        `${this.device.name || "Agent Pet"} · ${formatTransferDuration(elapsedMs)} · ${averageSpeed}`
                    );
                    return;
                }
                catch (error)
                {
                    lastError = error;
                    if (deviceImageWasRejected(error) && !deviceImageCanRecover(error))
                    {
                        throw error;
                    }
                    if (gattOperationTimedOut(error) ||
                        !image.data || !this.isConnected() || attempt + 1 === dataSizes.length)
                    {
                        throw error;
                    }
                    const nextPacketSize = dataSizes[attempt + 1] + 9;
                    this.onStatus(
                        "transferring",
                        useFastWrite
                            ? `0% · 安全重试 ${nextPacketSize} B`
                            : `MTU fallback ${nextPacketSize} B`
                    );
                    if (0 < this.imageRetryDelayMs)
                    {
                        await this.wait(this.imageRetryDelayMs);
                    }
                }
            }

            throw lastError || new Error("Mascot image transfer failed");
        }
        setTypingAnimation(frames)
        {
            this.latestTypingFrames = Array.isArray(frames)
                ? frames.map((frame) => Uint8Array.from(frame))
                : [];
            if (!this.isConnected())
            {
                return Promise.resolve(false);
            }

            this.writeQueue = this.writeQueue
                .then(() => this.flushTypingAnimation())
                .then(() => {
                    this.onStatus("synced", this.device.name || "Agent Pet");
                    return true;
                })
                .catch((error) => {
                    this.onStatus("error", error.message);
                    return false;
                });
            return this.writeQueue;
        }

        async flushTypingAnimation()
        {
            if (!this.isConnected())
            {
                return;
            }
            const frames = this.latestTypingFrames.map((frame) => frame.slice());
            for (const frame of frames)
            {
                await this.characteristic.writeValueWithResponse(frame);
            }
        }

        sendEvent(frames)
        {
            const eventFrames = Array.isArray(frames)
                ? frames.map((frame) => Uint8Array.from(frame))
                : [];
            if (!this.isConnected() || 0 === eventFrames.length)
            {
                return Promise.resolve(false);
            }

            this.writeQueue = this.writeQueue
                .then(async () => {
                    for (const frame of eventFrames)
                    {
                        await this.characteristic.writeValueWithResponse(frame);
                    }
                    this.onStatus("synced", this.device.name || "Agent Pet");
                    return true;
                })
                .catch((error) => {
                    this.onStatus("error", error.message);
                    return false;
                });
            return this.writeQueue;
        }

        async flushLatest()
        {
            if (!this.isConnected())
            {
                return;
            }
            const frames = this.latestFrames.map((frame) => frame.slice());
            for (const frame of frames)
            {
                await this.characteristic.writeValueWithResponse(frame);
            }
            this.onStatus("synced", this.device.name || "Agent Pet");
        }

        async flushTime()
        {
            if (!this.isConnected() || "function" !== typeof this.encodeTimeSync)
            {
                return;
            }
            const frames = this.encodeTimeSync();
            for (const frame of frames)
            {
                await this.characteristic.writeValueWithResponse(frame);
            }
        }

        async flushMerit()
        {
            if (!this.isConnected() || !this.meritCharacteristic ||
                "function" !== typeof this.encodeDailyMerit ||
                "function" !== typeof this.parseDailyMerit)
            {
                return;
            }
            const remoteValue = await this.meritCharacteristic.readValue();
            const remote = this.parseDailyMerit(remoteValue);
            await this.mergeMerit(remote);
        }

        async mergeMerit(remote)
        {
            const local = this.getDailyMerit();
            if (!local || !Number.isInteger(local.day) || !Number.isInteger(local.count) ||
                !remote || !Number.isInteger(remote.day) || !Number.isInteger(remote.count))
            {
                return;
            }
            const merged = remote.day === local.day
                ? { day: local.day, count: Math.max(local.count, remote.count) }
                : { day: local.day, count: local.count };

            if (merged.day !== local.day || merged.count !== local.count)
            {
                this.onDailyMerit(merged);
            }
            if (merged.day !== remote.day || merged.count !== remote.count)
            {
                await this.meritCharacteristic.writeValueWithResponse(
                    this.encodeDailyMerit(merged.day, merged.count));
            }
        }

        async enableMeritNotifications()
        {
            if (!this.meritCharacteristic ||
                "function" !== typeof this.meritCharacteristic.startNotifications ||
                "function" !== typeof this.meritCharacteristic.addEventListener)
            {
                return;
            }
            await this.meritCharacteristic.startNotifications();
            this.meritCharacteristic.addEventListener(
                "characteristicvaluechanged",
                this.handleMeritNotification);
        }

        detachMeritNotifications()
        {
            if (this.meritCharacteristic &&
                "function" === typeof this.meritCharacteristic.removeEventListener)
            {
                this.meritCharacteristic.removeEventListener(
                    "characteristicvaluechanged",
                    this.handleMeritNotification);
            }
        }

        handleMeritNotification(event)
        {
            if (!event || !event.target || !event.target.value)
            {
                return;
            }
            this.writeQueue = this.writeQueue
                .then(() => this.mergeMerit(this.parseDailyMerit(event.target.value)))
                .catch((error) => this.onStatus("error", error.message));
        }

        async enableAudioNotifications()
        {
            if (!this.audioCharacteristic ||
                "function" !== typeof this.audioCharacteristic.startNotifications ||
                "function" !== typeof this.audioCharacteristic.addEventListener)
            {
                throw new Error("Audio characteristic does not support notifications");
            }
            await this.audioCharacteristic.startNotifications();
            this.audioCharacteristic.addEventListener(
                "characteristicvaluechanged",
                this.handleAudioNotification);
        }

        async requestAudioStream(active)
        {
            if (!this.isConnected() || !this.audioCharacteristic ||
                "function" !== typeof this.audioCharacteristic.writeValueWithResponse ||
                "function" !== typeof this.encodeAudioControl)
            {
                throw new Error("\u97F3\u9891\u63A7\u5236\u901A\u9053\u5C1A\u672A\u8FDE\u63A5");
            }

            const frame = this.encodeAudioControl(true === active);
            if (!(frame instanceof Uint8Array) || 0 === frame.length)
            {
                throw new Error("\u97F3\u9891\u63A7\u5236\u547D\u4EE4\u65E0\u6548");
            }

            if (true === active)
            {
                this.setAudioStreamActive(true);
            }
            const operation = this.writeQueue.then(() =>
                this.audioCharacteristic.writeValueWithResponse(frame));
            this.writeQueue = operation.catch(() => {});
            try
            {
                await operation;
                return true;
            }
            catch (error)
            {
                if (true === active)
                {
                    this.setAudioStreamActive(false);
                }
                throw error;
            }
        }

        async enableAudioNotificationsWithRetry(service)
        {
            if (!this.audioCharacteristicUuid)
            {
                return;
            }

            let lastError = null;
            for (let attempt = 1; attempt <= this.audioNotificationRetryAttempts; attempt++)
            {
                try
                {
                    this.audioCharacteristic = await service.getCharacteristic(
                        this.audioCharacteristicUuid);
                    await this.enableAudioNotifications();
                    return;
                }
                catch (error)
                {
                    lastError = error;
                    this.detachAudioNotifications();
                    this.audioCharacteristic = null;
                    if (attempt < this.audioNotificationRetryAttempts)
                    {
                        await this.wait(this.audioNotificationRetryDelayMs);
                    }
                }
            }

            throw new Error(`音频通道订阅失败：${lastError?.message || "特征不可用"}`);
        }

        detachAudioNotifications()
        {
            if (this.audioCharacteristic &&
                "function" === typeof this.audioCharacteristic.removeEventListener)
            {
                this.audioCharacteristic.removeEventListener(
                    "characteristicvaluechanged",
                    this.handleAudioNotification);
            }
        }

        handleAudioNotification(event)
        {
            if (!event || !event.target || !event.target.value)
            {
                return;
            }
            const value = event.target.value;
            const frame = new Uint8Array(
                value.buffer,
                value.byteOffset || 0,
                value.byteLength
            ).slice();
            this.audioQueue = this.audioQueue
                .then(() => this.onAudioFrame(frame))
                .catch((error) => this.onStatus(
                    "error",
                    "Audio receive failed: " + error.message
                ));
        }

        cancelAudioStream()
        {
            this.audioQueue = this.audioQueue
                .then(() => this.onAudioDisconnect())
                .catch((error) => this.onStatus(
                    "error",
                    "Audio cleanup failed: " + error.message
                ));
        }

        disconnect(silent = false)
        {
            this.manualDisconnect = true;
            this.clearImageRetry();
            this.detachMeritNotifications();
            this.detachAudioNotifications();
            this.cancelAudioStream();
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
            if (this.device && this.device.gatt && this.device.gatt.connected)
            {
                this.device.gatt.disconnect();
            }
            this.characteristic = null;
            this.imageCharacteristic = null;
            this.imageDigestCharacteristic = null;
            this.meritCharacteristic = null;
            this.audioCharacteristic = null;
            this.syncedImageRevision = null;
            this.syncedImageRevisions.clear();
            this.writeQueue = Promise.resolve();
            this.audioStreamActive = false;
            this.imageSyncPending = false;
            if (!silent)
            {
                this.onStatus("disconnected");
            }
        }

        scheduleReconnect()
        {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
            if (!this.enabled || this.manualDisconnect || !this.device)
            {
                return;
            }
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                void this.attemptReconnect();
            }, RECONNECT_DELAY_MS);
        }

        async attemptReconnect()
        {
            if (!this.enabled || this.manualDisconnect || !this.device)
            {
                return false;
            }
            try
            {
                await this.connectGatt();
                return true;
            }
            catch (error)
            {
                this.reconnectAttempts++;
                if (deviceIsUnavailable(error) && this.reconnectAttempts >= this.maxReconnectAttempts)
                {
                    this.releaseDevice();
                    this.onStatus("scan_required", "设备已重启，请点击重新扫描");
                    return false;
                }
                this.onStatus(
                    "error",
                    `自动重连 ${this.reconnectAttempts}/${this.maxReconnectAttempts}：${error.message}`
                );
                this.scheduleReconnect();
                return false;
            }
        }

        handleDisconnected()
        {
            this.clearImageRetry();
            this.detachMeritNotifications();
            this.detachAudioNotifications();
            this.cancelAudioStream();
            this.characteristic = null;
            this.imageCharacteristic = null;
            this.imageDigestCharacteristic = null;
            this.meritCharacteristic = null;
            this.audioCharacteristic = null;
            this.syncedImageRevision = null;
            this.syncedImageRevisions.clear();
            this.writeQueue = Promise.resolve();
            this.audioStreamActive = false;
            this.imageSyncPending = false;
            if (!this.enabled)
            {
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
                return;
            }
            this.onStatus("disconnected");
            if (this.manualDisconnect)
            {
                return;
            }
            this.scheduleReconnect();
        }
    }

    globalObject.AgentPetBleClient = AgentPetBleClient;
    if ("undefined" !== typeof module && module.exports)
    {
        module.exports = {
            AgentPetBleClient,
            DEFAULT_RECONNECT_ATTEMPTS,
            IMAGE_PACKET_DELAY_MS,
            IMAGE_FAST_BURST_PACKETS,
            IMAGE_FLOW_ACK_ATTEMPTS,
            IMAGE_FLOW_ACK_DELAY_MS,
            IMAGE_GATT_OPERATION_TIMEOUT_MS,
            IMAGE_RETRY_DELAY_MS,
            IMAGE_SPEED_WARMUP_MS,
            RECONNECT_DELAY_MS,
            formatTransferDuration,
            formatTransferSpeed,
            deviceIsUnavailable,
            gattOperationTimedOut
        };
    }
})("undefined" !== typeof window ? window : globalThis);
