"use strict";

(function exposeAgentPetBleClient(globalObject)
{
    const RECONNECT_DELAY_MS = 2000;

    class AgentPetBleClient
    {
        constructor(options)
        {
            this.serviceUuid = options.serviceUuid;
            this.characteristicUuid = options.characteristicUuid;
            this.imageCharacteristicUuid = options.imageCharacteristicUuid;
            this.encodeImage = options.encodeImage;
            this.imageDataSizes = Array.isArray(options.imageDataSizes) && 0 < options.imageDataSizes.length
                ? [...new Set(options.imageDataSizes.filter((value) => Number.isInteger(value) && 0 < value))]
                : [235, 176, 120, 64, 11];
            this.encodeReset = options.encodeReset;
            this.onStatus = options.onStatus || (() => {});
            this.device = null;
            this.characteristic = null;
            this.imageCharacteristic = null;
            this.latestFrames = [];
            this.latestImage = { revision: "default", data: null };
            this.syncedImageRevision = null;
            this.writeQueue = Promise.resolve();
            this.reconnectTimer = null;
            this.manualDisconnect = false;
            this.handleDisconnected = this.handleDisconnected.bind(this);
        }

        isConnected()
        {
            return Boolean(this.device && this.device.gatt && this.device.gatt.connected && this.characteristic && this.imageCharacteristic);
        }

        async connect()
        {
            if (!globalObject.navigator || !globalObject.navigator.bluetooth)
            {
                throw new Error("当前系统或 Electron 版本不支持 Web Bluetooth");
            }

            this.manualDisconnect = false;
            this.onStatus("scanning");
            if (!this.device)
            {
                this.device = await globalObject.navigator.bluetooth.requestDevice({
                    acceptAllDevices: true,
                    optionalServices: [this.serviceUuid]
                });
                this.device.addEventListener("gattserverdisconnected", this.handleDisconnected);
            }

            await this.connectGatt();
        }

        async connectGatt()
        {
            this.onStatus("connecting");
            const server = await this.device.gatt.connect();
            const service = await server.getPrimaryService(this.serviceUuid);
            this.characteristic = await service.getCharacteristic(this.characteristicUuid);
            this.imageCharacteristic = await service.getCharacteristic(this.imageCharacteristicUuid);
            this.syncedImageRevision = null;
            this.onStatus("connected", this.device.name || "Agent Pet");
            this.writeQueue = this.writeQueue
                .then(() => this.flushLatest())
                .then(() => this.flushImage());
            await this.writeQueue;
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
            if (revision === this.latestImage.revision)
            {
                return;
            }

            this.latestImage = { revision, data };
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

        disconnect()
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
            this.syncedImageRevision = null;
            this.onStatus("disconnected");
        }

        handleDisconnected()
        {
            this.characteristic = null;
            this.imageCharacteristic = null;
            this.syncedImageRevision = null;
            this.onStatus("disconnected");
            if (this.manualDisconnect)
            {
                return;
            }
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => {
                this.connectGatt().catch((error) => {
                    this.onStatus("error", error.message);
                    this.handleDisconnected();
                });
            }, RECONNECT_DELAY_MS);
        }
    }

    globalObject.AgentPetBleClient = AgentPetBleClient;
    if ("undefined" !== typeof module && module.exports)
    {
        module.exports = { AgentPetBleClient, RECONNECT_DELAY_MS };
    }
})("undefined" !== typeof window ? window : globalThis);
