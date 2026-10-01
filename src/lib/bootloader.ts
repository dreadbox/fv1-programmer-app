/**
 * Bootloader OTA firmware-update client for the FV1 Programmer.
 *
 * Implements the host side of the protocol documented in PROTOCOL.md of the
 * firmware repo. Mirrors the structure of scripts/firmware_update.py 1:1.
 *
 *   reboot app -> wait for bootloader port -> B/E/P/M/C/G -> wait for app port
 */

import { BAUD_RATE, closePort, flushPort, openPort, readLine, writeBytes } from './serial';

export const USB_VID = 0x381e;
export const APP_PID = 0x000a;
export const BOOTLOADER_PID = 0x800a;

export const APP_BASE_ADDR = 0x08004000;
export const PAGE_SIZE = 128;
export const MAX_APP_SIZE = 48 * 1024;
export const APP_MAGIC = 0xdeadbeef;

// Web Serial transient user-activation lasts ~5 s from the originating click,
// and requestPort() consumes it. We need to fall back to the browser picker
// well within that window when the user hasn't previously granted the
// bootloader port. Keep the silent-poll budget short so requestPort is called
// with plenty of activation left.
const PORT_DISCOVERY_TIMEOUT_MS = 1500;
const PORT_POLL_INTERVAL_MS = 200;

export type UpdatePhase =
	| 'rebooting'
	| 'waiting-for-bootloader'
	| 'identifying'
	| 'erasing'
	| 'programming'
	| 'writing-metadata'
	| 'verifying'
	| 'jumping'
	| 'waiting-for-app'
	| 'reconnecting';

export interface UpdateCallbacks {
	onPhase?: (phase: UpdatePhase) => void;
	onProgress?: (current: number, total: number) => void;
}

export interface UpdateResult {
	success: boolean;
	message: string;
	newPort: SerialPort | null; // freshly opened app port after jump, or null if reconnect failed
}

// ---------- App version stamp ----------
// Firmware embeds { magic, version } in a .app_version section placed
// immediately after the vector table (around offset 0xC0). See PROTOCOL.md.

const APP_VERSION_MAGIC = 0x53524556; // 'V','E','R','S' little-endian
const APP_VERSION_SCAN_LIMIT = 512; // search this many bytes from start

export function extractFirmwareVersion(data: Uint8Array): number | null {
	const end = Math.min(data.length - 8, APP_VERSION_SCAN_LIMIT);
	for (let i = 0; i <= end; i += 4) {
		const m =
			(data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24)) >>> 0;
		if (m === APP_VERSION_MAGIC) {
			return (
				(data[i + 4] |
					(data[i + 5] << 8) |
					(data[i + 6] << 16) |
					(data[i + 7] << 24)) >>>
				0
			);
		}
	}
	return null;
}

// ---------- CRC32 (IEEE 802.3, zlib-compatible) ----------

const CRC32_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		t[i] = c >>> 0;
	}
	return t;
})();

export function crc32(data: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < data.length; i++) {
		c = CRC32_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

// ---------- Padding ----------

export function padFirmware(data: Uint8Array): Uint8Array {
	const remainder = data.length % PAGE_SIZE;
	if (remainder === 0) return data;
	const padded = new Uint8Array(data.length + (PAGE_SIZE - remainder));
	padded.set(data);
	padded.fill(0xff, data.length);
	return padded;
}

// ---------- Low-level CDC I/O ----------

async function expect(port: SerialPort, expected: string, timeoutMs = 2000): Promise<void> {
	const got = await readLine(port, timeoutMs);
	if (got !== expected) {
		throw new Error(`Expected "${expected}", got "${got}"`);
	}
}

function leAddress(addr: number): Uint8Array {
	const buf = new Uint8Array(4);
	buf[0] = addr & 0xff;
	buf[1] = (addr >>> 8) & 0xff;
	buf[2] = (addr >>> 16) & 0xff;
	buf[3] = (addr >>> 24) & 0xff;
	return buf;
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((s, p) => s + p.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

// ---------- Bootloader commands ----------

async function identifyBootloader(port: SerialPort): Promise<void> {
	await writeBytes(port, new TextEncoder().encode('B'));
	await expect(port, 'BOOTLOADER_V1.0');
}

async function erasePage(port: SerialPort, addr: number): Promise<void> {
	await writeBytes(port, concat(new Uint8Array([0x45 /* 'E' */]), leAddress(addr)));
	await expect(port, 'ERASE_OK');
}

async function programPage(port: SerialPort, addr: number, page: Uint8Array): Promise<void> {
	if (page.length !== PAGE_SIZE) throw new Error(`Page must be ${PAGE_SIZE} bytes`);
	await writeBytes(port, concat(new Uint8Array([0x50 /* 'P' */]), leAddress(addr), page));
	await expect(port, 'PROG_OK');
}

async function writeMetadata(port: SerialPort, meta: Uint8Array): Promise<void> {
	if (meta.length !== PAGE_SIZE) throw new Error(`Metadata must be ${PAGE_SIZE} bytes`);
	await writeBytes(port, concat(new Uint8Array([0x4d /* 'M' */]), meta));
	await expect(port, 'META_OK', 5000);
}

async function verifyCrc(port: SerialPort, expectedCrc: number): Promise<void> {
	await writeBytes(port, concat(new Uint8Array([0x43 /* 'C' */]), leAddress(expectedCrc)));
	await expect(port, 'CRC_OK', 5000);
}

async function jumpToApp(port: SerialPort): Promise<void> {
	await writeBytes(port, new TextEncoder().encode('G'));
	// "JUMPING...\n" is sent then USB drops within ~50ms; don't require the read
	// to succeed, but try briefly so we don't proceed before the device starts to reset.
	try {
		await readLine(port, 500);
	} catch {
		// ignore -- device may have already dropped USB
	}
}

// ---------- App -> bootloader transition ----------

export async function rebootToBootloader(appPort: SerialPort): Promise<void> {
	flushPort(appPort);
	await writeBytes(appPort, new TextEncoder().encode('U'));
	try {
		await readLine(appPort, 1000); // "REBOOTING...\n"
	} catch {
		// some hosts swallow the ack on race conditions -- still try to close
	}
}

// ---------- Port discovery ----------

async function findPortByProduct(
	pid: number,
	timeoutMs: number,
	abortSignal?: AbortSignal
): Promise<SerialPort | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (abortSignal?.aborted) return null;
		const ports = await navigator.serial.getPorts();
		for (const p of ports) {
			const info = p.getInfo();
			if (info.usbVendorId === USB_VID && info.usbProductId === pid) {
				return p;
			}
		}
		await new Promise((r) => setTimeout(r, PORT_POLL_INTERVAL_MS));
	}
	return null;
}

export async function findOrPromptBootloaderPort(): Promise<SerialPort> {
	const p = await findPortByProduct(BOOTLOADER_PID, PORT_DISCOVERY_TIMEOUT_MS);
	if (p) return p;
	// Fall back to user picker scoped to the bootloader PID
	return await navigator.serial.requestPort({
		filters: [{ usbVendorId: USB_VID, usbProductId: BOOTLOADER_PID }]
	});
}

export async function findOrPromptAppPort(): Promise<SerialPort> {
	const p = await findPortByProduct(APP_PID, PORT_DISCOVERY_TIMEOUT_MS);
	if (p) return p;
	return await navigator.serial.requestPort({
		filters: [{ usbVendorId: USB_VID, usbProductId: APP_PID }]
	});
}

// ---------- Metadata block ----------

function buildMetadata(appSize: number, crc: number, version: number): Uint8Array {
	const meta = new Uint8Array(PAGE_SIZE);
	const view = new DataView(meta.buffer);
	view.setUint32(0, APP_MAGIC, true);
	view.setUint32(4, appSize, true);
	view.setUint32(8, crc, true);
	view.setUint32(12, version, true);
	// reserved[112] left as 0x00
	return meta;
}

// ---------- High-level orchestrator ----------

export async function updateFirmware(
	currentAppPort: SerialPort,
	firmware: Uint8Array,
	version: number,
	cb: UpdateCallbacks = {}
): Promise<UpdateResult> {
	if (firmware.length === 0) {
		return { success: false, message: 'Firmware is empty', newPort: null };
	}
	if (firmware.length > MAX_APP_SIZE) {
		return {
			success: false,
			message: `Firmware too large (${firmware.length} B, max ${MAX_APP_SIZE})`,
			newPort: null
		};
	}

	const padded = padFirmware(firmware);
	const numPages = padded.length / PAGE_SIZE;
	const fwCrc = crc32(padded);

	// Phase 1: reboot the running app into the bootloader
	cb.onPhase?.('rebooting');
	try {
		await rebootToBootloader(currentAppPort);
	} catch (e) {
		return { success: false, message: `Failed to send reboot command: ${e}`, newPort: null };
	}
	try {
		await closePort(currentAppPort);
	} catch {
		// the device is dropping USB anyway -- ignore
	}

	// Phase 2: wait for the bootloader port to appear
	cb.onPhase?.('waiting-for-bootloader');
	let blPort: SerialPort;
	try {
		blPort = await findOrPromptBootloaderPort();
	} catch (e) {
		return { success: false, message: `Could not find bootloader port: ${e}`, newPort: null };
	}

	try {
		await openPort(blPort);
	} catch (e) {
		return { success: false, message: `Could not open bootloader port: ${e}`, newPort: null };
	}

	// Phase 3..7: identify -> erase -> program -> metadata -> verify -> jump
	try {
		flushPort(blPort);
		cb.onPhase?.('identifying');
		await identifyBootloader(blPort);

		cb.onPhase?.('erasing');
		cb.onProgress?.(0, numPages);
		for (let i = 0; i < numPages; i++) {
			await erasePage(blPort, APP_BASE_ADDR + i * PAGE_SIZE);
			cb.onProgress?.(i + 1, numPages);
		}

		cb.onPhase?.('programming');
		cb.onProgress?.(0, numPages);
		for (let i = 0; i < numPages; i++) {
			const page = padded.subarray(i * PAGE_SIZE, (i + 1) * PAGE_SIZE);
			await programPage(blPort, APP_BASE_ADDR + i * PAGE_SIZE, page);
			cb.onProgress?.(i + 1, numPages);
		}

		cb.onPhase?.('writing-metadata');
		await writeMetadata(blPort, buildMetadata(padded.length, fwCrc, version));

		cb.onPhase?.('verifying');
		await verifyCrc(blPort, fwCrc);

		cb.onPhase?.('jumping');
		await jumpToApp(blPort);
	} catch (e) {
		try {
			await closePort(blPort);
		} catch {
			// best effort
		}
		return {
			success: false,
			message: `Update failed: ${e instanceof Error ? e.message : e}`,
			newPort: null
		};
	}

	try {
		await closePort(blPort);
	} catch {
		// the device has already left bootloader mode -- ignore
	}

	// Phase 8: wait for app to re-enumerate, reopen
	cb.onPhase?.('waiting-for-app');
	let appPort: SerialPort | null = null;
	try {
		appPort = await findOrPromptAppPort();
	} catch {
		return {
			success: true,
			message: 'Firmware updated. Reconnect to the device manually.',
			newPort: null
		};
	}

	cb.onPhase?.('reconnecting');
	try {
		await openPort(appPort);
	} catch (e) {
		return {
			success: true,
			message: `Firmware updated but reconnect failed: ${e}`,
			newPort: null
		};
	}

	return { success: true, message: 'Firmware updated successfully', newPort: appPort };
}

// Re-export for convenience so callers only need to import from one place
export { BAUD_RATE };
