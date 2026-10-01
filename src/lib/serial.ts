/**
 * Web Serial wrapper for the FV1 Programmer.
 *
 * Each open SerialPort gets a persistent background read loop that drains
 * incoming bytes into a per-port buffer. High-level commands send their
 * request via writeBytes() and consume the response via readLine() or
 * readBytes(), which read non-destructively from that buffer -- they never
 * call reader.cancel(), so back-to-back commands no longer leave the
 * readable stream in a closed-but-not-recycled state.
 */

export const BAUD_RATE = 115200;
export const EEPROM_SIZE = 4096;

// ----- internal connection state ----------------------------------------

interface ConnectionState {
	reader: ReadableStreamDefaultReader<Uint8Array>;
	buffer: Uint8Array;
	waiters: Array<() => void>;
	readLoopPromise: Promise<void>;
	closed: boolean;
}

const connectionStates = new Map<SerialPort, ConnectionState>();

function getState(port: SerialPort): ConnectionState {
	const state = connectionStates.get(port);
	if (!state) {
		throw new Error('Port not open (openPort must be called first)');
	}
	return state;
}

function notifyWaiters(state: ConnectionState) {
	const w = state.waiters;
	state.waiters = [];
	for (const fn of w) fn();
}

async function runReadLoop(state: ConnectionState): Promise<void> {
	try {
		while (!state.closed) {
			const { value, done } = await state.reader.read();
			if (done) break;
			if (value && value.length > 0) {
				const merged = new Uint8Array(state.buffer.length + value.length);
				merged.set(state.buffer);
				merged.set(value, state.buffer.length);
				state.buffer = merged;
				notifyWaiters(state);
			}
		}
	} catch {
		// Reader cancelled by close() or USB disconnect -- expected
	} finally {
		state.closed = true;
		notifyWaiters(state); // wake any pending readLine/readBytes so they fail fast
	}
}

function waitForData(state: ConnectionState, timeoutMs: number): Promise<void> {
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const done = () => {
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
			resolve();
		};
		state.waiters.push(done);
		timer = setTimeout(() => {
			const idx = state.waiters.indexOf(done);
			if (idx >= 0) state.waiters.splice(idx, 1);
			timer = null;
			resolve();
		}, timeoutMs);
	});
}

// ----- low-level public API ---------------------------------------------

export function isWebSerialSupported(): boolean {
	return 'serial' in navigator;
}

export async function requestPort(): Promise<SerialPort> {
	return await navigator.serial.requestPort();
}

export async function openPort(port: SerialPort, baudRate = BAUD_RATE): Promise<void> {
	if (connectionStates.has(port)) return;
	await port.open({ baudRate });
	if (!port.readable) throw new Error('Port has no readable stream after open');
	const reader = port.readable.getReader();
	const state: ConnectionState = {
		reader,
		buffer: new Uint8Array(0),
		waiters: [],
		readLoopPromise: Promise.resolve(),
		closed: false
	};
	connectionStates.set(port, state);
	state.readLoopPromise = runReadLoop(state);
}

export async function closePort(port: SerialPort): Promise<void> {
	const state = connectionStates.get(port);
	if (state) {
		state.closed = true;
		try {
			await state.reader.cancel();
		} catch {
			// Reader may already be done
		}
		try {
			state.reader.releaseLock();
		} catch {
			// Already released
		}
		try {
			await state.readLoopPromise;
		} catch {
			// Loop may have thrown -- ignore
		}
		connectionStates.delete(port);
	}
	try {
		await port.close();
	} catch {
		// Port may already be in a closing state from a USB disconnect
	}
}

export async function writeBytes(port: SerialPort, data: Uint8Array): Promise<void> {
	const writer = port.writable?.getWriter();
	if (!writer) throw new Error('Port not writable');
	try {
		await writer.write(data);
	} finally {
		writer.releaseLock();
	}
}

export async function readLine(port: SerialPort, timeoutMs = 2000): Promise<string> {
	const state = getState(port);
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const nlIdx = state.buffer.indexOf(0x0a);
		if (nlIdx >= 0) {
			const lineBytes = state.buffer.subarray(0, nlIdx);
			const line = new TextDecoder().decode(lineBytes).replace(/\r$/, '');
			state.buffer = state.buffer.slice(nlIdx + 1);
			return line;
		}
		if (state.closed) {
			throw new Error(`Port closed (have ${state.buffer.length} buffered bytes)`);
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw new Error(`readLine timeout (have ${state.buffer.length} buffered bytes)`);
		}
		await waitForData(state, remaining);
	}
}

export async function readBytes(
	port: SerialPort,
	n: number,
	timeoutMs = 5000
): Promise<Uint8Array> {
	const state = getState(port);
	const deadline = Date.now() + timeoutMs;
	while (state.buffer.length < n) {
		if (state.closed) {
			throw new Error(`Port closed (got ${state.buffer.length}/${n} bytes)`);
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw new Error(`readBytes timeout (got ${state.buffer.length}/${n} bytes)`);
		}
		await waitForData(state, remaining);
	}
	const out = state.buffer.slice(0, n);
	state.buffer = state.buffer.slice(n);
	return out;
}

export function flushPort(port: SerialPort): void {
	const state = connectionStates.get(port);
	if (state) state.buffer = new Uint8Array(0);
}

// ----- high-level command helpers --------------------------------------

const ENCODER = new TextEncoder();

export async function verifyDevice(
	port: SerialPort
): Promise<{ verified: boolean; info: string }> {
	flushPort(port);
	try {
		await writeBytes(port, ENCODER.encode('I'));
		const text = await readLine(port, 1000);
		if (text.includes('FV1_PROGRAMMER')) {
			return { verified: true, info: text };
		}
		return { verified: false, info: `Unknown device: ${text}` };
	} catch (e) {
		return { verified: false, info: `${e}` };
	}
}

export async function getVersion(
	port: SerialPort
): Promise<{ version: number | null; message: string }> {
	flushPort(port);
	try {
		await writeBytes(port, ENCODER.encode('?'));
		const text = await readLine(port, 1000);
		if (text.startsWith('VERSION ')) {
			const n = parseInt(text.slice(8), 10);
			if (Number.isFinite(n)) {
				return { version: n, message: text };
			}
		}
		if (text.includes('META_INVALID')) {
			return { version: null, message: 'No valid metadata (flashed via ST-Link?)' };
		}
		return { version: null, message: text || 'No response' };
	} catch (e) {
		return { version: null, message: `Version query failed: ${e}` };
	}
}

export async function copyToTarget(
	port: SerialPort
): Promise<{ success: boolean; message: string }> {
	flushPort(port);
	try {
		await writeBytes(port, ENCODER.encode('C'));
		const text = await readLine(port, 5000);
		if (text.includes('COPY_OK')) {
			return { success: true, message: 'Sent to FV-1' };
		}
		if (text.includes('COPY_FAIL')) {
			return {
				success: false,
				message: "Couldn't send to FV-1. Make sure the FV-1 is connected."
			};
		}
		return { success: false, message: `Unexpected response: ${text}` };
	} catch (e) {
		return { success: false, message: `Send failed: ${e}` };
	}
}

export async function writeEEPROM(
	port: SerialPort,
	data: Uint8Array,
	onProgress?: (progress: number) => void
): Promise<{ success: boolean; message: string }> {
	if (data.length !== EEPROM_SIZE) {
		return { success: false, message: `Data must be exactly ${EEPROM_SIZE} bytes` };
	}
	flushPort(port);
	try {
		await writeBytes(port, ENCODER.encode('W'));
		onProgress?.(5);

		// Chunked to avoid overwhelming the device's USB endpoint
		const CHUNK_SIZE = 64;
		for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
			const chunk = data.slice(offset, offset + CHUNK_SIZE);
			await writeBytes(port, chunk);
			const transferProgress = 5 + Math.floor(((offset + chunk.length) / data.length) * 80);
			onProgress?.(transferProgress);
			// Tiny inter-chunk pause -- the device accumulates in a 1 KB buffer
			// and flushes a page to EEPROM every full chunk; without this it can
			// drop the last bytes under back-to-back transfers.
			await new Promise((r) => setTimeout(r, 5));
		}
		onProgress?.(90);

		const text = await readLine(port, 5000);
		onProgress?.(100);

		if (text.includes('OK')) return { success: true, message: 'Program written successfully!' };
		if (text.includes('ERROR')) return { success: false, message: 'Device reported write error' };
		return { success: true, message: `Write completed (response: ${text})` };
	} catch (e) {
		return { success: false, message: `Write failed: ${e}` };
	}
}

export async function readEEPROM(
	port: SerialPort,
	onProgress?: (progress: number) => void
): Promise<{ success: boolean; data?: Uint8Array; message: string }> {
	flushPort(port);
	try {
		await writeBytes(port, ENCODER.encode('R'));
		onProgress?.(10);
		const data = await readBytes(port, EEPROM_SIZE, 5000);
		onProgress?.(100);
		return { success: true, data, message: 'Read successful!' };
	} catch (e) {
		return { success: false, message: `Read failed: ${e}` };
	}
}

// ----- pure utilities (no I/O) -----------------------------------------

export function concatenateAndPad(files: { name: string; data: Uint8Array }[]): {
	success: boolean;
	data?: Uint8Array;
	message: string;
	totalSize: number;
} {
	const totalSize = files.reduce((sum, f) => sum + f.data.length, 0);
	if (totalSize > EEPROM_SIZE) {
		return {
			success: false,
			message: `Total size (${totalSize} bytes) exceeds EEPROM capacity (${EEPROM_SIZE} bytes)`,
			totalSize
		};
	}
	const result = new Uint8Array(EEPROM_SIZE);
	let offset = 0;
	for (const file of files) {
		result.set(file.data, offset);
		offset += file.data.length;
	}
	return {
		success: true,
		data: result,
		message: `${totalSize} bytes loaded, padded to ${EEPROM_SIZE} bytes`,
		totalSize
	};
}

export function downloadBlob(
	data: Uint8Array,
	filename: string,
	mimeType: string = 'application/octet-stream'
): void {
	const blob = new Blob([data], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

// ----- EEPROM -> per-program splitting + zip ---------------------------

export const PROGRAM_COUNT = 8;
export const PROGRAM_SIZE = 512;

function isProgramEmpty(data: Uint8Array): boolean {
	for (let i = 0; i < data.length; i++) {
		if (data[i] !== 0x00 && data[i] !== 0xff) return false;
	}
	return true;
}

/**
 * Split a full EEPROM dump into the 8 program slots, skipping slots that are
 * fully erased (all 0x00 or 0xFF).
 */
export function splitEEPROMIntoPrograms(
	eeprom: Uint8Array
): { name: string; data: Uint8Array }[] {
	const out: { name: string; data: Uint8Array }[] = [];
	for (let i = 0; i < PROGRAM_COUNT; i++) {
		const data = eeprom.slice(i * PROGRAM_SIZE, (i + 1) * PROGRAM_SIZE);
		if (isProgramEmpty(data)) continue;
		out.push({ name: `program_${i}.fv1`, data });
	}
	return out;
}

// CRC32 (ZIP/PKZIP polynomial 0xEDB88320), lazily initialised table.
let CRC_TABLE: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
	if (!CRC_TABLE) {
		const t = new Uint32Array(256);
		for (let i = 0; i < 256; i++) {
			let c = i;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			t[i] = c >>> 0;
		}
		CRC_TABLE = t;
	}
	let c = 0xffffffff;
	for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/**
 * Build a ZIP archive (STORED, no compression) from the given entries.
 * Adequate for our use case: 8 x 512-byte binary blobs.
 */
export function buildZip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
	const localParts: Uint8Array[] = [];
	const centralParts: Uint8Array[] = [];
	let offset = 0;

	for (const entry of entries) {
		const nameBytes = ENCODER.encode(entry.name);
		const crc = crc32(entry.data);
		const size = entry.data.length;

		const local = new Uint8Array(30 + nameBytes.length + size);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true); // local file header signature
		lv.setUint16(4, 20, true); // version needed
		lv.setUint16(6, 0, true); // flags
		lv.setUint16(8, 0, true); // method = stored
		lv.setUint16(10, 0, true); // mod time
		lv.setUint16(12, 0x21, true); // mod date (1980-01-01)
		lv.setUint32(14, crc, true);
		lv.setUint32(18, size, true); // compressed size
		lv.setUint32(22, size, true); // uncompressed size
		lv.setUint16(26, nameBytes.length, true);
		lv.setUint16(28, 0, true); // extra length
		local.set(nameBytes, 30);
		local.set(entry.data, 30 + nameBytes.length);
		localParts.push(local);

		const central = new Uint8Array(46 + nameBytes.length);
		const cv = new DataView(central.buffer);
		cv.setUint32(0, 0x02014b50, true); // central dir signature
		cv.setUint16(4, 20, true); // version made by
		cv.setUint16(6, 20, true); // version needed
		cv.setUint16(8, 0, true);
		cv.setUint16(10, 0, true);
		cv.setUint16(12, 0, true);
		cv.setUint16(14, 0x21, true);
		cv.setUint32(16, crc, true);
		cv.setUint32(20, size, true);
		cv.setUint32(24, size, true);
		cv.setUint16(28, nameBytes.length, true);
		cv.setUint16(30, 0, true); // extra length
		cv.setUint16(32, 0, true); // comment length
		cv.setUint16(34, 0, true); // disk number
		cv.setUint16(36, 0, true); // internal attrs
		cv.setUint32(38, 0, true); // external attrs
		cv.setUint32(42, offset, true); // local header offset
		central.set(nameBytes, 46);
		centralParts.push(central);

		offset += local.length;
	}

	const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
	const centralOffset = offset;

	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(4, 0, true);
	ev.setUint16(6, 0, true);
	ev.setUint16(8, entries.length, true);
	ev.setUint16(10, entries.length, true);
	ev.setUint32(12, centralSize, true);
	ev.setUint32(16, centralOffset, true);
	ev.setUint16(20, 0, true);

	const totalSize = offset + centralSize + 22;
	const out = new Uint8Array(totalSize);
	let p = 0;
	for (const part of localParts) {
		out.set(part, p);
		p += part.length;
	}
	for (const part of centralParts) {
		out.set(part, p);
		p += part.length;
	}
	out.set(end, p);
	return out;
}
