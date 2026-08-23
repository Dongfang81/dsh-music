import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { normalizeTrack } from './identity.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HALF_LIFE_MS = 45 * DAY_MS;
const EVENT_WEIGHTS = Object.freeze({
	favorite: 5,
	'search-play': 4,
	replay: 4,
	'complete-80': 2,
	'skip-short': -4,
	dislike: -8
});
const RULE_KINDS = new Set(['artist', 'track', 'language', 'style', 'energy']);

function emptyData() {
	return {
		version: 2,
		tracks: {},
		artists: {},
		rules: [],
		resolverStats: {},
		nextRuleId: 1,
		migratedLegacy: false,
		updatedAt: 0
	};
}

function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}

function decay(value, from, to) {
	if (!value || !from || to <= from) return Number(value) || 0;
	return value * Math.pow(0.5, (to - from) / HALF_LIFE_MS);
}

function artistKey(value) {
	return String(value ?? '').trim().normalize('NFKC').toLocaleLowerCase();
}

function validData(value) {
	return value && value.version === 2 && value.tracks && value.artists && Array.isArray(value.rules) && value.resolverStats;
}

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

export function createTasteProfile(options = {}) {
	const file = options.file === undefined ? null : options.file;
	const now = typeof options.now === 'function' ? options.now : Date.now;
	let data = emptyData();
	let loaded = false;

	async function load() {
		if (loaded) return;
		loaded = true;
		if (!file) return;
		try {
			const parsed = JSON.parse(await readFile(file, 'utf8'));
			if (validData(parsed)) data = { ...emptyData(), ...parsed };
		} catch {
			data = emptyData();
		}
	}

	async function persist() {
		if (!file) return;
		await mkdir(dirname(file), { recursive: true });
		const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
		await writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
		try {
			await rename(temp, file);
		} catch (error) {
			await unlink(temp).catch(() => {});
			throw error;
		}
	}

	async function record(event) {
		await load();
		const type = String(event?.type ?? '');
		if (!(type in EVENT_WEIGHTS)) throw new Error(`unsupported feedback type: ${type || '(empty)'}`);
		const track = event.track;
		if (!track?.trackKey || !track.title || !Array.isArray(track.artists)) throw new Error('feedback track must be canonical');
		const at = Number(event.at) || now();
		const current = data.tracks[track.trackKey] ?? {
			trackKey: track.trackKey,
			title: track.title,
			artists: [...track.artists],
			album: track.album || '',
			affinity: 0,
			events: {},
			updatedAt: at
		};
		current.affinity = clamp(decay(current.affinity, current.updatedAt, at) + EVENT_WEIGHTS[type], -20, 20);
		current.events[type] = (current.events[type] || 0) + 1;
		current.updatedAt = at;
		data.tracks[track.trackKey] = current;
		for (const name of track.artists) {
			const key = artistKey(name);
			if (!key) continue;
			const artist = data.artists[key] ?? { name, affinity: 0, updatedAt: at };
			artist.affinity = clamp(decay(artist.affinity, artist.updatedAt, at) + EVENT_WEIGHTS[type] * 0.6, -20, 20);
			artist.updatedAt = at;
			data.artists[key] = artist;
		}
		data.updatedAt = at;
		await persist();
		return clone(current);
	}

	async function migrateLegacy(legacy) {
		await load();
		if (data.migratedLegacy) return false;
		for (const song of legacy?.songs ?? []) {
			const track = normalizeTrack({
				id: song.id,
				name: song.name,
				artists: song.artists,
				album: song.album
			}, 'legacy-habits');
			if (!track) continue;
			const plays = Math.max(0, Number(song.plays) || 0);
			const completed = Math.max(0, Number(song.completed) || 0);
			const seconds = Math.max(0, Number(song.seconds) || 0);
			const at = Number(song.lastAt) || now();
			const affinity = clamp(plays * 0.5 + completed * 1.5 + Math.min(seconds / 600, 3), 0, 20);
			data.tracks[track.trackKey] = {
				trackKey: track.trackKey,
				title: track.title,
				artists: [...track.artists],
				album: track.album,
				affinity,
				events: { 'legacy-play': plays, 'legacy-complete': completed },
				updatedAt: at
			};
		}
		data.migratedLegacy = true;
		data.updatedAt = now();
		await persist();
		return true;
	}

	async function remember(rule) {
		await load();
		const kind = String(rule?.kind ?? '');
		const value = String(rule?.value ?? '').trim();
		if (!RULE_KINDS.has(kind)) throw new Error('preference kind is invalid');
		if (!value) throw new Error('preference value is required');
		const numericWeight = rule?.weight === undefined ? 1 : Number(rule.weight);
		if (!Number.isFinite(numericWeight)) throw new Error('preference weight is invalid');
		const weight = clamp(numericWeight, -1, 1);
		const existing = data.rules.find((item) => item.kind === kind && artistKey(item.value) === artistKey(value));
		if (existing) {
			existing.weight = weight;
			existing.updatedAt = now();
			await persist();
			return clone(existing);
		}
		const entry = { id: `rule-${data.nextRuleId++}`, kind, value, weight, updatedAt: now() };
		data.rules.push(entry);
		data.updatedAt = entry.updatedAt;
		await persist();
		return clone(entry);
	}

	async function forget(ruleId) {
		await load();
		const before = data.rules.length;
		data.rules = data.rules.filter((rule) => rule.id !== ruleId);
		if (data.rules.length !== before) {
			data.updatedAt = now();
			await persist();
			return true;
		}
		return false;
	}

	async function reportSource(result) {
		await load();
		const sourceKey = String(result?.sourceKey ?? '').trim();
		if (!sourceKey) throw new Error('sourceKey is required');
		const stat = data.resolverStats[sourceKey] ?? { ok: 0, failed: 0, updatedAt: 0 };
		if (result.ok) stat.ok += 1;
		else stat.failed += 1;
		stat.updatedAt = now();
		data.resolverStats[sourceKey] = stat;
		data.updatedAt = stat.updatedAt;
		await persist();
		return clone(stat);
	}

	async function snapshot() {
		await load();
		const result = clone(data);
		const at = now();
		for (const entry of Object.values(result.tracks)) entry.affinity = decay(entry.affinity, entry.updatedAt, at);
		for (const entry of Object.values(result.artists)) entry.affinity = decay(entry.affinity, entry.updatedAt, at);
		return result;
	}

	async function clear() {
		await load();
		data = emptyData();
		data.updatedAt = now();
		await persist();
		return true;
	}

	async function flush() {
		await load();
		await persist();
	}

	return { load, record, migrateLegacy, remember, forget, reportSource, snapshot, clear, flush };
}
