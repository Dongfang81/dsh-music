/**
 * 月宝儿「听歌记忆」：本地播放习惯记录（纯本地，不上传、不跨设备）。
 *
 * 数据文件：~/.dsh/moony-singer-habits.json（可随时清空：alger_habits action=clear
 * 或直接删除文件）。只记录播放事实（哪首歌、听了多久、什么时段），不做画像。
 *
 * 记录入口复用客户端的播放进度上报（/dsh-alger/playback，播放中定期上报）：
 *  - 累计播放秒数（防误计：暂停不计、进度倒跳不计、单次跳变 >60s 视为 seek 不计）
 *  - 切歌计一次「播放次数」；上一首听到 ≥90% 计一次「完整收听」
 *  - 24 小时时段直方图 + 每日深夜累计（深夜 23:00–05:00）
 *
 * 容量：最多保留 MAX_SONGS 首歌（按累计秒数裁剪）；90 天以上且只听过 1 次的自动清理。
 * 深夜提醒：当日深夜累计播放 ≥2 小时时提醒一次（24 小时内不重复）。
 * 常听判定：播放 ≥3 次且最近 30 天内播过。
 */
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const MAX_SONGS = 300; // 最多保留的歌曲条目
const MAX_SEEK_JUMP = 60; // 单次进度跳变超过此值视为 seek，不计入
const NIGHT_START = 23; // 深夜时段起点（23:00）
const NIGHT_END = 5; // 深夜时段终点（05:00，不含）
const NIGHT_REMIND_SECONDS = 7200; // 深夜累计播放 2 小时 → 提醒
const NIGHT_REMIND_INTERVAL_MS = 24 * 3600 * 1000; // 提醒间隔（24h）
const NIGHT_DAYS_KEEP = 14; // 每日深夜记录保留天数
const FREQUENT_PLAYS = 3; // 播放次数达到此值视为「常听」
const FREQUENT_WINDOW_MS = 30 * 24 * 3600 * 1000; // 常听判定的最近窗口
const STALE_SINGLE_MS = 90 * 24 * 3600 * 1000; // 单次播放条目的过期清理窗口
const SAVE_DELAY_MS = 30_000; // 播放中批量落盘，减少长期写盘

const emptyData = () => ({
	version: 1,
	songs: {}, // songId → {id,name,artists,album,plays,seconds,completed,lastAt}
	byHour: new Array(24).fill(0), // 全时段累计秒数
	today: { date: '', seconds: 0 }, // 今日累计（date 形如 2026-08-21）
	nightDays: {}, // date → {plays, seconds}（深夜时段累计，保留近 14 天）
	nightRemindedAt: 0,
	updatedAt: 0
});

function dayKey(t) {
	const d = new Date(t);
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return d.getFullYear() + '-' + m + '-' + day;
}

function inNightWindow(hour) {
	return hour >= NIGHT_START || hour < NIGHT_END;
}

/**
 * 创建听歌记忆模块。
 * @param {object} [options]
 * @param {string|null} [options.file] 数据文件路径；null 表示纯内存（测试用）
 * @param {function} [options.now] 时钟注入（测试用），返回毫秒时间戳
 */
export function createHabits(options = {}) {
	const file = options.file === undefined ? join(homedir(), '.dsh', 'moony-singer-habits.json') : options.file;
	const now = options.now || (() => Date.now());
	const saveDelayMs = Math.max(0, Number(options.saveDelayMs ?? SAVE_DELAY_MS));
	const fileSystem = options.fs || { readFile, writeFile, mkdir };

	let data = emptyData();
	let loaded = false;
	let saveTimer = null;
	let dirty = false;
	let dirtyRevision = 0;
	let savePromise = null;

	function markDirty() {
		dirty = true;
		dirtyRevision += 1;
	}

	// 会话级跟踪：当前歌曲与上次上报进度（切歌/防误计用，不落盘）
	let session = { songId: null, lastPos: 0, duration: 0, playing: false };

	async function load() {
		loaded = true;
		if (!file) return;
		try {
			const raw = await fileSystem.readFile(file, 'utf8');
			const parsed = JSON.parse(raw);
			const base = emptyData();
			data = {
				...base,
				...(parsed && typeof parsed === 'object' ? parsed : {}),
				songs: (parsed && parsed.songs && typeof parsed.songs === 'object') ? parsed.songs : {},
				byHour: Array.isArray(parsed && parsed.byHour) && parsed.byHour.length === 24 ? parsed.byHour : base.byHour,
				today: parsed && parsed.today && typeof parsed.today === 'object' ? parsed.today : base.today,
				nightDays: parsed && parsed.nightDays && typeof parsed.nightDays === 'object' ? parsed.nightDays : {},
				nightRemindedAt: Number((parsed && parsed.nightRemindedAt) || 0)
			};
		} catch {
			/* 首次运行或文件损坏：用空数据 */
		}
	}

	function prune() {
		const t = now();
		let changed = false;
		// 歌曲条目：裁剪到 MAX_SONGS（按累计秒数升序删最早/最少的）
		const keys = Object.keys(data.songs);
		if (keys.length > MAX_SONGS) {
			const sorted = keys.slice().sort((a, b) => data.songs[a].seconds - data.songs[b].seconds);
			for (let i = 0; i < sorted.length - MAX_SONGS; i++) { delete data.songs[sorted[i]]; changed = true; }
		}
		// 90 天以上且只听过 1 次的旧条目
		for (const k of Object.keys(data.songs)) {
			const e = data.songs[k];
			if (e && e.plays <= 1 && e.lastAt > 0 && t - e.lastAt > STALE_SINGLE_MS) { delete data.songs[k]; changed = true; }
		}
		// 每日深夜记录：只保留近 NIGHT_DAYS_KEEP 天
		const cutoff = dayKey(t - NIGHT_DAYS_KEEP * 24 * 3600 * 1000);
		for (const k of Object.keys(data.nightDays)) {
			if (k < cutoff) { delete data.nightDays[k]; changed = true; }
		}
		return changed;
	}

	async function save() {
		if (savePromise) {
			await savePromise;
			return dirty ? save() : false;
		}
		if (!dirty) return false;
		if (!file) { dirty = false; return true; }
		if (prune()) markDirty();
		const savingRevision = dirtyRevision;
		data.updatedAt = now();
		const payload = JSON.stringify(data);
		savePromise = (async () => {
			try {
				await fileSystem.mkdir(dirname(file), { recursive: true });
				await fileSystem.writeFile(file, payload);
				dirty = dirtyRevision !== savingRevision;
				if (dirty) scheduleSave();
				return true;
			} catch {
				/* 写失败静默：记忆是锦上添花，不影响播放 */
				return false;
			}
		})();
		try {
			return await savePromise;
		} finally {
			savePromise = null;
		}
	}

	function scheduleSave() {
		if (!dirty || !file) return;
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => { saveTimer = null; save(); }, saveDelayMs);
	}

	/** 立即落盘（测试/退出前用）。 */
	async function flush() {
		if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
		await save();
	}

	function songEntry(song) {
		const sid = String(song.id);
		let e = data.songs[sid];
		if (!e) {
			e = {
				id: song.id,
				name: String(song.name || ''),
				artists: String(song.artists || ''),
				album: String(song.album || ''),
				plays: 0,
				seconds: 0,
				completed: 0,
				lastAt: 0
			};
			data.songs[sid] = e;
		}
		return e;
	}

	/**
	 * 播放进度上报 → 累计听歌记忆。
	 * @param {object} info {song:{id,name,artists,album}, position, duration, playing}
	 */
	async function recordPlayback(info) {
		if (!loaded) await load();
		const song = info && info.song;
		if (!song || !song.id) { session = { songId: null, lastPos: 0, duration: 0, playing: false }; return false; }
		const sid = String(song.id);
		const pos = Number(info.position) || 0;
		const dur = Number(info.duration) || 0;
		const playing = Boolean(info.playing);
		const t = now();
		const hour = new Date(t).getHours();
		const previousSongId = session.songId;
		const wasPlaying = session.playing;
		let changed = false;

		// 切歌：上一首收尾（≥90% 计完整收听），新歌 +1 播放次数
		if (session.songId !== sid) {
			if (session.songId && session.duration > 0 && session.lastPos >= session.duration * 0.9) {
				const prev = data.songs[session.songId];
				if (prev) { prev.completed = (prev.completed || 0) + 1; changed = true; }
			}
			const entry = songEntry(song);
			entry.plays += 1;
			entry.lastAt = t;
			changed = true;
			if (inNightWindow(hour)) {
				const dk = dayKey(t);
				const nd = data.nightDays[dk] || (data.nightDays[dk] = { plays: 0, seconds: 0 });
				nd.plays += 1;
			}
			session.songId = sid;
			session.lastPos = pos;
			session.duration = dur;
		}

		// 累计播放秒数：仅播放中且增量合理（0 < delta ≤ MAX_SEEK_JUMP）
		if (playing) {
			const delta = pos - session.lastPos;
			if (delta > 0 && delta <= MAX_SEEK_JUMP) {
				// 用 songEntry 而非裸查找：刚切到的歌可能已被裁剪（0 秒条目），需要重建
				const entry = songEntry(song);
				entry.seconds += delta;
				entry.lastAt = t;
				data.byHour[hour] = (data.byHour[hour] || 0) + delta;
				const dk = dayKey(t);
				if (data.today.date !== dk) data.today = { date: dk, seconds: 0 };
				data.today.seconds += delta;
				if (inNightWindow(hour)) {
					const nd = data.nightDays[dk] || (data.nightDays[dk] = { plays: 0, seconds: 0 });
					nd.seconds += delta;
				}
				changed = true;
			}
		}
		session.lastPos = pos;
		session.duration = dur || session.duration;
		session.playing = playing;
		const pruned = prune();
		if (changed || pruned) markDirty();
		if ((previousSongId && previousSongId !== sid) || (wasPlaying && !playing)) await flush();
		else scheduleSave();
		return true;
	}

	/** 汇总视图（对话问答用）。 */
	async function summary() {
		if (!loaded) await load();
		const t = now();
		const dk = dayKey(t);
		const songs = Object.values(data.songs);
		const topSongs = songs
			.slice()
			.sort((a, b) => b.seconds - a.seconds)
			.slice(0, 10)
			.map((s) => ({ name: s.name, artists: s.artists, plays: s.plays, seconds: Math.round(s.seconds), completed: s.completed || 0, lastAt: s.lastAt }));
		const artistSeconds = {};
		for (const s of songs) {
			const a = s.artists || '未知歌手';
			artistSeconds[a] = (artistSeconds[a] || 0) + s.seconds;
		}
		const topArtists = Object.entries(artistSeconds)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([name, seconds]) => ({ name, seconds: Math.round(seconds) }));
		// 近 7 天深夜活跃：深夜播放次数合计
		const cutoffKey = dayKey(t - 7 * 24 * 3600 * 1000);
		let nightPlays7d = 0;
		let nightSeconds7d = 0;
		for (const k of Object.keys(data.nightDays)) {
			if (k >= cutoffKey) {
				nightPlays7d += data.nightDays[k].plays || 0;
				nightSeconds7d += data.nightDays[k].seconds || 0;
			}
		}
		const todaySeconds = data.today && data.today.date === dk ? data.today.seconds : 0;
		return {
			totalSongs: songs.length,
			totalSeconds: Math.round(songs.reduce((sum, s) => sum + s.seconds, 0)),
			totalPlays: songs.reduce((sum, s) => sum + s.plays, 0),
			topSongs,
			topArtists,
			todaySeconds: Math.round(todaySeconds),
			nightPlays7d,
			nightSeconds7d: Math.round(nightSeconds7d),
			nightActive: nightPlays7d >= FREQUENT_PLAYS
		};
	}

	/** 单曲常听判定（宠物互动用）。 */
	async function songCheck(songId) {
		if (!loaded) await load();
		const e = data.songs[String(songId)];
		if (!e) return { frequent: false, plays: 0, lastAt: 0 };
		const frequent = e.plays >= FREQUENT_PLAYS && e.lastAt > 0 && now() - e.lastAt <= FREQUENT_WINDOW_MS;
		return { frequent, plays: e.plays, lastAt: e.lastAt, name: e.name };
	}

	/**
	 * 导出旧版听歌事实，供新版偏好档案做一次性迁移。
	 * 这里只暴露实际记录，不推断喜欢、不喜欢或跳过原因。
	 */
	async function exportLegacy() {
		if (!loaded) await load();
		return {
			songs: Object.values(data.songs).map((song) => ({
				id: song.id,
				name: song.name,
				artists: song.artists,
				album: song.album,
				plays: song.plays,
				seconds: song.seconds,
				completed: song.completed || 0,
				lastAt: song.lastAt
			})),
			byHour: data.byHour.slice()
		};
	}

	/**
	 * 深夜提醒判定：当日深夜（23–5 点）累计播放 ≥2 小时且 24h 内未提醒过 →
	 * 触发并记录提醒时间。
	 */
	async function nightCheck() {
		if (!loaded) await load();
		const t = now();
		const hour = new Date(t).getHours();
		if (!inNightWindow(hour)) return { remind: false, nightSeconds: 0 };
		const dk = dayKey(t);
		const nd = data.nightDays[dk];
		const nightSeconds = nd ? nd.seconds : 0;
		if (nightSeconds >= NIGHT_REMIND_SECONDS && t - (data.nightRemindedAt || 0) >= NIGHT_REMIND_INTERVAL_MS) {
			data.nightRemindedAt = t;
			markDirty();
			scheduleSave();
			return { remind: true, nightSeconds: Math.round(nightSeconds) };
		}
		return { remind: false, nightSeconds: Math.round(nightSeconds) };
	}

	/** 清空全部记忆。 */
	async function clear() {
		if (!loaded) await load();
		data = emptyData();
		session = { songId: null, lastPos: 0, duration: 0, playing: false };
		markDirty();
		await flush();
		return true;
	}

	return { recordPlayback, summary, songCheck, nightCheck, exportLegacy, clear, flush };
}
