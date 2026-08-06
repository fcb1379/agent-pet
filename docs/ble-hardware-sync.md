# BLE hardware sync

The desktop app acts as the BLE Central and the SF32 Agent Pet acts as the
Peripheral. The link transports bounded status frames and the user-selected
mascot JPEG or GIF asset. Task text, working directories, commands, file names,
approval contents, and user prompts are never sent.

## GATT contract

| Item | UUID | Access |
|---|---|---|
| Agent Pet service | `7a1e0001-6b5f-4f5c-8c9d-3e2f1a0b1000` | Primary service |
| Status RX | `7a1e0002-6b5f-4f5c-8c9d-3e2f1a0b1000` | Write Request |
| Mascot image RX | 7a1e0003-6b5f-4f5c-8c9d-3e2f1a0b1000 | Write Request |

Status and wooden-fish writes remain fixed 20-byte Agent Pet v1 frames. A
complete snapshot contains the aggregate pet state plus up to 12 Agent sessions.
The desktop sends a new complete snapshot after connecting, reconnecting, or
observing a state change.

Image begin, commit, and reset control packets remain 20 bytes. Image data
packets are variable length: an 8-byte header, 1-235 bytes of image data, and a
trailing CRC-8 byte (9-244 bytes total). The desktop tries packet sizes of 244,
185, 129, 73, and 20 bytes in order. If the central platform, negotiated ATT
MTU, or older firmware rejects a larger packet, a new begin packet safely
restarts the transfer at the next size. The 20-byte fallback is byte-for-byte
compatible with the first image protocol implementation.

The firmware copies incoming image writes into a bounded worker queue before
writing them to flash. The desktop deliberately yields between image packets so
the worker can drain that queue. After a rejected write, it also waits for stale
packets to drain before restarting with the next packet size; this prevents a
fallback BEGIN packet from being interleaved with packets from the failed
attempt.

Selecting a still desktop mascot generates a 336 x 336 baseline JPEG (maximum
128 KiB). Selecting an animated GIF keeps the original file for desktop display
and generates a separate hardware-only GIF89a asset. The conversion automatically
reduces the palette, canvas size, or sampled frame count as needed while
preserving total playback time (maximum 512 KiB and 120 output frames). The
firmware accepts
a commit only after CRC-8 packet checks, ordered offsets, CRC-32/MPEG-2
verification, and format-specific structure validation. It writes through a
bounded static worker queue to `/pet.tmp`, then atomically replaces `/pet.img`
with backup recovery. Existing `/pet.jpg` files are migrated on startup.
Disconnects discard only the temporary file; normal power cycles restore the
committed image. Restoring the
desktop default sends a reset frame and returns the device to the built-in
mascot.
The aggregate state drives the hardware pet presentation:

| Desktop state | Code | Hardware pet state |
|---|---:|---|
| `idle` | 0 | idle |
| `running` | 1 | working |
| `needs_input` | 2 | waiting for the user |
| `completed` | 3 | completed |
| `error` | 4 | error |

## Debug procedure

1. Build and flash the `sf32lb52-lchspi-ulp` firmware from the hardware
   repository's `feat/ble-custom-mascot-sync` branch.
2. Confirm that `AgentPet-HS52` advertises the Agent Pet service UUID.
3. Start this desktop repository from its `feat/ble-custom-mascot-sync` branch with
   `npm run dev`.
4. Click the `BLE` button. The scan automatically selects a device whose name
   starts with `AgentPet-`; it times out after 15 seconds.
5. Trigger each Agent lifecycle state and confirm the hardware text, color, and
   pet animation update.
6. Power-cycle the hardware. The desktop retries the saved GATT device every two
   seconds and sends the newest complete snapshot after reconnecting.

Run `npm test` to verify the desktop encoder against the firmware golden frame.
Run `tests/run_agent_pet_protocol_host_test.ps1` in the hardware repository to
verify firmware frame validation and reassembly.
