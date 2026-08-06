"use strict";

(function exposeAgentPetBleClient(globalObject)
{
    const RECONNECT_DELAY_MS = 2000;
    const DEFAULT_RECONNECT_ATTEMPTS = 3;
    const IMAGE_PACKET_DELAY_MS = 10;
    const IMAGE_RETRY_DELAY_MS = 150;

    function wait(milliseconds)
    {
        return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

    class AgentPetBleClient
    {
        constructor(options)
        {
            this.serviceUuid = options.serviceUuid;
            this.characteristicUuid = options.characteristicUuid;
            this.imageCharacteristicUuid = options.imageCharacteristicUuid;
            this.imageDigestCharacteristicUuid = options.imageDigestCharacteristicUuid;
            this.bluetooth = options.bluetooth
                || (globalObject.navigator && globalObject.navigator.bluetooth);
            this.encodeImage = options.encodeImage;
            this.imageDataSizes = Array.isArray(options.imageDataSizes) && 0 < options.imageDataSizes.length
                ? [...new Set(options.imageDataSizes.filter((value) => Number.isInteger(value) && 0 < value))]
                : [235, 176, 120, 64, 11];
            this.encodeReset = options.encodeReset;
            this.parseImageDigest = options.parseImageDigest;
            this.encodeTimeSync = options.encodeTimeSync;
            this.onStatus = options.onStatus || (() => {});
            this.wait = options.wait || wait;
            this.imagePacketDelayMs = Number.isInteger(options.imagePacketDelayMs)
                ? Math.max(0, options.imagePacketDelayMs)
                : IMAGE_PACKET_DELAY_MS;
            this.imageRetryDelayMs = Number.isInteger(options.imageRetryDelayMs)
                ? Math.max(0, options.imageRetryDelayMs)
                : IMAGE_RETRY_DELAY_MS;
            this.enabled = false !== options.enabled;
            this.device = null;
            this.characteristic = null;
            this.imageCharacteristic = null;
            this.imageDigestCharacteristic = null;
            this.latestFrames = [];
            this.latestImage = { revision: "default", data: null };
            this.syncedImageRevision = null;
            this.writeQueue = Promise.resolve();
            this.reconnectTimer = null;
            this.reconnectAttempts = 0;
            this.maxReconnectAttempts = Number.isInteger(options.maxReconnectAttempts)
                ? Math.max(1, options.maxReconnectAttempts)
                : DEFAULT_RECONNECT_ATTEMPTS;
            this.manualDisconnect = false;
            this.handleDisconnected = this.handleDisconnected.bind(this);
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
            this.setDevice(null);
            this.characteristic = null;
            this.imageCharacteristic = null;
            this.imageDigestCharacteristic = null;
            this.syncedImageRevision = null;
            this.writeQueue = Promise.resolve();
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
            this.reconnectAttempts = 0;
            this.syncedImageRevision = null;
            this.onStatus("connected", this.device.name || "Agent Pet");
            this.writeQueue = Promise.resolve()
                .then(() => this.flushTime())
                .then(() => this.flushLatest())
                .then(() => this.flushImage());
            await this.writeQueue;
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
            if (this.isConnected())
            {
                this.writeQueue = this.writeQueue
                    .then(() => this.flushImage())
                    .catch((error) => this.onStatus("error", error.message));
            }
        }

        async flushImage()
        {
            if (!this.isConnected() || this.syncedImageRevision === this.latestImage.revision)
            {
                return;
            }

            const image = this.latestImage;
            if (this.imageDigestCharacteristic && "function" === typeof this.parseImageDigest)
            {
                try
                {
                    const digest = this.parseImageDigest(await this.imageDigestCharacteristic.readValue());
                    const sameImage = image.data
                        ? Boolean(image.md5 && digest.available && image.md5 === digest.md5)
                        : !digest.available;
                    if (sameImage)
                    {
                        this.syncedImageRevision = image.revision;
                        this.onStatus("synced", this.device.name || "Agent Pet");
                        return;
                    }
                }
                catch (_error)
                {
                    /* Older firmware or a transient read failure falls back to a normal transfer. */
                }
            }
            const dataSizes = image.data ? this.imageDataSizes : [null];
            let lastError = null;

            for (let attempt = 0; attempt < dataSizes.length; attempt++)
            {
                const dataSize = dataSizes[attempt];
                const frames = image.data
                    ? this.encodeImage(image.data, dataSize)
                    : this.encodeReset();
                const progressStep = Math.max(1, Math.floor(frames.length / 20));
                const packetSize = image.data ? dataSize + 9 : frames[0].length;

                try
                {
                    for (let index = 0; index < frames.length; index++)
                    {
                        await this.imageCharacteristic.writeValueWithResponse(frames[index]);
                        if (0 === index % progressStep || index + 1 === frames.length)
                        {
                            const percent = Math.round(((index + 1) * 100) / frames.length);
                            this.onStatus("transferring", `${percent}% · ${packetSize} B`);
                        }
                        if (index + 1 < frames.length && 0 < this.imagePacketDelayMs)
                        {
                            await this.wait(this.imagePacketDelayMs);
                        }
                    }
                    this.syncedImageRevision = image.revision;
                    this.onStatus("synced", this.device.name || "Agent Pet");
                    return;
                }
                catch (error)
                {
                    lastError = error;
                    if (!image.data || !this.isConnected() || attempt + 1 === dataSizes.length)
                    {
                        throw error;
                    }
                    const nextPacketSize = dataSizes[attempt + 1] + 9;
                    this.onStatus("transferring", `MTU fallback ${nextPacketSize} B`);
                    if (0 < this.imageRetryDelayMs)
                    {
                        await this.wait(this.imageRetryDelayMs);
                    }
                }
            }

            throw lastError || new Error("Mascot image transfer failed");
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
        disconnect(silent = false)
        {
            this.manualDisconnect = true;
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
            if (this.device && this.device.gatt && this.device.gatt.connected)
            {
                this.device.gatt.disconnect();
            }
            this.characteristic = null;
            this.imageCharacteristic = null;
            this.imageDigestCharacteristic = null;
            this.syncedImageRevision = null;
            this.writeQueue = Promise.resolve();
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
            this.characteristic = null;
            this.imageCharacteristic = null;
            this.imageDigestCharacteristic = null;
            this.syncedImageRevision = null;
            this.writeQueue = Promise.resolve();
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
            IMAGE_RETRY_DELAY_MS,
            RECONNECT_DELAY_MS,
            deviceIsUnavailable
        };
    }
})("undefined" !== typeof window ? window : globalThis);
