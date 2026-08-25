import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const VERSION = 1;

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function cleanTrack(track) {
	const value = { ...track };
	delete value.url;
	delete value.resolvedUrl;
	delete value.currentUrl;
	delete value.expiresAt;
	return value;
}

function emptyState() {
	return {
		version: VERSION,
		generationId: null,
		generatedAt: 0,
		profileRevision: 0,
		items: [],
		recentRecommendedTrackKeys: [],
		lastGenerationStatus: null,
		pending: null
	};
}

function validTrack(track) {
	return track && typeof track.trackKey === 'string' && track.trackKey && typeof track.title === 'string' && Array.isArray(track.artists);
}

function validateItems(items) {
	if (!Array.isArray(items)) throw new Error('recommendation pool items must be an array');
	const keys = new Set();
	for (const track of items) {
		if (!validTrack(track)) throw new Error('recommendation pool contains an invalid track');
		if (keys.has(track.trackKey)) throw new Error(`duplicate recommendation track: ${track.trackKey}`);
		keys.add(track.trackKey);
	}
}

function validState(value) {
	if (!value || value.version !== VERSION || !Array.isArray(value.items) || !Array.isArray(value.recentRecommendedTrackKeys)) return false;
	try {
		validateItems(value.items);
		if (value.pending?.tracks) validateItems(value.pending.tracks);
		return true;
	} catch {
		return false;
	}
}

export function createRecommendationPool(options = {}) {
	const file = options.file === undefined ? null : options.file;
	const targetSize = Math.max(1, Number(options.targetSize) || 60);
	const batchSize = Math.max(1, Number(options.batchSize) || 30);
	const historySize = Math.max(1, Number(options.historySize) || 120);
	let state = emptyState();
	let loaded = false;
	let serial = Promise.resolve();
	let transactionSequence = 0;

	function exclusive(operation) {
		const result = serial.then(operation, operation);
		serial = result.catch(() => {});
		return result;
	}

	async function persist() {
		if (!file) return;
		await mkdir(dirname(file), { recursive: true });
		const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
		await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
		try {
			await rename(temp, file);
		} catch (error) {
			await unlink(temp).catch(() => {});
			throw error;
		}
	}

	async function ensureLoaded() {
		if (loaded) return;
		loaded = true;
		if (!file) return;
		try {
			const parsed = JSON.parse(await readFile(file, 'utf8'));
			if (validState(parsed)) state = { ...emptyState(), ...parsed };
		} catch {
			state = emptyState();
		}
		if (state.pending?.tracks?.length) {
			const pendingKeys = new Set(state.pending.tracks.map((track) => track.trackKey));
			state.items = state.pending.tracks.concat(state.items.filter((track) => !pendingKeys.has(track.trackKey))).slice(0, targetSize);
			state.pending = null;
			await persist();
		}
	}

	async function load() {
		return exclusive(async () => {
			await ensureLoaded();
			return snapshotValue();
		});
	}

	function snapshotValue() {
		return clone({
			...state,
			ready: state.items.length >= batchSize,
			count: state.items.length,
			targetSize,
			batchSize,
			historySize
		});
	}

	async function snapshot() {
		return exclusive(async () => {
			await ensureLoaded();
			return snapshotValue();
		});
	}

	/** 高频状态轮询使用的轻量元数据，不克隆歌曲数组与历史列表。 */
	async function status() {
		return exclusive(async () => {
			await ensureLoaded();
			return {
				ready: state.items.length >= batchSize,
				count: state.items.length,
				generationId: state.generationId,
				generatedAt: state.generatedAt,
				profileRevision: state.profileRevision,
				pending: Boolean(state.pending),
				lastGenerationStatus: state.lastGenerationStatus
			};
		});
	}

	async function replace(items, metadata = {}) {
		return exclusive(async () => {
			await ensureLoaded();
			if (state.pending) throw new Error('recommendation pool has an uncommitted transaction');
			validateItems(items);
			const cleaned = items.map(cleanTrack).slice(0, targetSize);
			if (cleaned.length < batchSize) return { ok: false, count: state.items.length, reason: 'short-generation' };
			if (state.items.length >= targetSize && cleaned.length < targetSize) {
				return { ok: false, count: state.items.length, reason: 'preserve-complete-pool' };
			}
			state.items = cleaned;
			state.generationId = String(metadata.generationId || `generation-${Date.now()}`);
			state.generatedAt = Number(metadata.generatedAt) || Date.now();
			state.profileRevision = Number(metadata.profileRevision) || 0;
			state.lastGenerationStatus = metadata.lastGenerationStatus ?? { ok: true, count: cleaned.length };
			await persist();
			return { ok: true, count: cleaned.length, generationId: state.generationId };
		});
	}

	async function consume(count = batchSize) {
		return exclusive(async () => {
			await ensureLoaded();
			const requested = Math.max(1, Number(count) || batchSize);
			if (state.pending) return { ok: false, tracks: [], remaining: state.items.length, ready: false, reason: 'pending-transaction' };
			if (state.items.length < requested) {
				return { ok: false, tracks: [], remaining: state.items.length, ready: state.items.length >= batchSize, reason: 'not-ready' };
			}
			const tracks = state.items.slice(0, requested);
			state.items = state.items.slice(requested);
			const transaction = `recommendation-consume-${Date.now()}-${++transactionSequence}`;
			state.pending = { token: transaction, tracks };
			await persist();
			return {
				ok: true,
				tracks: clone(tracks),
				transaction,
				remaining: state.items.length,
				ready: state.items.length >= batchSize
			};
		});
	}

	async function commit(transaction) {
		return exclusive(async () => {
			await ensureLoaded();
			if (!state.pending || state.pending.token !== transaction) throw new Error('recommendation transaction is not active');
			state.recentRecommendedTrackKeys = state.recentRecommendedTrackKeys
				.concat(state.pending.tracks.map((track) => track.trackKey))
				.slice(-historySize);
			state.pending = null;
			await persist();
			return snapshotValue();
		});
	}

	async function restore(transaction) {
		return exclusive(async () => {
			await ensureLoaded();
			if (!state.pending || state.pending.token !== transaction) throw new Error('recommendation transaction is not active');
			const pendingKeys = new Set(state.pending.tracks.map((track) => track.trackKey));
			state.items = state.pending.tracks.concat(state.items.filter((track) => !pendingKeys.has(track.trackKey))).slice(0, targetSize);
			state.pending = null;
			await persist();
			return snapshotValue();
		});
	}

	function needsRefill() {
		return state.items.length < targetSize;
	}

	return { load, snapshot, status, replace, consume, commit, restore, needsRefill };
}
