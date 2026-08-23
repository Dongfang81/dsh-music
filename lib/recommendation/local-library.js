import * as nodeFs from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, sep } from 'node:path';
import { parseFile as parseAudioFile } from 'music-metadata';

import { normalizeTrack } from './identity.js';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.wav']);

function contained(root, target) {
	const rel = relative(root, target);
	return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function searchText(value) {
	return String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function copyTrack(track) {
	return {
		...track,
		artists: [...track.artists],
		versionTags: [...track.versionTags],
		origins: [...track.origins]
	};
}

export function createLocalLibrary(options = {}) {
	const roots = [...(options.roots ?? [])];
	if (roots.some((root) => !isAbsolute(root))) throw new Error('local music roots must be absolute paths');
	const fs = options.fs ?? nodeFs;
	const parseFile = options.parseFile ?? parseAudioFile;
	const now = typeof options.now === 'function' ? options.now : Date.now;
	let rootPaths = [];
	let index = new Map();

	async function scan() {
		const next = new Map();
		const failures = [];
		let rejected = 0;
		rootPaths = [];
		for (const configuredRoot of roots) {
			try {
				const resolvedRoot = await fs.realpath(configuredRoot);
				rootPaths.push(resolvedRoot);
			} catch (error) {
				failures.push({ path: configuredRoot, message: error?.message ?? String(error) });
			}
		}

		const visitedDirectories = new Set();
		async function walk(directory, root) {
			if (visitedDirectories.has(directory)) return;
			visitedDirectories.add(directory);
			let entries;
			try {
				entries = await fs.readdir(directory, { withFileTypes: true });
			} catch (error) {
				failures.push({ path: directory, message: error?.message ?? String(error) });
				return;
			}
			for (const entry of entries) {
				const candidatePath = `${directory}${sep}${entry.name}`;
				let realPath;
				try {
					realPath = await fs.realpath(candidatePath);
				} catch (error) {
					failures.push({ path: candidatePath, message: error?.message ?? String(error) });
					continue;
				}
				if (!contained(root, realPath)) {
					rejected += 1;
					continue;
				}
				let info;
				try {
					info = await fs.stat(realPath);
				} catch (error) {
					failures.push({ path: realPath, message: error?.message ?? String(error) });
					continue;
				}
				if (info.isDirectory()) {
					await walk(realPath, root);
					continue;
				}
				if (!info.isFile() || !AUDIO_EXTENSIONS.has(extname(realPath).toLocaleLowerCase())) continue;
				try {
					const metadata = await parseFile(realPath, { duration: true, skipCovers: true });
					const common = metadata?.common ?? {};
					const title = common.title || basename(realPath, extname(realPath));
					const artists = common.artists?.length ? common.artists : common.artist || common.albumartist || '未知艺术家';
					const isrc = Array.isArray(common.isrc) ? common.isrc[0] : common.isrc;
					const track = normalizeTrack({
						title,
						artists,
						album: common.album || '',
						durationMs: Math.round((Number(metadata?.format?.duration) || 0) * 1000),
						isrc,
						localPath: realPath
					}, 'local-library');
					if (!track) continue;
					track.localPath = realPath;
					track.indexedAt = now();
					next.set(track.trackKey, track);
				} catch (error) {
					failures.push({ path: realPath, message: error?.message ?? String(error) });
				}
			}
		}

		for (const root of rootPaths) await walk(root, root);
		index = next;
		return { indexed: index.size, rejected, failures };
	}

	async function candidates() {
		return [...index.values()].map(copyTrack);
	}

	async function search(query) {
		const needle = searchText(query);
		if (!needle) return candidates();
		return [...index.values()]
			.filter((track) => searchText([track.title, ...track.artists, track.album].join(' ')).includes(needle))
			.map(copyTrack);
	}

	async function resolve(trackKey) {
		const track = index.get(String(trackKey ?? ''));
		if (!track) return null;
		try {
			const currentPath = await fs.realpath(track.localPath);
			if (!rootPaths.some((root) => contained(root, currentPath))) return null;
			const info = await fs.stat(currentPath);
			if (!info.isFile()) return null;
			return copyTrack({ ...track, localPath: currentPath });
		} catch {
			return null;
		}
	}

	async function clear() {
		index = new Map();
		return true;
	}

	return { scan, search, candidates, resolve, clear };
}
