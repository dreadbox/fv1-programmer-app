# FV1 Programmer Web Application - Development Notes

## What was built

A web application that replicates the functionality of the Python scripts (`write_fv1.py` and `read_fv1.py`) using the Web Serial API.

**Tech Stack:**
- SvelteKit with Svelte 5
- TypeScript
- Tailwind CSS v4
- bits-ui components
- mode-watcher for dark mode

**Features:**
- Connect/Disconnect to FV1 Programmer via Web Serial API
- Device verification (sends `'I'` command, checks for `FV1_PROGRAMMER` response)
- Write to EEPROM - upload multiple .fv1 files, concatenate, pad to 4KB
- Read from EEPROM - download as .fv1 file
- Progress indicator
- Dark mode toggle
- Browser compatibility warning (Chrome/Edge/Opera only)

## Project Structure

```
fv1-programmer/
├── src/
│   ├── app.css, app.html, app.d.ts
│   ├── lib/
│   │   ├── serial.ts        # Web Serial API wrapper
│   │   ├── utils.ts
│   │   └── components/ui/button/
│   └── routes/
│       ├── +layout.svelte, +layout.ts
│       └── +page.svelte     # Main UI
├── package.json, svelte.config.js, vite.config.ts, tsconfig.json
```

## Protocol (from Python scripts)

| Command | Send | Receive |
|---------|------|---------|
| Identify | `'I'` | `'FV1_PROGRAMMER...'` |
| Write | `'W'` + 4096 bytes | `'OK'` or `'ERROR'` |
| Read | `'R'` | 4096 bytes |

- Baud rate: 115200
- EEPROM size: 4096 bytes

## Known Issues (RESOLVED)

1. **Device verification not working properly** - Fixed the read function to handle variable-length responses, but needs testing

2. **Write button crashes/freezes the programmer** - FIXED

   **Root cause:** Web Serial API sends data differently than pyserial. Sending 4KB all at once overwhelmed the device's receive buffer.

   **Solution:** Send data in 64-byte chunks with 5ms delays between each chunk.

   The Python script works because pyserial's underlying driver handles buffering/flow control differently than Web Serial API's raw approach.

## Setup & Running

### Prerequisites
- Node.js (v20+ recommended)
- npm

### Install Dependencies
```bash
cd /Users/giulianoanzani/Work/Nymphes/fv1-programmer
npm install
```

### Development
```bash
npm run dev
```
Opens at `http://localhost:5173`. Hot-reload enabled.

### Build for Production
```bash
npm run build
```
Output goes to `build/` folder. This is a static site that can be hosted anywhere.

### Preview Production Build
```bash
npm run preview
```

### Browser Requirements
Web Serial API only works in **Chrome, Edge, or Opera**. Firefox and Safari are not supported.

---

## Codebase Guide

### Where to Find Things

| What you want to change | File location |
|------------------------|---------------|
| **Main UI / page layout** | `src/routes/+page.svelte` |
| **Serial communication logic** | `src/lib/serial.ts` |
| **Styling / colors / theme** | `src/app.css` |
| **Button component** | `src/lib/components/ui/button/` |

### Key Files Explained

**`src/routes/+page.svelte`** - The main (and only) page of the app
- Contains all UI components (connect button, file upload, write/read sections)
- State management using Svelte 5 runes (`$state`, `$derived`)
- Calls functions from `serial.ts` for device communication

**`src/lib/serial.ts`** - All serial port logic
- `requestPort()` / `openPort()` / `closePort()` - Connection management
- `verifyDevice()` - Sends 'I' command, checks for FV1_PROGRAMMER response
- `writeEEPROM()` - Sends 'W' + data in 64-byte chunks
- `readEEPROM()` - Sends 'R', reads 4096 bytes
- `concatenateAndPad()` - Combines multiple .fv1 files, pads to 4KB

**`src/app.css`** - Design tokens and global styles
- Uses OKLch color space for theme colors
- Defines `--background`, `--foreground`, `--primary`, etc.
- Dark mode variables in `.dark` class

**`src/lib/utils.ts`** - Utility functions
- `cn()` - Combines Tailwind classes (like clsx + tailwind-merge)

### Common Modifications

**Change chunk size or delay for write:**
Edit `writeEEPROM()` in `src/lib/serial.ts`:
```typescript
const CHUNK_SIZE = 64;  // bytes per chunk
await new Promise((resolve) => setTimeout(resolve, 5));  // delay in ms
```

**Add a new serial command:**
Add a new async function in `src/lib/serial.ts` following the pattern of `verifyDevice()`.

**Change colors/theme:**
Edit the CSS variables in `src/app.css` under `:root` (light) and `.dark` (dark mode).

---

## Reference

- Python scripts: `/Users/giulianoanzani/Work/Nymphes/Nymphes_fv1_programmer/Fv1_programmer/scripts/`
- Similar app (sysex-manager): `/Users/giulianoanzani/Work/Nymphes/sysex-manager/`
