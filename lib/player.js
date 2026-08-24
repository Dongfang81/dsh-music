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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/** 持久化文件路径（收藏 + 播放列表，重启后保留）。 */
function stateFilePath() {
	return join(homedir(), '.dsh', 'moony-singer-state.json');
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
		ready: false // 播放引擎是否就绪（客户端上报）
	};
	let removalSequence = 0;
	let lastQueueRemoval = null;

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
		}
	} catch {
		/* 状态文件损坏则从空状态开始 */
	}

	// 防抖保存（300ms 合并连续变更）
	let saveTimer = null;
	function persist() {
		if (!stateFile) return;
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			saveTimer = null;
			try {
				const dir = join(homedir(), '.dsh');
				if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
				writeFileSync(stateFile, JSON.stringify({
					favorites: state.favorites,
					queue: state.queue,
					index: state.index,
					playMode: state.playMode,
					volume: state.volume,
					at: Date.now()
				}), 'utf8');
			} catch {
				/* 持久化失败不影响播放 */
			}
		}, 300);
	}

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
			state.index = -1;
			state.currentUrl = null;
			return null;
		}
		state.index = idx;
		state.currentUrl = null; // 客户端取直链后播放
		persist();
		return current();
	}

	/** 整单替换队列并播放第一首（与旧版 action=playlist 同语义）。 */
	function replaceAndPlay(songs) {
		state.queue = tagged(songs, 'manual');
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
		state.queue = [];
		state.index = -1;
		state.playing = false;
		state.position = 0;
		state.duration = 0;
		state.currentUrl = null;
		persist();
		return true;
	}

	/** 追加到队列末尾（保持当前播放）。 */
	function append(songs) {
		state.queue = state.queue.concat(tagged(songs, 'manual'));
		persist();
		return state.queue.length;
	}

	/** 插入到当前歌曲之后。 */
	function insertNext(songs) {
		const at = state.index >= 0 ? state.index + 1 : state.queue.length;
		state.queue = state.queue.slice(0, at).concat(tagged(songs, 'manual'), state.queue.slice(at));
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
		persist();
		return { restored, current: current(), queueLength: state.queue.length };
	}

	/** 在当前曲之后插入推荐；同一会话重排时仅替换尚未播放的本会话推荐。 */
	function insertRecommendationAfterCurrent(songs, sessionId, options = {}) {
		const sid = String(sessionId || '').trim();
		if (!sid) throw new Error('recommendation sessionId is required');
		state.queue = state.queue.filter((song, index) =>
			index <= state.index || song.moonyOrigin !== 'recommendation' || song.recommendationSessionId !== sid
		);
		const at = state.index >= 0 ? state.index + 1 : state.queue.length;
		const additions = tagged(songs, 'recommendation', sid);
		state.queue = state.queue.slice(0, at)
			.concat(additions, state.queue.slice(at));
		if ((state.index < 0 || options.playFirst) && additions.length > 0) {
			state.index = at;
			state.playing = true;
			state.currentUrl = state.queue[at].resolvedUrl || null;
		}
		persist();
		return state.queue.length;
	}

	/** 单曲播放：替换队列为单曲并播放。 */
	function playSong(song) {
		state.queue = tagged([song], 'manual');
		state.index = 0;
		state.playing = true;
		persist();
		return song;
	}

	/** 播放/暂停切换。 */
	function togglePlay() {
		if (state.index < 0 && state.queue.length > 0) state.index = 0;
		state.playing = !state.playing;
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
		state.playMode = (state.playMode + 1) % 3;
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
			persist();
			return { favorite: false, favoriteIds: favoriteIds(), count: state.favorites.length };
		}
		state.favorites = state.favorites.concat(song);
		persist();
		return { favorite: true, favoriteIds: favoriteIds(), count: state.favorites.length };
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
		state.volume = Math.min(1, Math.round((state.volume + 0.1) * 10) / 10);
		persist();
		return state.volume;
	}
	function volumeDown() {
		state.volume = Math.max(0, Math.round((state.volume - 0.1) * 10) / 10);
		persist();
		return state.volume;
	}

	/** 客户端上报播放进度（position/duration/ready；不覆盖 playing——服务端是唯一事实来源）。 */
	function reportPlayback(info) {
		const value = info && typeof info === 'object' ? info : {};
		if (typeof value.position === 'number' && Number.isFinite(value.position)) state.position = value.position;
		if (typeof value.duration === 'number' && Number.isFinite(value.duration)) state.duration = value.duration;
		if (typeof value.ready === 'boolean') state.ready = value.ready;
		return true;
	}

	/** 供状态快照使用的紧凑视图。 */
	function snapshot(extra) {
		const song = current();
		const queueView = state.queue.map((s) => ({
			id: s.id,
			name: s.name,
			artists: (s.ar || s.artists || []).map((a) => a.name).join(' / ')
		}));
		return {
			queue: { items: queueView, index: state.index },
			playing: song
				? {
						id: song.id,
						name: song.name,
						artists: (song.ar || song.artists || []).map((a) => a.name).join(', '),
						artistList: (song.ar || song.artists || []).map((a) => ({ id: a.id, name: a.name })),
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
			favoriteIds: favoriteIds(),
			favoriteCount: state.favorites.length,
			currentUrl: state.currentUrl,
			ready: state.ready,
			...(extra || {})
		};
	}

	return {
		state,
		current,
		isFavorite,
		setIndex,
		replaceAndPlay,
		clearQueue,
		append,
		insertNext,
		removeQueueAt,
		undoQueueRemoval,
		insertRecommendationAfterCurrent,
		playSong,
		togglePlay,
		next,
		prev,
		jump,
		togglePlayMode,
		toggleFavorite,
		playFavorites,
		volumeUp,
		volumeDown,
		reportPlayback,
		snapshot
	};
}
