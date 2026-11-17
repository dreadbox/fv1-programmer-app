# FV-1 Programmer Web App

Browser-based interface for the [Nymphes FV-1 Programmer][fw] hardware. Loads
FV-1 `.bin`/`.hex`/`.fv1` audio programs into the programmer's local EEPROM,
sends them to a connected FV-1 target, and updates the programmer's firmware
over USB -- all without any native install.

[fw]: https://github.com/giuanz/Nymphes_fv1_programmer

## Requirements

- A Chromium-based browser (Chrome, Edge, Opera, Arc). Web Serial is not
  available in Safari and is not enabled by default in Firefox.
- The Nymphes FV-1 Programmer hardware, with firmware that speaks the
  protocol described in [`PROTOCOL.md`][protocol] of the firmware repo.

[protocol]: https://github.com/giuanz/Nymphes_fv1_programmer/blob/main/PROTOCOL.md

## Features

- **8 program slots** (512 B each, 4 KB total) representing the FV-1's
  EEPROM layout. Pick a `.bin`/`.hex`/`.fv1` file per slot; the programmer
  EEPROM is written with each program at its fixed slot offset (empty slots zeroed).
- **Auto-populate on connect.** When you click Connect, the app reads the
  current EEPROM and fills the slot grid with whatever is on the device
  (`Program 0`, `Program 1`, ...) -- you see exactly what's loaded the
  moment you plug in.
- **Read & Download** dumps the EEPROM as a `.fv1` file for backup.
- **Send to FV-1** copies the local EEPROM into the FV-1 target via the
  programmer's I2C bus -- equivalent to pressing the hardware button.
- **Firmware update** over USB. Pick a firmware `.bin`, the app reboots
  the programmer into its bootloader, flashes the image, verifies CRC, and
  reconnects automatically. The build number is read out of a stamp
  embedded in the `.bin` so users never have to think about versioning.

## Development

```sh
npm install
npm run dev     # http://localhost:5173
```

A static production build (`npm run build`) lands in `build/` and is served
as-is by any static host -- no server runtime required.

## Deployment

GitHub Actions deploys the static build to GitHub Pages on every push to
`main`. In the repository settings, set **Pages → Build and deployment →
Source** to **GitHub Actions**. The workflow builds with the project-page base
path; local development and other static hosts continue to use the root path.

## Project layout

```
src/
  lib/
    serial.ts       # Web Serial wrapper: persistent per-port reader,
                    # high-level command helpers (verifyDevice, getVersion,
                    # readEEPROM, writeEEPROM, copyToTarget)
    bootloader.ts   # Bootloader-mode CDC protocol + updateFirmware()
                    # orchestrator (reboot dance, port re-enumeration,
                    # CRC32, build-number stamp parser)
    components/ui/  # bits-ui-based Button wrapper
    utils.ts        # cn() tailwind helper
  routes/
    +page.svelte    # Single-page UI: status bar, slot grid, action cards,
                    # firmware-update card + confirm modal
```

Stack: SvelteKit (Svelte 5 runes) + TypeScript + Tailwind 4 + Vite +
bits-ui + Iconify (lucide). Static adapter.
