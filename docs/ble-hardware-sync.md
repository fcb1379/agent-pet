# BLE hardware sync

The desktop app acts as the BLE Central and the SF32 Agent Pet acts as the
Peripheral. The link transports bounded status frames and the user-selected
mascot JPEG. Task text, working directories, commands, file names, approval
contents, and user prompts are never sent.

## GATT contract

| Item | UUID | Access |
|---|---|---|
| Agent Pet service | `7a1e0001-6b5f-4f5c-8c9d-3e2f1a0b1000` | Primary service |
| Status RX | `7a1e0002-6b5f-4f5c-8c9d-3e2f1a0b1000` | Write Request |
| Mascot image RX | 7a1e0003-6b5f-4f5c-8c9d-3e2f1a0b1000 | Write Request |

Every write is a fixed 20-byte Agent Pet v1 frame. A complete snapshot contains
the aggregate pet state plus up to 12 Agent sessions. The desktop sends a new
complete snapshot after connecting, reconnecting, or observing a state change.

The image characteristic also uses fixed 20-byte frames. Selecting a desktop
mascot generates the exact 336 x 336 JPEG used by both displays (maximum 128
KiB). The desktop sends begin, ordered 11-byte data chunks, and commit frames.
The firmware accepts a commit only after CRC-8 frame checks, ordered offsets,
CRC-32/MPEG-2 verification, and JPEG SOI/EOI validation. It writes through a
bounded static worker queue to `/pet.tmp`, then atomically replaces `/pet.jpg`
with backup recovery. Disconnects discard only the temporary file; normal power
cycles restore `/pet.jpg`. Restoring the desktop default sends a reset frame and
returns the device to the built-in mascot.
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
   repository's `feat/ble-agent-pet-sync` branch.
2. Confirm that `AgentPet-HS52` advertises the Agent Pet service UUID.
3. Start this desktop repository from its `feat/ble-agent-pet-sync` branch with
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
