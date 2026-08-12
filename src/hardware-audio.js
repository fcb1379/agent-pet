"use strict";

(function exposeAgentPetHardwareAudio(globalObject)
{
    const AUDIO_MAGIC_FIRST = 0x41;
    const AUDIO_MAGIC_SECOND = 0x4f;
    const AUDIO_PROTOCOL_VERSION = 1;
    const AUDIO_FRAME_OVERHEAD = 13;
    const AUDIO_SEQUENCE_MAX = 0x00ffffff;
    const AUDIO_TYPE_START = 1;
    const AUDIO_TYPE_DATA = 2;
    const AUDIO_TYPE_END = 3;
    const AUDIO_TYPE_ERROR = 4;
    const OPUS_MAX_PACKET_BYTES = 1275;
    const OGG_SERIAL = 0x41504554;

    function asBytes(value)
    {
        if (value instanceof DataView)
        {
            return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        }
        if (value instanceof Uint8Array)
        {
            return value;
        }
        if (value instanceof ArrayBuffer)
        {
            return new Uint8Array(value);
        }
        return Uint8Array.from(value || []);
    }

    function crc8Atm(data)
    {
        let crc = 0;

        for (const value of data)
        {
            crc ^= value;
            for (let bit = 0; bit < 8; bit++)
            {
                crc = 0 !== (crc & 0x80)
                    ? ((crc << 1) ^ 0x07) & 0xff
                    : (crc << 1) & 0xff;
            }
        }

        return crc;
    }

    function oggCrc(data)
    {
        let crc = 0;

        for (const value of data)
        {
            crc = (crc ^ ((value & 0xff) << 24)) >>> 0;
            for (let bit = 0; bit < 8; bit++)
            {
                crc = 0 !== (crc & 0x80000000)
                    ? (((crc << 1) ^ 0x04c11db7) >>> 0)
                    : ((crc << 1) >>> 0);
            }
        }

        return crc >>> 0;
    }

    function parseAudioFrame(value)
    {
        const bytes = asBytes(value);
        if (AUDIO_FRAME_OVERHEAD > bytes.length ||
            AUDIO_MAGIC_FIRST !== bytes[0] ||
            AUDIO_MAGIC_SECOND !== bytes[1] ||
            AUDIO_PROTOCOL_VERSION !== bytes[2])
        {
            throw new Error("Invalid hardware audio frame");
        }
        const type = bytes[3];
        const session = bytes[4] | (bytes[5] << 8);
        const sequence = bytes[6] | (bytes[7] << 8) | (bytes[8] << 16);
        const fragmentIndex = bytes[9];
        const fragmentCount = bytes[10];
        const payloadLength = bytes[11];
        if (AUDIO_TYPE_START > type || AUDIO_TYPE_ERROR < type ||
            0 === session || 0 === fragmentCount ||
            fragmentCount <= fragmentIndex ||
            AUDIO_FRAME_OVERHEAD + payloadLength !== bytes.length ||
            bytes.at(-1) !== crc8Atm(bytes.subarray(0, -1)))
        {
            throw new Error("Invalid hardware audio frame");
        }

        return {
            type,
            session,
            sequence,
            fragmentIndex,
            fragmentCount,
            payload: bytes.slice(12, 12 + payloadLength)
        };
    }

    function concatBytes(chunks)
    {
        const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
        const output = new Uint8Array(length);
        let offset = 0;

        for (const chunk of chunks)
        {
            output.set(chunk, offset);
            offset += chunk.length;
        }
        return output;
    }

    function writeLe64(view, offset, value)
    {
        const granule = BigInt(value);
        view.setUint32(offset, Number(granule & 0xffffffffn), true);
        view.setUint32(offset + 4, Number((granule >> 32n) & 0xffffffffn), true);
    }

    class OggOpusAssembler
    {
        constructor(metadata)
        {
            const sampleRate = Number(metadata.sampleRate);
            const channels = Number(metadata.channels);
            const frameSamples = Number(metadata.frameSamples);
            const preSkip = Number(metadata.preSkip);
            if (![8000, 12000, 16000, 24000, 48000].includes(sampleRate) ||
                ![1, 2].includes(channels) ||
                !Number.isInteger(frameSamples) || 0 >= frameSamples ||
                !Number.isInteger(preSkip) || 0 > preSkip || 0xffff < preSkip ||
                0 !== (frameSamples * 48000) % sampleRate)
            {
                throw new Error("Unsupported hardware Opus stream");
            }

            this.sampleRate = sampleRate;
            this.channels = channels;
            this.frameSamples = frameSamples;
            this.preSkip = preSkip;
            this.pageSequence = 0;
            this.granule = BigInt(preSkip);
        }

        makePage(packet, headerType, granule)
        {
            const payload = asBytes(packet);
            const segments = [];
            let remaining = payload.length;

            while (255 <= remaining)
            {
                segments.push(255);
                remaining -= 255;
            }
            if (0 < payload.length)
            {
                segments.push(remaining);
            }
            const page = new Uint8Array(27 + segments.length + payload.length);
            const view = new DataView(page.buffer);

            page.set([0x4f, 0x67, 0x67, 0x53], 0);
            page[4] = 0;
            page[5] = headerType;
            writeLe64(view, 6, granule);
            view.setUint32(14, OGG_SERIAL, true);
            view.setUint32(18, this.pageSequence, true);
            page[26] = segments.length;
            page.set(segments, 27);
            page.set(payload, 27 + segments.length);
            view.setUint32(22, oggCrc(page), true);
            this.pageSequence++;

            return page;
        }

        start()
        {
            const encoder = new TextEncoder();
            const vendor = encoder.encode("AgentPet");
            const head = new Uint8Array(19);
            const headView = new DataView(head.buffer);
            const tags = new Uint8Array(16 + vendor.length);
            const tagsView = new DataView(tags.buffer);

            head.set(encoder.encode("OpusHead"), 0);
            head[8] = 1;
            head[9] = this.channels;
            headView.setUint16(10, this.preSkip, true);
            headView.setUint32(12, this.sampleRate, true);
            head[18] = 0;

            tags.set(encoder.encode("OpusTags"), 0);
            tagsView.setUint32(8, vendor.length, true);
            tags.set(vendor, 12);
            tagsView.setUint32(12 + vendor.length, 0, true);

            return [
                this.makePage(head, 0x02, 0n),
                this.makePage(tags, 0x00, 0n)
            ];
        }

        appendPacket(packet)
        {
            const payload = asBytes(packet);
            if (0 === payload.length || OPUS_MAX_PACKET_BYTES < payload.length)
            {
                throw new Error("Invalid hardware Opus packet");
            }
            this.granule += BigInt((this.frameSamples * 48000) / this.sampleRate);
            return this.makePage(payload, 0x00, this.granule);
        }

        finish()
        {
            return this.makePage(new Uint8Array(), 0x04, this.granule);
        }
    }

    class HardwareAudioReceiver
    {
        constructor(options = {})
        {
            this.onStart = options.onStart || (async () => {});
            this.onChunk = options.onChunk || (async () => {});
            this.onFinish = options.onFinish || (async () => {});
            this.onCancel = options.onCancel || (async () => {});
            this.onError = options.onError || (() => {});
            this.queue = Promise.resolve();
            this.resetState();
        }

        resetState()
        {
            this.session = 0;
            this.expectedSequence = 0;
            this.pending = null;
            this.assembler = null;
            this.active = false;
            this.ignoredSession = 0;
        }

        push(value)
        {
            const frame = asBytes(value).slice();
            this.queue = this.queue
                .then(() => this.handleFrame(frame))
                .catch((error) => this.fail(error));
            return this.queue;
        }

        disconnect()
        {
            this.queue = this.queue.then(async () => {
                const shouldCancel = this.active;
                this.resetState();
                if (shouldCancel)
                {
                    await this.onCancel();
                }
            }).catch((error) => this.onError(error));
            return this.queue;
        }

        async fail(error)
        {
            const ignoredSession = this.session ||
                (this.pending && this.pending.session) || 0;
            const shouldCancel = this.active;
            this.resetState();
            this.ignoredSession = ignoredSession;
            if (shouldCancel)
            {
                try
                {
                    await this.onCancel();
                }
                catch (_cancelError)
                {
                    /* Preserve the original transport or protocol error. */
                }
            }
            this.onError(error instanceof Error ? error : new Error(String(error)));
        }

        async handleFrame(value)
        {
            const frame = parseAudioFrame(value);
            if (!this.pending)
            {
                if (0 !== frame.fragmentIndex)
                {
                    throw new Error("Hardware audio fragment gap");
                }
                this.pending = {
                    type: frame.type,
                    session: frame.session,
                    sequence: frame.sequence,
                    fragmentCount: frame.fragmentCount,
                    nextFragment: 0,
                    chunks: []
                };
            }
            const pending = this.pending;
            if (pending.type !== frame.type ||
                pending.session !== frame.session ||
                pending.sequence !== frame.sequence ||
                pending.fragmentCount !== frame.fragmentCount ||
                pending.nextFragment !== frame.fragmentIndex)
            {
                throw new Error("Hardware audio fragment order mismatch");
            }
            pending.chunks.push(frame.payload);
            pending.nextFragment++;
            if (pending.nextFragment !== pending.fragmentCount)
            {
                return;
            }

            this.pending = null;
            await this.handlePayload(
                pending.type,
                pending.session,
                pending.sequence,
                concatBytes(pending.chunks)
            );
        }

        async handlePayload(type, session, sequence, payload)
        {
            if (this.ignoredSession === session && AUDIO_TYPE_START !== type)
            {
                if ([AUDIO_TYPE_END, AUDIO_TYPE_ERROR].includes(type))
                {
                    this.ignoredSession = 0;
                }
                return;
            }
            if (AUDIO_TYPE_START === type)
            {
                if (12 !== payload.length || 0 !== sequence)
                {
                    throw new Error("Invalid hardware audio start");
                }
                if (this.active)
                {
                    await this.onCancel();
                }
                const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
                const metadata = {
                    sampleRate: view.getUint32(0, true),
                    channels: payload[4],
                    frameSamples: view.getUint16(5, true),
                    preSkip: view.getUint16(7, true),
                    bitrate: payload[9] | (payload[10] << 8) | (payload[11] << 16)
                };

                this.session = session;
                this.expectedSequence = 0;
                this.ignoredSession = 0;
                this.assembler = new OggOpusAssembler(metadata);
                this.active = true;
                await this.onStart(metadata);
                for (const chunk of this.assembler.start())
                {
                    await this.onChunk(chunk);
                }
                return;
            }
            if (AUDIO_TYPE_ERROR === type)
            {
                const errorCode = payload[0] || 0;
                const message = {
                    2: "Device microphone is busy with local recording",
                    3: "Device rejected the audio stream state"
                }[errorCode] || `Hardware stopped audio upload (code ${errorCode})`;
                throw new Error(message);
            }
            if (!this.active || this.session !== session || !this.assembler)
            {
                throw new Error("Hardware audio session is not active");
            }
            if (AUDIO_TYPE_DATA === type)
            {
                if (sequence !== this.expectedSequence)
                {
                    throw new Error(
                        `Hardware audio packet gap: expected ${this.expectedSequence}, got ${sequence}`
                    );
                }
                await this.onChunk(this.assembler.appendPacket(payload));
                this.expectedSequence++;
                if (AUDIO_SEQUENCE_MAX < this.expectedSequence)
                {
                    throw new Error("Hardware audio sequence overflow");
                }
                return;
            }
            if (AUDIO_TYPE_END !== type || 8 !== payload.length)
            {
                throw new Error("Invalid hardware audio end");
            }

            const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
            const packetCount = view.getUint32(0, true);
            const droppedPackets = view.getUint32(4, true);
            if ((packetCount & AUDIO_SEQUENCE_MAX) !== sequence ||
                packetCount !== this.expectedSequence || 0 !== droppedPackets)
            {
                throw new Error(
                    `Incomplete hardware audio: received ${this.expectedSequence}/${packetCount}, dropped ${droppedPackets}`
                );
            }

            await this.onChunk(this.assembler.finish());
            this.active = false;
            this.session = 0;
            this.assembler = null;
            await this.onFinish();
        }
    }

    const API = Object.freeze({
        AUDIO_FRAME_OVERHEAD,
        AUDIO_MAGIC_FIRST,
        AUDIO_MAGIC_SECOND,
        AUDIO_PROTOCOL_VERSION,
        AUDIO_SEQUENCE_MAX,
        AUDIO_TYPE_DATA,
        AUDIO_TYPE_END,
        AUDIO_TYPE_ERROR,
        AUDIO_TYPE_START,
        HardwareAudioReceiver,
        OggOpusAssembler,
        crc8Atm,
        oggCrc,
        parseAudioFrame
    });

    if ("undefined" !== typeof module && module.exports)
    {
        module.exports = API;
    }
    if ("undefined" !== typeof window)
    {
        window.AgentPetHardwareAudio = API;
    }
})("undefined" !== typeof window ? window : globalThis);
