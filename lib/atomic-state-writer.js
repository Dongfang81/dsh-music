import { promises as nodeFs } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Debounced, serialized JSON writer that publishes each snapshot with an
 * atomic same-directory rename. The latest pending snapshot wins while a
 * write is active; playback callers never have to wait for disk I/O.
 */
export function createAtomicStateWriter(options = {}) {
	const file = options.file;
	const delayMs = Math.max(0, Number(options.delayMs) || 0);
	const fs = options.fs || nodeFs;
	let pending = null;
	let timer = null;
	let draining = null;
	let disposed = false;
	let sequence = 0;

	async function publish(snapshot) {
		const tempFile = `${file}.tmp-${process.pid}-${++sequence}`;
		try {
			await fs.mkdir(dirname(file), { recursive: true });
			await fs.writeFile(tempFile, JSON.stringify(snapshot), 'utf8');
			await fs.rename(tempFile, file);
			return true;
		} catch {
			try { await fs.unlink(tempFile); } catch { /* nothing to clean up */ }
			return false;
		}
	}

	function drain() {
		if (timer) clearTimeout(timer);
		timer = null;
		if (draining) return draining;
		draining = (async () => {
			let ok = true;
			while (pending !== null) {
				const snapshot = pending;
				pending = null;
				if (!await publish(snapshot)) ok = false;
			}
			return ok;
		})().finally(() => { draining = null; });
		return draining;
	}

	function schedule(snapshot) {
		if (disposed || !file) return false;
		pending = snapshot;
		if (draining) return true;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => { drain(); }, delayMs);
		return true;
	}

	async function flush() {
		if (!file) return true;
		if (draining) {
			await draining;
			if (pending !== null) return drain();
			return true;
		}
		if (pending === null) return true;
		return drain();
	}

	async function dispose() {
		disposed = true;
		return flush();
	}

	return { schedule, flush, dispose };
}
