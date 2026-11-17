<script lang="ts">
	import { onMount } from 'svelte';
	import { toggleMode } from 'mode-watcher';
	import Icon from '@iconify/svelte';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils';
	import {
		isWebSerialSupported,
		requestPort,
		openPort,
		closePort,
		verifyDevice,
		getVersion,
		writeEEPROM,
		readEEPROM,
		copyToTarget,
		buildEEPROMImage,
		downloadBlob,
		splitEEPROMIntoPrograms,
		buildZip,
		EEPROM_SIZE
	} from '$lib/serial';
	import {
		updateFirmware,
		extractFirmwareVersion,
		MAX_APP_SIZE,
		BOOTLOADER_PID,
		type UpdatePhase
	} from '$lib/bootloader';

	// State
	let port: SerialPort | null = $state(null);
	let connected: boolean = $state(false);
	let verified: boolean = $state(false);
	let bootloaderMode: boolean = $state(false);
	let deviceInfo: string = $state('');
	let firmwareVersion: number | null = $state(null);
	let serialSupported: boolean = $state(true);

	// Program slots (8 slots, 512 bytes each)
	const SLOT_COUNT = 8;
	const SLOT_SIZE = 512;
	type ProgramSlot = { name: string; size: number; data: Uint8Array } | null;
	let slots: ProgramSlot[] = $state(Array(SLOT_COUNT).fill(null));
	let filledSlots = $derived(slots.filter((s) => s !== null) as { name: string; size: number; data: Uint8Array }[]);
	let totalSize: number = $derived(filledSlots.reduce((sum, f) => sum + f.size, 0));
	let sizeError: boolean = $derived(totalSize > EEPROM_SIZE);
	let hasPrograms: boolean = $derived(filledSlots.length > 0);

	// Operation state
	type Status = 'idle' | 'connecting' | 'writing' | 'reading' | 'copying' | 'updating';
	let status: Status = $state('idle');
	let progress: number = $state(0);
	let message: string = $state('');
	let messageType: 'info' | 'success' | 'error' = $state('info');

	let slotFileInput: HTMLInputElement;
	let activeSlotIndex: number = $state(-1);
	let dark: boolean = $state(false);

	// Firmware update state
	let firmwareFileInput: HTMLInputElement;
	let firmwareFile: { name: string; data: Uint8Array; version: number | null } | null =
		$state(null);
	let updatePhase: UpdatePhase | null = $state(null);
	let showUpdateConfirm: boolean = $state(false);

	let firmwareTooLarge = $derived(firmwareFile ? firmwareFile.data.length > MAX_APP_SIZE : false);
	// Use the version stamped in the .bin if present; otherwise fall back to
	// auto-incrementing from whatever is currently installed.
	let versionToWrite = $derived(firmwareFile?.version ?? (firmwareVersion ?? 0) + 1);

	onMount(() => {
		serialSupported = isWebSerialSupported();
		if (
			localStorage.theme === 'dark' ||
			(!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)
		) {
			dark = true;
		}
	});

	async function connect() {
		if (connected) {
			// Disconnect
			if (port) {
				await closePort(port);
			}
			port = null;
			connected = false;
			verified = false;
			bootloaderMode = false;
			deviceInfo = '';
			firmwareVersion = null;
			setMessage('Disconnected', 'info');
			return;
		}

		status = 'connecting';
		setMessage('Requesting port...', 'info');

		try {
			port = await requestPort();
			await openPort(port);
			connected = true;

			if (port.getInfo().usbProductId === BOOTLOADER_PID) {
				bootloaderMode = true;
				verified = false;
				deviceInfo = 'Bootloader';
				setMessage(
					'Device is in bootloader mode. Use Firmware Update to flash an app.',
					'info'
				);
			} else {
				setMessage('Connected, verifying device...', 'info');
				const result = await verifyDevice(port);
				verified = result.verified;
				deviceInfo = result.info;

				if (verified) {
					const versionResult = await getVersion(port);
					firmwareVersion = versionResult.version;
					const slotsMsg = await populateSlotsFromDevice(port);
					setMessage(`Connected. ${slotsMsg}`, 'success');
				} else {
					setMessage(`Device not recognized: ${result.info}`, 'error');
				}
			}
		} catch (error) {
			setMessage(`Connection failed: ${error}`, 'error');
			port = null;
			connected = false;
		} finally {
			status = 'idle';
		}
	}

	function openSlotFilePicker(slotIndex: number) {
		activeSlotIndex = slotIndex;
		slotFileInput?.click();
	}

	async function handleSlotFileSelect(event: Event) {
		const input = event.target as HTMLInputElement;
		if (!input.files || input.files.length === 0 || activeSlotIndex < 0) return;

		const file = input.files[0];
		const buffer = await file.arrayBuffer();
		const data = new Uint8Array(buffer);

		if (data.byteLength > SLOT_SIZE) {
			setMessage(`File too large for slot (${data.byteLength} bytes, max ${SLOT_SIZE})`, 'error');
		} else {
			slots[activeSlotIndex] = {
				name: file.name,
				size: data.byteLength,
				data: data
			};
			setMessage(`Program loaded into slot ${activeSlotIndex}`, 'success');
		}

		// Reset for next use
		input.value = '';
		activeSlotIndex = -1;
	}

	function clearSlot(slotIndex: number) {
		slots[slotIndex] = null;
	}

	async function populateSlotsFromDevice(p: SerialPort): Promise<string> {
		const result = await readEEPROM(p);
		if (!result.success || !result.data) {
			return `Could not read programs from device: ${result.message}`;
		}
		const newSlots: ProgramSlot[] = Array(SLOT_COUNT).fill(null);
		let count = 0;
		for (let i = 0; i < SLOT_COUNT; i++) {
			const data = result.data.slice(i * SLOT_SIZE, (i + 1) * SLOT_SIZE);
			// Treat a slot as empty if it's all 0x00 or all 0xFF (unwritten /
			// erased EEPROM). Any other byte means it holds a real program.
			let hasData = false;
			for (let j = 0; j < data.length; j++) {
				if (data[j] !== 0x00 && data[j] !== 0xff) {
					hasData = true;
					break;
				}
			}
			if (hasData) {
				newSlots[i] = { name: `Program ${i}`, size: SLOT_SIZE, data };
				count++;
			}
		}
		slots = newSlots;
		return count === 0
			? 'No programs found on device.'
			: `Loaded ${count} program${count === 1 ? '' : 's'} from device.`;
	}

	function clearAllSlots() {
		slots = Array(SLOT_COUNT).fill(null);
	}

	async function write() {
		if (!port || !verified) {
			setMessage('Device not connected', 'error');
			return;
		}

		if (!hasPrograms) {
			setMessage('No programs loaded', 'error');
			return;
		}

		const result = buildEEPROMImage(slots.map((s) => s?.data ?? null));
		if (!result.success || !result.data) {
			setMessage(result.message, 'error');
			return;
		}

		status = 'writing';
		progress = 0;
		setMessage('Writing to EEPROM...', 'info');

		const writeResult = await writeEEPROM(port, result.data, (p) => (progress = p));

		if (writeResult.success) {
			setMessage(writeResult.message, 'success');
		} else {
			setMessage(writeResult.message, 'error');
		}

		status = 'idle';
		progress = 0;
	}

	async function read() {
		if (!port || !verified) {
			setMessage('Device not connected', 'error');
			return;
		}

		status = 'reading';
		progress = 0;
		setMessage('Reading from EEPROM...', 'info');

		const result = await readEEPROM(port, (p) => (progress = p));

		if (result.success && result.data) {
			const programs = splitEEPROMIntoPrograms(result.data);
			if (programs.length === 0) {
				setMessage('EEPROM is empty -- no programs to download.', 'info');
			} else {
				const zip = buildZip(programs);
				downloadBlob(zip, 'eeprom_programs.zip', 'application/zip');
				setMessage(
					`Read successful! Downloaded ${programs.length} program${programs.length === 1 ? '' : 's'}.`,
					'success'
				);
			}
		} else {
			setMessage(result.message, 'error');
		}

		status = 'idle';
		progress = 0;
	}

	function openFirmwareFilePicker() {
		firmwareFileInput?.click();
	}

	async function handleFirmwareFileSelect(event: Event) {
		const input = event.target as HTMLInputElement;
		if (!input.files || input.files.length === 0) return;
		const file = input.files[0];
		const buffer = await file.arrayBuffer();
		const data = new Uint8Array(buffer);
		firmwareFile = { name: file.name, data, version: extractFirmwareVersion(data) };
		input.value = '';
	}

	function clearFirmwareFile() {
		firmwareFile = null;
	}

	function phaseLabel(p: UpdatePhase | null): string {
		switch (p) {
			case 'rebooting':
			case 'waiting-for-bootloader':
			case 'identifying':
				return 'Preparing device...';
			case 'erasing':
				return 'Erasing old firmware...';
			case 'programming':
				return 'Installing new firmware...';
			case 'writing-metadata':
			case 'verifying':
				return 'Verifying...';
			case 'jumping':
			case 'waiting-for-app':
			case 'reconnecting':
				return 'Restarting...';
			default:
				return '';
		}
	}

	async function runFirmwareUpdate() {
		showUpdateConfirm = false;
		if (!port || (!verified && !bootloaderMode) || !firmwareFile) return;

		status = 'updating';
		progress = 0;
		updatePhase = null;
		setMessage('Starting firmware update...', 'info');

		const result = await updateFirmware(port, firmwareFile.data, versionToWrite, {
			onPhase: (p) => {
				updatePhase = p;
				progress = 0;
			},
			onProgress: (current, total) => {
				progress = total === 0 ? 0 : Math.floor((current / total) * 100);
			}
		});

		updatePhase = null;
		progress = 0;

		if (result.success && result.newPort) {
			port = result.newPort;
			bootloaderMode = false;
			const verifyResult = await verifyDevice(port);
			verified = verifyResult.verified;
			deviceInfo = verifyResult.info;
			if (verified) {
				const v = await getVersion(port);
				firmwareVersion = v.version;
				await populateSlotsFromDevice(port);
			}
			setMessage(result.message, 'success');
		} else if (result.success) {
			// Updated but reconnect failed -- treat as disconnected so the user reconnects manually
			port = null;
			connected = false;
			verified = false;
			bootloaderMode = false;
			deviceInfo = '';
			firmwareVersion = null;
			setMessage(result.message, 'success');
		} else {
			// Update failed -- the device is most likely still in bootloader. Reset connection.
			port = null;
			connected = false;
			verified = false;
			bootloaderMode = false;
			deviceInfo = '';
			firmwareVersion = null;
			setMessage(result.message, 'error');
		}

		status = 'idle';
	}

	async function copy() {
		if (!port || !verified) {
			setMessage('Device not connected', 'error');
			return;
		}

		status = 'copying';
		setMessage('Sending program to FV-1 target...', 'info');

		const result = await copyToTarget(port);

		setMessage(result.message, result.success ? 'success' : 'error');
		status = 'idle';
	}

	function setMessage(msg: string, type: 'info' | 'success' | 'error') {
		message = msg;
		messageType = type;
	}
</script>

<div class="flex min-h-screen flex-col">
	<!-- Header -->
	<header class="flex items-center justify-between border-b border-border p-4">
		<h1 class="text-2xl font-semibold">FV1 Programmer</h1>
		<div class="flex items-center gap-4">
			<Button onclick={connect} variant={connected ? 'destructive' : 'default'} disabled={status !== 'idle'}>
				{#if status === 'connecting'}
					<Icon icon="lucide:loader-2" class="animate-spin" />
					Connecting...
				{:else if connected}
					<Icon icon="lucide:unplug" />
					Disconnect
				{:else}
					<Icon icon="lucide:plug" />
					Connect
				{/if}
			</Button>
			<button class="size-6" onclick={toggleMode}>
				<Icon
					icon={dark ? 'lucide:sun' : 'lucide:moon'}
					class="size-5 transition-colors hover:text-muted-foreground"
				/>
			</button>
		</div>
	</header>

	<!-- Browser Warning -->
	{#if !serialSupported}
		<div class="m-4 rounded-md border border-destructive bg-destructive/10 p-4">
			<div class="flex items-center gap-2">
				<Icon icon="lucide:alert-triangle" class="size-5 text-destructive" />
				<span class="font-medium text-destructive">Web Serial API not supported</span>
			</div>
			<p class="mt-2 text-sm text-muted-foreground">
				Please use Chrome, Edge, or Opera to access the serial port functionality.
			</p>
		</div>
	{/if}

	<!-- Main Content -->
	<main class="flex flex-1 flex-col gap-6 p-6">
		<!-- Status -->
		<div
			class={cn(
				'rounded-lg border p-4',
				verified && 'border-success bg-success/10',
				!connected && 'border-muted'
			)}
		>
			<div class="flex items-center gap-3">
				<div
					class="size-3 rounded-full"
					class:bg-success={verified}
					class:bg-yellow-500={connected && !verified}
					class:bg-muted-foreground={!connected}
				></div>
				<span class="font-medium">
					{#if verified}
						Connected{#if firmwareVersion !== null}
							{' '}(build {firmwareVersion}){/if}
					{:else if bootloaderMode}
						Connected - bootloader mode
					{:else if connected}
						Connected - device not recognized
					{:else}
						Not connected
					{/if}
				</span>
			</div>
		</div>

		<!-- Message -->
		{#if message}
			<div
				class={cn(
					'rounded-md border p-3',
					messageType === 'success' && 'border-success bg-success/10',
					messageType === 'error' && 'border-destructive bg-destructive/10',
					messageType === 'info' && 'border-muted'
				)}
			>
				<div class="flex items-center gap-2">
					{#if messageType === 'success'}
						<Icon icon="lucide:check-circle" class="size-5 text-success" />
					{:else if messageType === 'error'}
						<Icon icon="lucide:x-circle" class="size-5 text-destructive" />
					{:else}
						<Icon icon="lucide:info" class="size-5 text-muted-foreground" />
					{/if}
					<span>{message}</span>
				</div>
			</div>
		{/if}

		<!-- Progress Bar -->
		{#if status === 'writing' || status === 'reading' || status === 'updating'}
			<div class="rounded-md border p-4">
				<div class="mb-2 flex justify-between text-sm">
					<span>
						{#if status === 'updating'}
							{phaseLabel(updatePhase)}
						{:else if status === 'writing'}
							Writing...
						{:else}
							Reading...
						{/if}
					</span>
					<span>{progress}%</span>
				</div>
				<div class="h-2 w-full rounded-full bg-muted">
					<div
						class="h-2 rounded-full bg-primary transition-all duration-300"
						style="width: {progress}%"
					></div>
				</div>
			</div>
		{/if}

		<div class="grid gap-6 md:grid-cols-3">
			<!-- Write Section -->
			<div class="rounded-lg border p-6">
				<h2 class="mb-4 text-lg font-semibold">Write to EEPROM</h2>

				<!-- Hidden file input for slots -->
				<input
					type="file"
					accept=".fv1,.bin,.hex"
					bind:this={slotFileInput}
					onchange={handleSlotFileSelect}
					class="hidden"
				/>

				<div class="space-y-4">
					<!-- Program Slots Grid (2 columns x 4 rows) -->
					<div class="grid grid-cols-2 gap-2">
						{#each slots as slot, i}
							{#if slot}
								<!-- Filled slot -->
								<div class="relative flex h-16 items-center justify-center rounded-md border-2 border-primary bg-primary/10">
									<div class="flex w-full items-center gap-2 px-3">
										<Icon icon="lucide:file-audio" class="size-4 shrink-0 text-primary" />
										<span class="min-w-0 flex-1 truncate text-sm font-medium">{slot.name}</span>
									</div>
									<button
										onclick={() => clearSlot(i)}
										class="absolute right-1 top-1 rounded p-0.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
									>
										<Icon icon="lucide:x" class="size-3.5" />
									</button>
									<span class="absolute bottom-1 left-2 text-xs text-muted-foreground">{i}</span>
								</div>
							{:else}
								<!-- Empty slot -->
								<button
									onclick={() => openSlotFilePicker(i)}
									class="flex h-16 cursor-pointer flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed border-muted-foreground/30 text-muted-foreground transition-all hover:border-muted-foreground/50 hover:bg-muted/30"
								>
									<Icon icon="lucide:plus" class="size-5" />
									<span class="text-xs">Slot {i}</span>
								</button>
							{/if}
						{/each}
					</div>

					<!-- Total Size & Clear -->
					{#if hasPrograms}
						<div class="flex items-center justify-between">
							<span class="text-sm text-muted-foreground">
								{filledSlots.length} program{filledSlots.length !== 1 ? 's' : ''} loaded
							</span>
							<Button variant="ghost" size="sm" onclick={clearAllSlots}>
								<Icon icon="lucide:trash-2" class="size-3.5" />
								Clear All
							</Button>
						</div>
					{/if}

					<!-- Write Button -->
					<Button
						onclick={write}
						disabled={!verified || !hasPrograms || sizeError || status !== 'idle'}
						class="w-full"
						variant={verified && hasPrograms && !sizeError ? 'default' : 'secondary'}
					>
						{#if status === 'writing'}
							<Icon icon="lucide:loader-2" class="animate-spin" />
							Writing...
						{:else}
							<Icon icon="lucide:upload" />
							Write to EEPROM
						{/if}
					</Button>
				</div>
			</div>

			<!-- Read Section -->
			<div class="rounded-lg border p-6">
				<h2 class="mb-4 text-lg font-semibold">Read from EEPROM</h2>

				<div class="space-y-4">
					<p class="text-sm text-muted-foreground">
						Read the EEPROM, split it into individual program files and download as a zip.
					</p>

					<Button
						onclick={read}
						disabled={!verified || status !== 'idle'}
						class="w-full"
						variant={verified ? 'default' : 'secondary'}
					>
						{#if status === 'reading'}
							<Icon icon="lucide:loader-2" class="animate-spin" />
							Reading...
						{:else}
							<Icon icon="lucide:download" />
							Read & Download
						{/if}
					</Button>
				</div>
			</div>

			<!-- Send to FV-1 Section -->
			<div class="rounded-lg border p-6">
				<h2 class="mb-4 text-lg font-semibold">Send to FV-1</h2>

				<div class="space-y-4">
					<p class="text-sm text-muted-foreground">
						Send the loaded programs to a connected FV-1.
					</p>

					<Button
						onclick={copy}
						disabled={!verified || status !== 'idle'}
						class="w-full"
						variant={verified ? 'default' : 'secondary'}
					>
						{#if status === 'copying'}
							<Icon icon="lucide:loader-2" class="animate-spin" />
							Sending...
						{:else}
							<Icon icon="lucide:send" />
							Send to Target
						{/if}
					</Button>
				</div>
			</div>
		</div>

		<!-- Firmware Update Section -->
		<div class="rounded-lg border p-6">
			<h2 class="mb-1 text-lg font-semibold">Firmware update</h2>
			<p class="mb-4 text-sm text-muted-foreground">
				Install a new version of the programmer firmware.
			</p>

			<input
				type="file"
				accept=".bin"
				bind:this={firmwareFileInput}
				onchange={handleFirmwareFileSelect}
				class="hidden"
			/>

			<!-- File picker -->
			{#if firmwareFile}
				<div class="flex items-center gap-2 rounded-md border-2 border-primary bg-primary/10 p-3">
					<Icon icon="lucide:file-code" class="size-4 shrink-0 text-primary" />
					<div class="min-w-0 flex-1">
						<div class="truncate text-sm font-medium">{firmwareFile.name}</div>
						{#if firmwareFile.version !== null}
							<div class="text-xs text-muted-foreground">build {firmwareFile.version}</div>
						{/if}
						{#if firmwareTooLarge}
							<div class="mt-1 text-xs text-destructive">File is too large.</div>
						{/if}
					</div>
					<button
						onclick={clearFirmwareFile}
						class="rounded p-1 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
					>
						<Icon icon="lucide:x" class="size-4" />
					</button>
				</div>
			{:else}
				<button
					onclick={openFirmwareFilePicker}
					class="flex h-16 w-full cursor-pointer flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed border-muted-foreground/30 text-muted-foreground transition-all hover:border-muted-foreground/50 hover:bg-muted/30"
				>
					<Icon icon="lucide:upload-cloud" class="size-5" />
					<span class="text-xs">Choose firmware file</span>
				</button>
			{/if}

			<Button
				onclick={() => (showUpdateConfirm = true)}
				disabled={(!verified && !bootloaderMode) || !firmwareFile || firmwareTooLarge || status !== 'idle'}
				class="mt-4 w-full"
				variant={(verified || bootloaderMode) && firmwareFile && !firmwareTooLarge ? 'default' : 'secondary'}
			>
				{#if status === 'updating'}
					<Icon icon="lucide:loader-2" class="animate-spin" />
					Updating...
				{:else}
					<Icon icon="lucide:cpu" />
					Update Firmware
				{/if}
			</Button>
		</div>
	</main>

	<!-- Footer -->
	<footer class="border-t border-border p-4 text-center text-sm text-muted-foreground">
		FV1 Programmer - Web Serial Interface
	</footer>

	<!-- Firmware update confirmation modal -->
	{#if showUpdateConfirm && firmwareFile}
		<div
			class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
			onclick={() => (showUpdateConfirm = false)}
			role="presentation"
		>
			<div
				class="w-full max-w-md rounded-lg border bg-background p-6 shadow-lg"
				onclick={(e) => e.stopPropagation()}
				role="dialog"
				aria-modal="true"
			>
				<h3 class="mb-3 text-lg font-semibold">Update firmware?</h3>
				<p class="mb-4 text-sm text-muted-foreground">
					The programmer will restart. Please don't unplug it during the update.
				</p>
				<dl class="mb-6 space-y-1 text-sm">
					<div class="flex justify-between gap-4">
						<dt class="text-muted-foreground">File</dt>
						<dd class="truncate">{firmwareFile.name}</dd>
					</div>
					{#if firmwareFile.version !== null}
						<div class="flex justify-between gap-4">
							<dt class="text-muted-foreground">Will install</dt>
							<dd>build {firmwareFile.version}</dd>
						</div>
					{/if}
					{#if firmwareVersion !== null}
						<div class="flex justify-between gap-4">
							<dt class="text-muted-foreground">Currently installed</dt>
							<dd>build {firmwareVersion}</dd>
						</div>
					{/if}
				</dl>
				<div class="flex justify-end gap-2">
					<Button variant="secondary" onclick={() => (showUpdateConfirm = false)}>Cancel</Button>
					<Button onclick={runFirmwareUpdate}>
						<Icon icon="lucide:cpu" />
						Update
					</Button>
				</div>
			</div>
		</div>
	{/if}
</div>
