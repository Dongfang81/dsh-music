/**
 * dsh-music/lib/player.js —— 内置播放状态机（服务端内存态）。
 *
 * 新架构：插件自带网易云音乐 API 服务 + 浏览器内置 <audio> 播放引擎，
 * 不再依赖 AlgerMusicPlayer App / CDP / 远程控制通道。
 *
 * 本模块维护"播放状态"的唯一事实来源：
 *  - 播放队列（歌曲对象数组，与 API 返回结构一致）
 *  - 当前下标、播放/暂停、音量、播放模式（0 列表循环 / 1 单曲循环 / 2 随机）
 *  - 收藏列表（歌曲 id 集合）
 *  - 播放进度（由客户端 <audio> 上报）
 *
 * 客户端浏览器只负责"出声"（<audio> 元素播放直链），一切控制命令
 * 都回到本状态机，保证工具（模型）与浮窗（浏览器）看到同一份状态。
 *
 * @module dsh-music/lib/player
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createAtomicStateWriter } from './atomic-state-writer.js';

/** 持久化文件路径（收藏 + 播放列表，重启后保留）。 */
function stateFilePath() {
	return join(homedir(), '.dsh', 'moony-singer-state.json');
}

function artistText(value) {
	const entries = Array.isArray(value) ? value : [value];
	const names = entries
		.map((entry) => typeof entry === 'string' ? entry.trim() : String(entry?.name ?? '').trim())
		.filter((name) => name && !/^\[object Object\]$/i.test(name));
	return names.length > 0 ? names.join(' / ') : '未知歌手';
}

function artistList(value) {
	const entries = Array.isArray(value) ? value : [value];
	return entries.map((entry) => typeof entry === 'string'
		? { id: null, name: entry.trim() }
		: { id: entry?.id, name: String(entry?.name ?? '').trim() })
		.filter((entry) => entry.name && !/^\[object Object\]$/i.test(entry.name));
}

function artistsOf(song) {
	return song?.ar ?? song?.artists ?? [];
}

/** 创建内置播放器状态机。 */
export function createPlayer(options = {}) {
	const stateFile = options.file === undefined ? stateFilePath() : options.file;
	const state = {
		queue: [], // 歌曲对象数组 {id,name,ar?,al?,dt?,...}
		index: -1, // 当前播放下标（-1 = 无）
		playing: false,
		volume: 0.8,
		playMode: 0, // 0=列表循环 1=单曲循环 2=随机
		favorites: [], // 收藏的歌曲对象数组（可整单播放）
		position: 0, // 当前进度（秒，客户端上报）
		duration: 0, // 当前时长（秒，客户端上报）
		currentUrl: null, // 当前直链（客户端取用后播放）
		ready: false, // 播放引擎是否就绪（客户端上报）
		recommendationRadio: null
	};
	let removalSequence = 0;
	let lastQueueRemoval = null;
	let stateRevision = 1;
	let queueRevision = 1;
	let favoritesRevision = 1;
	const stateWriter = stateFile ? createAtomicStateWriter({
		file: stateFile,
		delayMs: options.saveDelayMs === undefined ? 300 : options.saveDelayMs
	}) : null;

	function markState() { stateRevision += 1; }
	function markQueue() { queueRevision += 1; markState(); }
	function markFavorites() { favoritesRevision += 1; markState(); }
	function revisions() { return { stateRevision, queueRevision, favoritesRevision }; }

	// 持久化：加载历史状态（收藏 + 播放列表 + 播放模式 + 音量），重启后保留
	try {
		const p = stateFile;
		if (p && existsSync(p)) {
			const saved = JSON.parse(readFileSync(p, 'utf8'));
			if (Array.isArray(saved.favorites)) state.favorites = saved.favorites.filter((f) => f && f.id);
			if (Array.isArray(saved.queue)) state.queue = saved.queue.filter((s) => s && s.id).map((song) => ({ ...song, moonyOrigin: song.moonyOrigin || 'existing' }));
			if (Number.isInteger(saved.index) && saved.index >= 0 && saved.index < state.queue.length) state.index = saved.index;
			if (typeof saved.playMode === 'number' && [0, 1, 2].includes(saved.playMode)) state.playMode = saved.playMode;
			if (typeof saved.volume === 'number' && saved.volume >= 0 && saved.volume <= 1) state.volume = saved.volume;
			if (saved.recommendationRadio?.active && typeof saved.recommendationRadio.sessionId === 'string') {
				state.recommendationRadio = {
					active: true,
					sessionId: saved.recommendationRadio.sessionId,
					batchNumber: Math.max(1, Number(saved.recommendationRadio.batchNumber) || 1),
					seenTrackKeys: [...new Set((saved.recommendationRadio.seenTrackKeys ?? []).filter(Boolean).map(String))],
					waitingForNextBatch: Boolean(saved.recommendationRadio.waitingForNextBatch)
				};
			}
		}
	} catch {
		/* 状态文件损坏则从空状态开始 */
	}

	// 防抖保存：只排队快照，磁盘写入在后台串行执行并以原子 rename 发布。
	function persist() {
		if (!stateWriter) return false;
		return stateWriter.schedule({
			favorites: state.favorites.slice(),
			queue: state.queue.slice(),
			index: state.index,
			playMode: state.playMode,
			volume: state.volume,
			recommendationRadio: state.recommendationRadio ? {
				...state.recommendationRadio,
				seenTrackKeys: state.recommendationRadio.seenTrackKeys.slice()
			} : null,
			at: Date.now()
		});
	}

	function flush() { return stateWriter ? stateWriter.flush() : Promise.resolve(true); }
	function dispose() { return stateWriter ? stateWriter.dispose() : Promise.resolve(true); }

	function queueSong(song) {
		if (!song?.raw || typeof song.raw !== 'object') return { ...song };
		const raw = song.raw;
		return {
			...raw,
			trackKey: song.trackKey,
			name: raw.name || song.title,
			ar: Array.isArray(raw.ar) ? raw.ar : (song.artists || []).map((name) => ({ name })),
			al: raw.al || { name: song.album || '' },
			dt: Number(raw.dt) || song.durationMs || 0,
			resolvedUrl: song.url || raw.resolvedUrl || null,
			resolvedSource: song.sourceKey || raw.resolvedSource || null,
			recommendationScore: song.recommendationScore
		};
	}

	function tagged(songs, origin, recommendationSessionId) {
		return (Array.isArray(songs) ? songs : []).filter(Boolean).map((song) => ({
			...queueSong(song),
			moonyOrigin: origin,
			...(recommendationSessionId ? { recommendationSessionId } : {})
		}));
	}

	function radioStatus() {
		return state.recommendationRadio ? {
			...state.recommendationRadio,
			seenTrackKeys: state.recommendationRadio.seenTrackKeys.slice()
		} : null;
	}

	function exitRecommendationRadio(options = {}) {
		if (!state.recommendationRadio) return false;
		state.recommendationRadio = null;
		if (options.persist !== false) {
			markState();
			persist();
		}
		return true;
	}

	function setRecommendationRadioWaiting(value) {
		if (!state.recommendationRadio?.active) return false;
		const waiting = Boolean(value);
		if (state.recommendationRadio.waitingForNextBatch === waiting) return false;
		state.recommendationRadio.waitingForNextBatch = waiting;
		markState();
		persist();
		return true;
	}

	function startRecommendationRadio(songs, sessionId) {
		const sid = String(sessionId || '').trim();
		if (!sid) throw new Error('recommendation radio sessionId is required');
		const additions = tagged(songs, 'recommendation', sid);
		if (additions.length === 0) throw new Error('recommendation radio batch is empty');
		state.queue = additions;
		state.index = 0;
		state.playing = true;
		state.playMode = 0;
		state.currentUrl = additions[0].resolvedUrl || null;
		state.position = 0;
		state.duration = 0;
		state.recommendationRadio = {
			active: true,
			sessionId: sid,
			batchNumber: 1,
			seenTrackKeys: [...new Set(additions.map((song) => song.trackKey).filter(Boolean))],
			waitingForNextBatch: false
		};
		markQueue();
		persist();
		return { song: current(), sessionId: sid, batchNumber: 1, count: additions.length };
	}

	function isRecommendationRadioBoundary() {
		return Boolean(state.recommendationRadio?.active && state.queue.length > 0 && state.index === state.queue.length - 1);
	}

	function replaceRecommendationRadioBatch(songs) {
		const radio = state.recommendationRadio;
		if (!radio?.active) throw new Error('recommendation radio is not active');
		const additions = tagged(songs, 'recommendation', radio.sessionId);
		if (additions.length === 0) throw new Error('recommendation radio batch is empty');
		state.queue = additions;
		state.index = 0;
		state.playing = true;
		state.currentUrl = additions[0].resolvedUrl || null;
		state.position = 0;
		state.duration = 0;
		radio.batchNumber += 1;
		radio.seenTrackKeys = [...new Set(radio.seenTrackKeys.concat(additions.map((song) => song.trackKey).filter(Boolean)))];
		radio.waitingForNextBatch = false;
		markQueue();
		persist();
		return { song: current(), sessionId: radio.sessionId, batchNumber: radio.batchNumber, count: additions.length };
	}

	/** 收藏歌曲 id 列表（派生，供状态快照）。 */
	function favoriteIds() {
		return state.favorites.map((f) => Number(f.id));
	}

	/** 当前歌曲对象（无则 null）。 */
	function current() {
		return state.index >= 0 && state.index < state.queue.length ? state.queue[state.index] : null;
	}

	/** 当前歌曲是否已收藏。 */
	function isFavorite(id) {
		return state.favorites.some((f) => Number(f.id) === Number(id));
	}

	/** 切到队列第 idx 首（-1 清空）。返回切换后的当前曲。 */
	function setIndex(idx) {
		if (idx < 0 || idx >= state.queue.length) {
			if (state.index === -1 && state.currentUrl === null) return null;
			state.index = -1;
			state.currentUrl = null;
			markState();
			return null;
		}
		if (state.index === idx && state.currentUrl === null) return current();
		state.index = idx;
		state.currentUrl = null; // 客户端取直链后播放
		markState();
		persist();
		return current();
	}

	/** 整单替换队列并播放第一首（与旧版 action=playlist 同语义）。 */
	function replaceAndPlay(songs) {
		exitRecommendationRadio({ persist: false });
		state.queue = tagged(songs, 'manual');
		markQueue();
		if (state.queue.length === 0) {
			state.index = -1;
			state.playing = false;
			return null;
		}
		state.index = 0;
		state.playing = true;
		persist();
		return current();
	}

	/** 清空播放列表（停止播放）。 */
	function clearQueue() {
		exitRecommendationRadio({ persist: false });
		if (state.queue.length === 0 && state.index === -1 && !state.playing && state.position === 0 && state.duration === 0 && state.currentUrl === null) return true;
		state.queue = [];
		state.index = -1;
		state.playing = false;
		state.position = 0;
		state.duration = 0;
		state.currentUrl = null;
		markQueue();
		persist();
		return true;
	}

	/** 追加到队列末尾（保持当前播放）。 */
	function append(songs) {
		exitRecommendationRadio({ persist: false });
		const additions = tagged(songs, 'manual');
		if (additions.length === 0) return state.queue.length;
		state.queue = state.queue.concat(additions);
		markQueue();
		persist();
		return state.queue.length;
	}

	/** 插入到当前歌曲之后。 */
	function insertNext(songs) {
		exitRecommendationRadio({ persist: false });
		const additions = tagged(songs, 'manual');
		if (additions.length === 0) return state.queue.length;
		const at = state.index >= 0 ? state.index + 1 : state.queue.length;
		state.queue = state.queue.slice(0, at).concat(additions, state.queue.slice(at));
		markQueue();
		persist();
		return state.queue.length;
	}

	/** 从播放列表移除单曲；当前曲被移除时优先衔接原下一首。 */
	function removeQueueAt(value) {
		const index = Number(value);
		if (!Number.isInteger(index) || index < 0 || index >= state.queue.length) throw new Error('播放列表下标无效');
		const previousIndex = state.index;
		const previousCurrent = current();
		const [removed] = state.queue.splice(index, 1);
		const currentChanged = index === previousIndex;
		if (state.queue.length === 0) {
			state.index = -1;
			state.playing = false;
			state.currentUrl = null;
			state.position = 0;
			state.duration = 0;
		} else if (index < previousIndex) {
			state.index = previousIndex - 1;
		} else if (currentChanged) {
			state.index = Math.min(index, state.queue.length - 1);
			state.currentUrl = state.queue[state.index]?.resolvedUrl || null;
			state.position = 0;
			state.duration = 0;
		} else if (previousCurrent) {
			state.index = state.queue.indexOf(previousCurrent);
		}
		const token = `queue-remove-${Date.now()}-${++removalSequence}`;
		lastQueueRemoval = { token, song: removed, index };
		markQueue();
		persist();
		return {
			removed,
			token,
			currentChanged,
			current: current(),
			queueLength: state.queue.length
		};
	}

	/** 撤销最近一次单曲移除；只恢复队列位置，不打断已经衔接的新当前曲。 */
	function undoQueueRemoval(token) {
		if (!lastQueueRemoval || String(token || '') !== lastQueueRemoval.token) throw new Error('撤销操作已失效');
		const active = current();
		const at = Math.min(lastQueueRemoval.index, state.queue.length);
		state.queue.splice(at, 0, lastQueueRemoval.song);
		if (active) state.index = state.queue.indexOf(active);
		else if (state.index < 0) state.index = at;
		const restored = lastQueueRemoval.song;
		lastQueueRemoval = null;
		markQueue();
		persist();
		return { restored, current: current(), queueLength: state.queue.length };
	}

	/** 在当前曲之后插入推荐；同一会话重排时仅替换尚未播放的本会话推荐。 */
	function insertRecommendationAfterCurrent(songs, sessionId, options = {}) {
		const sid = String(sessionId || '').trim();
		if (!sid) throw new Error('recommendation sessionId is required');
		if (options.replaceUnplayed !== false) {
			state.queue = state.queue.filter((song, index) =>
				index <= state.index || song.moonyOrigin !== 'recommendation' || song.recommendationSessionId !== sid
			);
		}
		const at = state.index >= 0 ? state.index + 1 : state.queue.length;
		const additions = tagged(songs, 'recommendation', sid);
		state.queue = state.queue.slice(0, at)
			.concat(additions, state.queue.slice(at));
		if ((state.index < 0 || options.playFirst) && additions.length > 0) {
			state.index = at;
			state.playing = true;
			state.currentUrl = state.queue[at].resolvedUrl || null;
		}
		markQueue();
		persist();
		return state.queue.length;
	}

	/** 单曲播放：替换队列为单曲并播放。 */
	function playSong(song) {
		exitRecommendationRadio({ persist: false });
		state.queue = tagged([song], 'manual');
		state.index = 0;
		state.playing = true;
		markQueue();
		persist();
		return song;
	}

	/** 播放/暂停切换。 */
	function togglePlay() {
		if (state.index < 0 && state.queue.length > 0) state.index = 0;
		state.playing = !state.playing;
		markState();
		persist();
		return state.playing;
	}

	/** 下一首（按播放模式：随机时随机选；列表循环到尾回 0）。 */
	function next() {
		if (state.queue.length === 0) return null;
		if (state.playMode === 2) {
			const candidates = state.queue.map((_, i) => i).filter((i) => i !== state.index);
			const pick = candidates[Math.floor(Math.random() * candidates.length)] ?? 0;
			return setIndex(pick);
		}
		const idx = state.index + 1 >= state.queue.length ? 0 : state.index + 1;
		return setIndex(idx);
	}

	/** 上一首（回到队列开头）。 */
	function prev() {
		if (state.queue.length === 0) return null;
		const idx = state.index - 1 < 0 ? 0 : state.index - 1;
		return setIndex(idx);
	}

	/** 跳转队列第 idx 首。 */
	function jump(idx) {
		return setIndex(idx);
	}

	/** 切换播放模式（0/1/2 循环）。 */
	function togglePlayMode() {
		exitRecommendationRadio({ persist: false });
		state.playMode = (state.playMode + 1) % 3;
		markState();
		persist();
		return state.playMode;
	}

	/** 收藏/取消收藏当前歌曲（存完整歌曲对象，供收藏列表整单播放）。返回 {favorite, favoriteIds, count}。 */
	function toggleFavorite() {
		const song = current();
		if (!song) return { favorite: false, favoriteIds: favoriteIds(), count: state.favorites.length };
		const id = Number(song.id);
		if (isFavorite(id)) {
			state.favorites = state.favorites.filter((f) => Number(f.id) !== id);
			markFavorites();
			persist();
			return { favorite: false, favoriteIds: favoriteIds(), count: state.favorites.length };
		}
		state.favorites = state.favorites.concat(song);
		markFavorites();
		persist();
		return { favorite: true, favoriteIds: favoriteIds(), count: state.favorites.length };
	}

	/** 按歌曲 id 取消收藏；不修改当前播放、队列或播放进度。 */
	function removeFavorite(songId) {
		const id = Number(songId);
		if (!Number.isFinite(id)) throw new Error('songId 需要是有效的歌曲 id。');
		const index = state.favorites.findIndex((song) => Number(song.id) === id);
		if (index < 0) return { removed: null, favoriteIds: favoriteIds(), count: state.favorites.length };
		const [removed] = state.favorites.splice(index, 1);
		markFavorites();
		persist();
		return { removed, favoriteIds: favoriteIds(), count: state.favorites.length };
	}

	/** 用收藏列表整单替换队列并从指定位置播放。返回 {song, count}；无收藏返回 {song:null, count:0}。 */
	function playFavorites(startIndex = 0) {
		if (state.favorites.length === 0) return { song: null, count: 0 };
		replaceAndPlay(state.favorites.slice());
		const index = Number.isInteger(startIndex) && startIndex >= 0 && startIndex < state.favorites.length ? startIndex : 0;
		const song = index === 0 ? current() : jump(index);
		return { song, count: state.favorites.length };
	}

	/** 音量 +/-。 */
	function volumeUp() {
		const nextVolume = Math.min(1, Math.round((state.volume + 0.1) * 10) / 10);
		if (nextVolume === state.volume) return state.volume;
		state.volume = nextVolume;
		markState();
		persist();
		return state.volume;
	}
	function volumeDown() {
		const nextVolume = Math.max(0, Math.round((state.volume - 0.1) * 10) / 10);
		if (nextVolume === state.volume) return state.volume;
		state.volume = nextVolume;
		markState();
		persist();
		return state.volume;
	}

	/** 客户端上报播放进度（position/duration/ready；不覆盖 playing——服务端是唯一事实来源）。 */
	function reportPlayback(info) {
		const value = info && typeof info === 'object' ? info : {};
		let changed = false;
		if (typeof value.position === 'number' && Number.isFinite(value.position) && state.position !== value.position) { state.position = value.position; changed = true; }
		if (typeof value.duration === 'number' && Number.isFinite(value.duration) && state.duration !== value.duration) { state.duration = value.duration; changed = true; }
		if (typeof value.ready === 'boolean' && state.ready !== value.ready) { state.ready = value.ready; changed = true; }
		if (changed) markState();
		return true;
	}

	function updatePlayback(patch = {}) {
		let changed = false;
		for (const key of ['playing', 'currentUrl']) {
			if (key in patch && state[key] !== patch[key]) { state[key] = patch[key]; changed = true; }
		}
		if (changed) markState();
		return changed;
	}

	function queueView() {
		return {
			revision: queueRevision,
			count: state.queue.length,
			index: state.index,
			items: state.queue.map((s) => ({
			id: s.id,
			name: s.name,
			artists: artistText(artistsOf(s))
			}))
		};
	}

	/** 供状态快照使用的紧凑视图。 */
	function snapshot(options = {}) {
		const song = current();
		const includeQueue = options.includeQueue !== false;
		const includeFavoriteIds = options.includeFavoriteIds !== false;
		const view = includeQueue ? queueView() : null;
		return {
			stateRevision,
			queue: includeQueue
				? { items: view.items, index: view.index, count: view.count, revision: view.revision }
				: { count: state.queue.length, index: state.index, revision: queueRevision },
			favorites: { count: state.favorites.length, revision: favoritesRevision },
			playing: song
				? {
						id: song.id,
						name: song.name,
						artists: artistText(artistsOf(song)),
						artistList: artistList(artistsOf(song)),
						album: song.al?.name || song.album?.name || '',
						albumPic: song.al?.picUrl || song.picUrl || ''
					}
				: null,
			isPlaying: state.playing,
			position: state.position,
			duration: state.duration,
			volume: state.volume,
			playMode: state.playMode,
			favorite: song ? isFavorite(song.id) : false,
			...(includeFavoriteIds ? { favoriteIds: favoriteIds() } : {}),
			favoriteCount: state.favorites.length,
			currentUrl: state.currentUrl,
			ready: state.ready
		};
	}

	return {
		state,
		current,
		isFavorite,
		revisions,
		queueView,
		setIndex,
		replaceAndPlay,
		clearQueue,
		append,
		insertNext,
		removeQueueAt,
		undoQueueRemoval,
		insertRecommendationAfterCurrent,
		startRecommendationRadio,
		replaceRecommendationRadioBatch,
		isRecommendationRadioBoundary,
		radioStatus,
		exitRecommendationRadio,
		setRecommendationRadioWaiting,
		playSong,
		togglePlay,
		next,
		prev,
		jump,
		togglePlayMode,
		toggleFavorite,
		removeFavorite,
		playFavorites,
		volumeUp,
		volumeDown,
		reportPlayback,
		updatePlayback,
		snapshot,
		flush,
		dispose
	};
}
