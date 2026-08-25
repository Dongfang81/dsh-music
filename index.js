/**
 * Copyright (C) 2026 DongfangXie (dongfangxie)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * dsh-moony-singer —— 本地音乐播放插件（服务端工具型 + Web 路由）。
 *
 * 自带开源网易云音乐 API 服务（netease-cloud-music-api-alger，MIT），
 * 浮窗内置 <audio> 播放引擎，无需安装任何桌面播放器即可搜索与播放：
 *  - 工具（给模型用）：alger_status / alger_setup / alger_search / alger_song /
 *    alger_playlist / alger_play / alger_control / alger_recommend；
 *  - Web 路由（给浏览器浮动窗口 client.js 用）：
 *    GET  /dsh-alger/state    播放器状态快照
 *    POST /dsh-alger/command  播放控制命令 { action }
 *    POST /dsh-alger/search   搜索 { keywords, type?, limit? }
 *    POST /dsh-alger/play     点歌 { keyword? | songId? }
 *    POST /dsh-alger/url      取歌曲直链 { id }
 *    POST /dsh-alger/playback 播放进度上报（客户端 <audio>）
 *    POST /dsh-alger/setup    内置服务管理 { action: check|start|stop }
 *
 * 单条本地通道：插件自启的音乐 API 服务（默认 30588，仅回环）。
 * 播放状态由内置状态机（lib/player.js）维护，浏览器只负责出声。
 *
 * 依赖注入：ctx.subprocess（进程执行）、ctx.tools（工具注册）、ctx.webServer（路由）。
 *
 * @module dsh-moony-singer
 */
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createClient } from './lib/alger.js';
import { createPlayer } from './lib/player.js';
import { createHabits } from './lib/habits.js';
import { startApiServer, stopApiServer } from './lib/api-server.js';
import { normalizeTrack } from './lib/recommendation/identity.js';
import { createTasteProfile } from './lib/recommendation/profile.js';
import { createLocalLibrary } from './lib/recommendation/local-library.js';
import { createRetrievers } from './lib/recommendation/retrievers.js';
import { createSourceResolver } from './lib/recommendation/source-resolver.js';
import { createRecommendationCoordinator } from './lib/recommendation/coordinator.js';
import { createRecommendationPool } from './lib/recommendation/pool.js';
import { createRecommendationGenerator } from './lib/recommendation/generator.js';
import { createRecommendationScheduler } from './lib/recommendation/scheduler.js';

export const name = '@dongfang81/dsh-music';
export const inject = ['subprocess', 'tools', 'webServer'];

export function resolveDataRoot(env = process.env, home = homedir()) {
	const configured = String(env?.DSH_HOME ?? '').trim();
	return configured ? resolve(configured) : join(home, '.dsh');
}

/** 默认配置（可被 cordis.patch.yml 的 config 覆盖）。 */
const DEFAULTS = {
	// 内置音乐 API 服务（插件自启，无需任何桌面播放器）
	musicApiPort: 30588,
	musicApiHost: '127.0.0.1',
	timeoutMs: 20000,
	localMusicPaths: [],
	recommendationLearning: true,
	// 旧版兼容字段：后台池上线后不再向用户展示，旧配置仍可安全读取。
	recommendationTargetSize: 15
};

function resolveConfig(config) {
	const c = config && typeof config === 'object' ? config : {};
	const out = { ...DEFAULTS };
	for (const key of Object.keys(DEFAULTS)) {
		if (c[key] !== undefined && c[key] !== null) out[key] = c[key];
	}
	return out;
}

/** 编译参数 DSL 为 JSON Schema（支持 enum / array / required）。 */
function compileParameters(spec) {
	const properties = {};
	const required = [];
	for (const [key, prop] of Object.entries(spec)) {
		if (prop?.required === true) required.push(key);
		const node = {};
		if (typeof prop?.type === 'string') node.type = prop.type;
		if (typeof prop?.description === 'string') node.description = prop.description;
		if (Array.isArray(prop?.enum) && prop.enum.length > 0) node.enum = prop.enum;
		if (prop?.type === 'array' && prop.items && typeof prop.items === 'object') {
			node.items = { type: prop.items.type || 'string' };
		}
		properties[key] = node;
	}
	return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

function asRecord(value) {
	return typeof value === 'object' && value !== null ? value : {};
}

export function createPreferenceAction(profile) {
	return async function preference(args) {
		const action = String(args?.action ?? 'summary');
		if (action === 'summary') return { ok: true, profile: await profile.snapshot() };
		if (action === 'remember') {
			const kind = String(args?.kind ?? '').trim();
			const value = String(args?.value ?? '').trim();
			if (!kind) throw new Error('remember requires kind');
			if (!value) throw new Error('remember requires value');
			const rule = await profile.remember({ kind, value, weight: args?.weight });
			return { ok: true, rule };
		}
		if (action === 'forget') {
			const ruleId = String(args?.ruleId ?? '').trim();
			if (!ruleId) throw new Error('forget requires ruleId');
			return { ok: true, forgotten: await profile.forget(ruleId) };
		}
		if (action === 'clear') {
			await profile.clear();
			return { ok: true, cleared: true };
		}
		throw new Error('action must be summary / remember / forget / clear');
	};
}

/** 网易云歌曲 → 紧凑结构（与 App 自己展示的字段一致）。 */
function compactSong(item) {
	if (!item) return null;
	return {
		id: item.id,
		name: item.name,
		artists: (item.ar || item.artists || []).map((a) => a.name).join(' / '),
		album: item.al?.name || item.album?.name || '',
		durationMs: item.dt ?? null,
		picUrl: item.al?.picUrl || item.picUrl || ''
	};
}

/** 中文时长格式 mm:ss。 */
function fmtDuration(ms) {
	if (!ms && ms !== 0) return '';
	const s = Math.round(ms / 1000);
	return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/** 判断是否命中“点歌”目标（标题归一化后精确匹配）。 */
function normalize(s) {
	return String(s ?? '').trim().toLowerCase();
}

/**
 * 所有业务动作（工具与 Web 路由共用）。
 */
/**
 * 所有业务动作（工具与 Web 路由共用）。
 *
 * @param {object} cfg - 插件配置
 * @param {object} client - 内置音乐 API 客户端（lib/alger.js）
 * @param {object} shared - 共享状态（notice / agentStatus）
 * @param {object} player - 内置播放状态机（lib/player.js）
 * @param {object} apiHandle - 内置 API 服务状态（{handle, isUp, serverEntryPath}）
 * @param {object} habits - 听歌记忆模块（lib/habits.js）
 */
function buildActions(cfg, client, shared, player, apiHandle, habits, recommendation = {}) {
	const coordinator = recommendation.coordinator ?? null;
	const preference = recommendation.preference ?? null;
	const pool = recommendation.pool ?? null;
	const scheduler = recommendation.scheduler ?? null;
	const now = typeof recommendation.now === 'function' ? recommendation.now : Date.now;
	const refreshSignals = new Set(['favorite', 'unfavorite', 'search-play']);
	const feedback = async (type, song) => {
		if (cfg.recommendationLearning && coordinator && song) {
			const track = song.trackKey ? song : normalizeTrack(song, 'player');
			if (track) await coordinator.feedback({ type, track }).catch(() => {});
		}
		if (refreshSignals.has(type)) scheduler?.schedule(type);
	};
	// 宠物台词/通知（agent → 宠物气泡，约 6 秒）
	const noticeStore = { text: '', until: 0 };
	shared.setNotice = (text, ms = 6000) => {
		noticeStore.text = String(text ?? '').slice(0, 80);
		noticeStore.until = Date.now() + ms;
	};
	shared.getNotice = () => (noticeStore.until > Date.now() ? noticeStore.text : null);

	// 音乐服务是否在线：成功长缓存、失败短缓存；并发状态读取共享一次探活。
	let apiUpCache = { value: false, at: 0, valid: false };
	let apiUpPending = null;
	async function apiUp() {
		const ttl = apiUpCache.value ? 60_000 : 5_000;
		if (apiUpCache.valid && now() - apiUpCache.at < ttl) return apiUpCache.value;
		if (apiUpPending) return apiUpPending;
		apiUpPending = Promise.resolve(client.musicApiUp({ timeoutMs: 1000 }))
			.then((up) => {
				apiUpCache = { value: Boolean(up), at: now(), valid: true };
				if (apiHandle) apiHandle.isUp = Boolean(up);
				return Boolean(up);
			})
			.finally(() => { apiUpPending = null; });
		return apiUpPending;
	}

	/** 原始关键词 → 拆成「歌名 - 歌手」（支持「歌手 歌名」/「歌名 歌手」/「歌名-歌手」）。 */
	function splitKeyword(kw) {
		const s = String(kw || '').trim();
		if (!s) return { name: '', artist: '' };
		// 「歌名 - 歌手」或「歌名-歌手」
		let m = s.match(/^(.+?)\s*[-–—]\s*(.+)$/);
		if (m) return { name: m[1].trim(), artist: m[2].trim() };
		// 空格分隔：视第一个词为歌手、其余为歌名（如「周杰伦 双截棍」）
		const parts = s.split(/\s+/);
		if (parts.length >= 2) {
			return { name: parts.slice(1).join(' '), artist: parts[0] };
		}
		return { name: s, artist: '' };
	}

	/** 取歌曲直链：只接受主音乐 API 已确认歌曲身份的官方直链。
	 * 第三方关键词跨源匹配暂时熔断，避免把翻唱、伴奏或个人上传冒充原唱。 */
	async function urlFor(song, keyword) {
		if (song?.resolvedUrl) return { url: song.resolvedUrl };
		const kw = String(keyword || '').trim();
		const parts = splitKeyword(kw);
		// 关键词歌手与歌曲歌手是否一致（如「周杰伦 晴天」vs 列表里的 A-LNK 版 → 不一致）
		const songArtists = ((song && (song.ar || song.artists)) || [])
			.map((a) => a && a.name)
			.filter(Boolean)
			.join(' ');
		const consistent = !parts.artist || !songArtists ||
			songArtists.includes(parts.artist) ||
			parts.artist.includes(songArtists.split(/\s+/)[0] || '');
		// 1) 音乐 API 直链（歌手一致才用，避免拿到翻唱版的直链）
		if (song && song.id && consistent) {
			try {
				const url = await client.songUrl(song.id, 'higher');
				if (url) return { url };
			} catch {
				/* 继续兜底 */
			}
		}
		return null;
	}

	return {
		/** alger_status */
		async status() {
			const [musicApiUp, poolState] = await Promise.all([
				apiUp(),
				pool ? pool.status().catch(() => null) : Promise.resolve(null)
			]);
			const schedulerState = scheduler?.status?.() ?? null;
			const snap = player.snapshot();
			return {
				ok: true,
				musicApiUp,
				playing: snap.playing
					? { ok: true, isPlaying: snap.isPlaying, song: snap.playing }
					: null,
				playback: snap.playing
					? { position: snap.position, duration: snap.duration, playing: snap.isPlaying }
					: null,
				favorite: snap.favorite,
				favoriteIds: snap.favoriteIds,
				favoriteCount: snap.favoriteCount,
				playMode: snap.playMode,
				volume: snap.volume,
				currentUrl: snap.currentUrl,
				ready: snap.ready,
				notice: shared.getNotice ? shared.getNotice() : null,
				agentStatus: shared.getAgentStatus ? shared.getAgentStatus() : 'idle',
				recommendation: {
					ready: Boolean(poolState?.ready),
					count: Number(poolState?.count ?? poolState?.items?.length) || 0,
					generating: Boolean(schedulerState?.generating || schedulerState?.scheduled),
					lastError: schedulerState?.lastError ?? null
				},
				queue: snap.queue
			};
		},

		/** alger_say：让宠物开口说一句话（气泡提示约 6 秒） */
		async say(args) {
			const text = String(args?.text ?? '').trim();
			if (!text) throw new Error('请提供要说的台词 text（50 字以内）。');
			shared.setNotice(text);
			return { ok: true, text };
		},

		/** 按钮/明确工具请求的快速推荐：只消费后台准备好的推荐池。 */
		async recommend(_args) {
			if (!(await apiUp())) return { ok: false, guidance: '音乐服务尚未就绪，当前播放和队列保持不变。' };
			if (!pool) return { ok: false, preparing: true, guidance: '推荐池尚未初始化，请稍后再试。' };
			const consumed = await pool.consume(30);
			if (!consumed.ok) {
				scheduler?.schedule('cold-start', { urgent: true });
				return { ok: false, preparing: true, count: 0, remaining: consumed.remaining, guidance: '推荐正在准备中，请稍后再试。' };
			}
			try {
				player.insertRecommendationAfterCurrent(consumed.tracks, 'button-recommendation', {
					playFirst: true,
					replaceUnplayed: false
				});
				const hit = await urlFor(player.current());
				player.state.currentUrl = hit ? hit.url : null;
				if (!hit) player.state.playing = false;
				await pool.commit(consumed.transaction);
			} catch (error) {
				await pool.restore(consumed.transaction).catch(() => {});
				throw error;
			}
			if (consumed.remaining <= 30) scheduler?.schedule('low-watermark', { urgent: true });
			return {
				ok: true,
				insertMode: 'after-current-and-play',
				count: consumed.tracks.length,
				tracks: consumed.tracks,
				remaining: consumed.remaining
			};
		},

		/** alger_setup：内置音乐服务管理 */
		async setup(args) {
			const action = String(args?.action ?? 'check');
			const steps = [];
			const log = (s) => steps.push(String(s));
			const musicApiUp = await apiUp();
			if (action === 'check') {
				log(`音乐服务 ${cfg.musicApiPort}: ${musicApiUp ? '在线' : '离线'}`);
				return { ok: musicApiUp, steps, musicApiUp };
			}
			if (action === 'stop') {
				if (apiHandle && apiHandle.handle) {
					log('正在停止音乐服务…');
					await stopApiServer(apiHandle.handle);
					apiHandle.handle = null;
					apiHandle.isUp = false;
				}
				log('音乐服务已停止（搜索/播放将不可用，可用 alger_setup action=start 重新启动）');
				return { ok: true, steps, musicApiUp: false };
			}
			// start（默认）
			if (musicApiUp) {
				log(`音乐服务已在运行（${cfg.musicApiPort}），无需启动`);
				return { ok: true, steps, musicApiUp: true };
			}
			if (!apiHandle || !apiHandle.handle) {
				log(`正在启动音乐服务（${cfg.musicApiHost}:${cfg.musicApiPort}）…`);
				const result = startApiServer({
					spawn: (spec) => apiHandle.spawn(spec),
					serverEntryPath: apiHandle.serverEntryPath,
					port: cfg.musicApiPort,
					host: cfg.musicApiHost
				});
				if (!result.ok) return { ok: false, steps: [...steps, result.error || '启动失败'], guidance: '请检查端口占用或插件依赖是否安装完整。' };
				apiHandle.handle = result.handle;
			}
			try {
				await client.waitUntil(() => client.musicApiUp(), '音乐服务就绪', cfg.timeoutMs, 500);
				log(`音乐服务就绪（${cfg.musicApiPort}）`);
				return { ok: true, steps, musicApiUp: true };
			} catch (error) {
				return { ok: false, steps: [...steps, `音乐服务启动超时: ${error.message}`], guidance: '端口可能被占用，可在配置中调整 musicApiPort 后重试。' };
			}
		},

		/** alger_search */
		async search(args) {
			const keywords = String(args?.keywords ?? '').trim();
			if (!keywords) throw new Error('请提供搜索关键词 keywords。');
			const type = Number(args?.type) || 1;
			const limit = Math.min(50, Math.max(1, Number(args?.limit) || 10));
			const result = await client.search(keywords, type, limit);
			let items = [];
			let guidance;
			if (type === 1) {
				items = (result.songs || []).map((s) => compactSong(s));
				const requested = splitKeyword(keywords);
				if (requested.artist) {
					const title = normalize(requested.name);
					const artist = normalize(requested.artist);
					items = items.filter((item) => {
						const exactTitle = normalize(item.name) === title;
						const artistNames = String(item.artists || '').split(/[\/，,、;&；]+/).map(normalize).filter(Boolean);
						return exactTitle && artistNames.includes(artist);
					});
					if (items.length === 0) {
						guidance = `没有找到歌手和歌名都完全匹配「${requested.artist} - ${requested.name}」的可靠原唱。`;
					}
				}
			} else if (type === 10) {
				items = (result.albums || []).map((a) => ({
					id: a.id,
					name: a.name,
					desc: `${a.artist?.name || ''} ${a.company || ''} ${a.publishTime || ''}`.trim()
				}));
			} else if (type === 1000) {
				items = (result.playlists || []).map((p) => ({
					id: p.id,
					name: p.name,
					desc: `${p.creator?.nickname || ''}（${p.playCount ?? 0} 播放）`
				}));
			} else if (type === 1004) {
				items = (result.artists || []).map((a) => ({ id: a.id, name: a.name, desc: `${a.albumSize ?? 0} 张专辑` }));
			} else {
				items = (result.mvs || []).map((m) => ({
					id: m.id,
					name: m.name,
					desc: (m.artists || []).map((x) => x.name).join('/')
				}));
			}
			return { ok: true, keyword: keywords, type, total: items.length, items, ...(guidance ? { guidance } : {}) };
		},

		/** 浏览器收藏面板：只暴露一个扁平收藏列表，不承担目录或整理功能。 */
		async favoritesList() {
			const songs = player.state.favorites.map(compactSong);
			return { ok: true, count: songs.length, songs };
		},

		/** 从扁平收藏列表取消一首收藏，不影响当前播放上下文。 */
		async favoritesRemove(args) {
			const songId = Number(args?.songId);
			if (!Number.isFinite(songId)) throw new Error('请提供有效的歌曲 id。');
			const result = player.removeFavorite(songId);
			if (result.removed) await feedback('unfavorite', result.removed);
			const songs = player.state.favorites.map(compactSong);
			return { ok: true, removedId: result.removed ? Number(result.removed.id) : null, count: songs.length, songs };
		},

		/** alger_song */
		async song(args) {
			const id = Number(args?.id);
			if (!Number.isFinite(id)) throw new Error('请提供有效的歌曲 id。');
			const detail = await client.songDetail(id);
			if (!detail) throw new Error(`未找到歌曲 id=${id}（详情接口无返回）。`);
			const [lyricText, hit] = await Promise.all([
				client.lyric(id).catch(() => null),
				urlFor(detail)
			]);
			return { ...compactSong(detail), lyric: lyricText, url: hit ? hit.url : null };
		},

		/** 轻量歌词（浮动窗口歌词气泡用，只取 LRC 文本） */
		async lyric(args) {
			const id = Number(args?.id);
			if (!Number.isFinite(id)) throw new Error('请提供有效的歌曲 id。');
			const text = await client.lyric(id);
			return { ok: true, id, lyric: text || null };
		},

		/** 艺术家头像（浮动窗口宠物形象用） */
		async artist(args) {
			const id = Number(args?.id);
			if (!Number.isFinite(id)) throw new Error('请提供有效的艺术家 id。');
			let avatar = null;
			let name = '';
			try {
				const data = await client.getJson(`${client.apiBase}/artist/detail?id=${id}`);
				const a = data?.data?.artist;
				if (a) {
					name = a.name || '';
					avatar = a.avatar || a.img1v1Url || a.cover || a.picUrl || null;
				}
			} catch {
				/* 降级到搜索 */
			}
			if (!avatar) {
				try {
					const r = await client.search(name, 1004, 3);
					const match = (r.artists || []).find((a) => Number(a.id) === Number(id)) || (r.artists || [])[0];
					if (match) avatar = match.img1v1Url || match.picUrl || null;
				} catch {
					/* 忽略 */
				}
			}
			return { ok: true, id, name, avatar };
		},

		/** alger_playlist */
		async playlist(args) {
			const id = Number(args?.id);
			if (!Number.isFinite(id)) throw new Error('请提供有效的歌单 id。');
			const limit = Math.min(500, Math.max(1, Number(args?.limit) || 100));
			const pl = await client.playlist(id, limit);
			if (!pl) throw new Error(`未找到歌单 id=${id}。`);
			const tracks = (pl.tracks || []).map((t) => compactSong(t));
			return { ok: true, id, name: pl.name, trackCount: pl.trackCount ?? tracks.length, tracks };
		},

		/** 取歌曲直链（浮动窗口 <audio> 播放用） */
		async songUrl(args) {
			const id = Number(args?.id);
			if (!Number.isFinite(id)) throw new Error('请提供有效的歌曲 id。');
			const url = await client.songUrl(id, 'higher');
			return { ok: true, id, url: url || null };
		},

		/** 播放进度上报（浮动窗口 <audio> 定时上报） */
		async playback(args) {
			const value = asRecord(args);
			player.reportPlayback({
				position: Number(value.position) || 0,
				duration: Number(value.duration) || 0,
				playing: Boolean(value.playing),
				ready: Boolean(value.ready)
			});
			// 听歌记忆：累计实际收听（纯本地；失败静默，不影响播放）
			try {
				const song = player.state.queue[player.state.index] || null;
				if (song && song.id) {
					habits.recordPlayback({
						song: {
							id: song.id,
							name: song.name,
							artists: ((song.ar || song.artists || []).map((a) => a && a.name).filter(Boolean)).join('/'),
							album: song.al ? song.al.name : (song.album || '')
						},
						position: Number(value.position) || 0,
						duration: Number(value.duration) || 0,
						playing: Boolean(player.state.playing)
					}).catch(() => {});
				}
			} catch {
				/* 忽略 */
			}
			return { ok: true };
		},

		/** alger_play：点歌播放（内置播放引擎，浏览器 <audio> 出声） */
		async play(args) {
			const keyword = String(args?.keyword ?? '').trim();
			const songId = Number(args?.songId);
			const steps = [];
			const log = (s) => steps.push(String(s));

			// 1) 确定目标歌曲
			let song = null;
			if (Number.isFinite(songId) && songId > 0) {
				song = await client.songDetail(songId);
				if (!song)
					return { ok: false, steps: [...steps, `未找到歌曲 id=${songId}`], guidance: '检查 id 是否来自 alger_search。' };
				log(`目标歌曲: [${song.id}] ${song.name}`);
			} else if (keyword) {
				const result = await client.search(keyword, 1, 8);
				const songs = result.songs || [];
				if (songs.length === 0)
					return { ok: false, steps: [...steps, `搜索「${keyword}」无结果`], guidance: '换个关键词试试。' };
				const nk = normalize(keyword);
				const parts = splitKeyword(keyword);
				const nameHit = (s) => normalize(s.name).includes(nk) || nk.includes(normalize(s.name));
				const artistHit = (s) => {
					if (!parts.artist) return true; // 无歌手要求则视为命中
					const names = ((s.ar || s.artists) || []).map((a) => a && a.name).filter(Boolean);
					return names.some((n) => n.includes(parts.artist) || parts.artist.includes(n));
				};
				// 选歌优先级：歌名+歌手都命中 > 歌名命中 > 歌手命中 > 第一条
				// （避免「周杰伦 双截棍」选中歌名不符的刀马旦，或歌手不符的华晨宇翻唱）
				song = songs.find((s) => nameHit(s) && artistHit(s))
					|| songs.find((s) => nameHit(s))
					|| songs.find((s) => artistHit(s))
					|| songs[0];
				log(
					`搜索「${keyword}」命中 ${songs.length} 首，选中: [${song.id}] ${song.name} - ${(song.ar || [])
						.map((a) => a.name)
						.join('/')}`
				);
			} else {
				throw new Error('请提供 keyword 或 songId（二选一）。');
			}

			// 2) 确认可播放（只接受主音乐 API 对当前歌曲返回的直链）
			const hit = await urlFor(song, keyword);
			if (!hit) {
				return {
					ok: false,
					steps: [...steps, `「${song.name}」暂无可用播放地址`],
					guidance: '部分歌曲因版权限制无法直接播放，换一首试试。'
				};
			}
			const url = hit.url;

			// 3) 写入播放状态（客户端轮询到 currentUrl 后自动播放）
			player.playSong(song);
			player.state.currentUrl = url;
			await feedback('search-play', song);
			shared.setNotice('♪ 已播放：' + song.name);
			return { ok: true, steps, playedName: song.name, playedId: song.id, confirmed: true };
		},

		/** alger_queue：播放列表操作（追加 / 插入下一首 / 整单播放 / 跳转 / 清空） */
		async queue(args) {
			const action = String(args?.action ?? '');
			if (!['add', 'add-all', 'add-next', 'playlist', 'playlist-add', 'jump', 'clear', 'favorites', 'remove', 'undo-remove'].includes(action))
				throw new Error('action 需为 add / add-all / add-next / playlist / playlist-add / jump / clear / favorites / remove / undo-remove。');
			const steps = [];
			const log = (s) => steps.push(String(s));

			if (action === 'remove') {
				const result = player.removeQueueAt(args?.index);
				if (result.currentChanged && result.current) {
					const hit = await urlFor(result.current);
					player.state.currentUrl = hit ? hit.url : null;
					if (!hit) player.state.playing = false;
				}
				return {
					ok: true,
					mode: 'remove',
					removed: compactSong(result.removed),
					token: result.token,
					currentChanged: result.currentChanged,
					queueLength: result.queueLength,
					playing: result.current ? compactSong(result.current) : null
				};
			}
			if (action === 'undo-remove') {
				const result = player.undoQueueRemoval(args?.token);
				return {
					ok: true,
					mode: 'undo-remove',
					restored: compactSong(result.restored),
					queueLength: result.queueLength
				};
			}

			// 清空播放列表
			if (action === 'clear') {
				player.clearQueue();
				log('播放列表已清空');
				return { ok: true, steps, mode: 'clear', queueLength: 0 };
			}

			// 播放收藏列表：整单替换队列并播放第一首
			if (action === 'favorites') {
				const requestedIndex = args?.favoriteIndex === undefined ? 0 : Number(args.favoriteIndex);
				if (!Number.isInteger(requestedIndex) || requestedIndex < 0 || requestedIndex >= player.state.favorites.length) {
					if (player.state.favorites.length > 0) throw new Error('favoriteIndex 需要是收藏列表内有效的 0 起整数。');
				}
				const fv = player.playFavorites(requestedIndex);
				if (!fv.song) {
					return { ok: false, steps: [...steps, '收藏列表为空'], guidance: '先点心形按钮收藏几首歌，再回来点“收藏”播放。' };
				}
				log(`收藏列表 ${fv.count} 首，从「${fv.song.name}」开始播放`);
				const hit = await urlFor(fv.song);
				player.state.currentUrl = hit ? hit.url : null;
				player.state.playing = true;
				return { ok: true, steps, mode: 'favorites', added: fv.count, queueLength: player.state.queue.length, playedName: fv.song.name };
			}

			// 1) 解析歌曲/歌单数据
			let songs = [];
			let mode = 'append';
			if (action === 'playlist' || action === 'playlist-add') {
				const pid = Number(args?.playlistId);
				if (!Number.isFinite(pid)) throw new Error('播放/加入歌单需要 playlistId（来自 alger_search type=1000）。');
				const pl = await client.playlist(pid, 500);
				if (!pl) return { ok: false, steps: [...steps, `未找到歌单 id=${pid}`], guidance: '检查歌单 id 是否来自 alger_search type=1000。' };
				songs = pl.tracks || [];
				mode = action === 'playlist' ? 'replace' : 'append';
				log(`歌单「${pl.name}」共 ${pl.trackCount ?? songs.length} 首，取得 ${songs.length} 首`);
				if (songs.length === 0) return { ok: false, steps, guidance: '歌单里没有可播放的歌曲。' };
			} else if (action === 'add' || action === 'add-next') {
				const songId = Number(args?.songId);
				const keyword = String(args?.keyword ?? '').trim();
				if (Number.isFinite(songId) && songId > 0) {
					const song = await client.songDetail(songId);
					if (!song) return { ok: false, steps: [...steps, `未找到歌曲 id=${songId}`], guidance: '检查 id 是否来自 alger_search。' };
					songs = [song];
					log(`目标歌曲: [${song.id}] ${song.name}`);
				} else if (keyword) {
					const r = await client.search(keyword, 1, 8);
					const list = r.songs || [];
					if (list.length === 0) return { ok: false, steps: [...steps, `搜索「${keyword}」无结果`], guidance: '换个关键词试试。' };
					const parts = splitKeyword(keyword);
					const wantedName = normalize(parts.name || keyword);
					const artistMatches = (candidate) => !parts.artist || ((candidate.ar || candidate.artists) || [])
						.some((artist) => normalize(artist?.name).includes(normalize(parts.artist)) || normalize(parts.artist).includes(normalize(artist?.name)));
					let song = list.find((candidate) => normalize(candidate.name) === wantedName && artistMatches(candidate))
						|| list.find((candidate) => normalize(candidate.name) === wantedName)
						|| list[0];
					const hit = await urlFor(song, keyword);
					if (!hit) return { ok: false, steps: [...steps, `「${song.name}」暂无可用播放地址`], guidance: '换一首试试。' };
					if (hit.matchTitle) {
						song = {
							...song,
							name: hit.matchTitle,
							ar: hit.matchArtist ? [{ id: 0, name: hit.matchArtist }] : (song.ar || []),
							artists: hit.matchArtist ? [{ id: 0, name: hit.matchArtist }] : (song.artists || [])
						};
					}
					songs = [{ ...song, resolvedUrl: hit.url }];
					log(`搜索「${keyword}」选中: [${song.id}] ${song.name} - ${(song.ar || []).map((a) => a.name).join('/')}`);
				} else {
					throw new Error('add / add-next 需要 songId 或 keyword。');
				}
				if (action === 'add-next') mode = 'next';
			} else if (action === 'jump') {
				const idx = Number(args?.index);
				if (!Number.isInteger(idx) || idx < 0) throw new Error('jump 需要有效的 index（0 起的整数）。');
				if (idx >= player.state.queue.length) throw new Error(`队列下标越界: ${idx}（队列共 ${player.state.queue.length} 首）`);
				const song = player.jump(idx);
				const hit = await urlFor(song);
				if (!hit) return { ok: false, steps: [...steps, `「${song.name}」暂无可用播放地址`], guidance: '换一首试试。' };
				player.state.currentUrl = hit.url;
				player.state.playing = true;
				return { ok: true, steps, mode: 'jump', playedName: song ? song.name : '', queueLength: player.state.queue.length };
			} else {
				// add-all：整批搜索结果加入
				const keyword = String(args?.keyword ?? '').trim();
				if (!keyword) throw new Error('add-all 需要 keyword。');
				const limit = Math.min(50, Math.max(1, Number(args?.limit) || 20));
				const r = await client.search(keyword, 1, limit);
				songs = r.songs || [];
				log(`搜索「${keyword}」命中 ${songs.length} 首（limit=${limit}）`);
				if (songs.length === 0) return { ok: false, steps, guidance: '换个关键词试试。' };
			}

			// 2) 操作播放状态
			if (mode === 'replace') {
				const song = player.replaceAndPlay(songs);
				const hit = await urlFor(song);
				player.state.currentUrl = hit ? hit.url : null;
				player.state.playing = true;
				shared.setNotice('♫ 整单播放：' + (song ? song.name : '') + '（' + songs.length + ' 首）');
				return { ok: true, steps, mode, added: songs.length, queueLength: player.state.queue.length, playedName: song ? song.name : null };
			}
			if (mode === 'next') {
				const n = player.insertNext(songs);
				shared.setNotice('＋ 已插入下一首播放 ' + songs.length + ' 首');
				return { ok: true, steps, mode, added: songs.length, queueLength: n };
			}
			const n = player.append(songs);
			shared.setNotice('＋ 已加入播放列表 ' + songs.length + ' 首');
			return { ok: true, steps, mode, added: songs.length, queueLength: n, playedName: null };
		},

		/** alger_control：播放控制（内置状态机） */
		async control(args) {
			const action = String(args?.action ?? '');
			if (!action)
				throw new Error(
					'请提供 action（toggle-play / play / pause / next / prev / volume-up / volume-down / toggle-favorite / playmode）。'
				);
			if (action === 'toggle-play' || action === 'play' || action === 'pause') {
				const wantPlay = action === 'play' ? true : action === 'pause' ? false : !player.state.playing;
				if (player.state.playing === wantPlay) {
					return { action, message: `当前已是${wantPlay ? '播放' : '暂停'}状态，无需操作` };
				}
				player.state.playing = wantPlay;
				return { action, message: wantPlay ? '已播放' : '已暂停', playing: player.state.playing };
			}
			if (action === 'next' || action === 'prev') {
				const leaving = player.current();
				if (action === 'next' && leaving) {
					if (player.state.position > 0 && player.state.position < 20) await feedback('skip-short', leaving);
					else if (player.state.duration > 0 && player.state.position / player.state.duration >= 0.8) await feedback('complete-80', leaving);
				}
				const song = action === 'next' ? player.next() : player.prev();
				if (!song) throw new Error('队列为空，无法切换。');
				const hit = await urlFor(song);
				if (!hit) throw new Error(`「${song.name}」暂无可用播放地址。`);
				player.state.currentUrl = hit.url;
				player.state.playing = true;
				return { action, message: '已切到：' + song.name, song: song.name, playing: true };
			}
			if (action === 'volume-up' || action === 'volume-down') {
				const v = action === 'volume-up' ? player.volumeUp() : player.volumeDown();
				return { action, message: '音量：' + Math.round(v * 100) + '%', volume: v };
			}
			if (action === 'toggle-favorite') {
				const r = player.toggleFavorite();
				await feedback(r.favorite ? 'favorite' : 'unfavorite', player.current());
				return { action, message: r.favorite ? '已收藏' : '已取消收藏', favorite: r.favorite };
			}
			if (action === 'playmode') {
				const m = player.togglePlayMode();
				return { action, message: '已切换播放模式', playMode: m };
			}
			throw new Error('不支持的 action: ' + action);
		},

		/** 仅供明确的长期偏好指令使用；普通对话不会自动写入。 */
		async preference(args) {
			if (!preference) throw new Error('偏好档案未初始化');
			const value = asRecord(args);
			const result = await preference(value);
			if (String(value.action || 'summary') !== 'summary') scheduler?.schedule('preference');
			return result;
		},

		/** alger_habits：听歌记忆（查看/清空本地播放习惯，纯本地不上传） */
		async habits(args) {
			const action = String(args?.action ?? 'summary');
			if (action === 'clear') {
				await habits.clear();
				return { ok: true, cleared: true };
			}
			const s = await habits.summary();
			return { ok: true, ...s };
		},

		/** 单曲常听判定（宠物互动：重播常听歌曲时开口） */
		async songCheck(args) {
			const id = Number(args?.songId);
			if (!id) return { ok: false, error: '缺少 songId。' };
			return { ok: true, ...(await habits.songCheck(id)) };
		},

		/** 深夜提醒判定（当日深夜累计 ≥2h 且 24h 内未提醒 → 触发宠物提醒） */
		async nightCheck() {
			const r = await habits.nightCheck();
			if (r.remind) shared.setNotice('🌙 夜深了，早点休息～月宝儿先退下啦', 8000);
			return { ok: true, ...r };
		},

		/** alger_similar：基于当前歌曲找相似歌曲（相似推荐失败回退歌手热门曲） */
		async similar(args) {
			const steps = [];
			const log = (s) => steps.push(String(s));
			const cur = player.state.queue[player.state.index] || null;
			const songId = Number(args?.songId) || (cur && cur.id) || null;
			if (!songId) {
				return { ok: false, steps: [...steps, '当前没有播放歌曲'], guidance: '请先播放一首歌，或提供 songId。' };
			}
			const limit = Math.max(1, Math.min(20, Number(args?.limit) || 8));
			const curName = cur ? cur.name : '';
			let songs = [];
			// 1) 相似歌曲推荐
			try {
				const data = await client.getJson(`${client.apiBase}/simi/song?id=${songId}&limit=${limit}`);
				songs = (data?.songs || []).filter((s) => s && s.id && s.name);
			} catch {
				/* 回退歌手热门 */
			}
			// 2) 回退：当前歌曲的歌手热门曲（排除当前歌曲）
			if (songs.length === 0) {
				const artist = (cur && (cur.ar || cur.artists || [])[0]) || null;
				if (artist && artist.id) {
					try {
						const data = await client.getJson(`${client.apiBase}/artist/top?id=${artist.id}`);
						songs = (data?.songs || []).filter((s) => s && s.id && s.name && Number(s.id) !== Number(songId));
					} catch {
						/* 忽略 */
					}
					if (songs.length > 0) log('相似推荐不可用，已回退到「' + (artist.name || '该歌手') + '」的热门曲');
				}
			}
			if (songs.length === 0) {
				return { ok: false, steps: [...steps, '未找到相似歌曲'], guidance: '换一首歌再试。' };
			}
			// 排除队列中已有的，避免重复
			const existing = new Set(player.state.queue.map((s) => String(s.id)));
			songs = songs.filter((s) => !existing.has(String(s.id))).slice(0, limit);
			if (songs.length === 0) {
				return { ok: false, steps: [...steps, '相似的歌曲都已经在播放列表里了'], guidance: '直接听就好～' };
			}
			player.append(songs);
			const view = songs.map((s) => ({
				id: s.id,
				name: s.name,
				artists: (s.ar || s.artists || []).map((a) => a && a.name).filter(Boolean).join(' / ')
			}));
			log(`基于「${curName}」找到 ${songs.length} 首相似歌曲，已加入播放列表（不打断当前播放）`);
			return { ok: true, steps, baseSong: curName, added: songs.length, songs: view };
		}
	};
}

export const buildActionsForTest = buildActions;


/**
 * 构造面向模型的工具（复用 buildActions）。
 */
/**
 * 模型可见的工具结果渲染：必须返回内容块数组 [{type:'text',text}]。
 * 宿主 LLM 适配器（如 DeepSeek chat-completions）只认内容块；纯字符串数组
 * 会被 flattenText 展平为空，模型将收到 "(no output)"。
 */
function textBlock(lines) {
	return [{ type: 'text', text: (Array.isArray(lines) ? lines : [lines]).join('\n') }];
}

function buildTools(cfg, actions) {
	const status = {
		name: 'alger_status',
		description:
			'检查内置音乐播放器状态：音乐服务是否在线（端口 ' + cfg.musicApiPort + '）、当前播放的歌曲、播放/暂停、进度、收藏与播放模式。无副作用。',
		parameters: compileParameters({}),
		output: {
			schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				const lines = [];
				lines.push(`音乐服务 ${cfg.musicApiPort}: ${rec.musicApiUp ? '在线' : '离线'}`);
				if (rec.playing) {
					const song = rec.playing.song;
					lines.push(
						`正在${rec.playing.isPlaying ? '播放' : '暂停'}: ${song?.name || ''}${song?.artists ? ' - ' + song.artists : ''}`
					);
					if (rec.playback && rec.playback.duration) {
						lines.push(
							`进度: ${fmtDuration(rec.playback.position * 1000)} / ${fmtDuration(rec.playback.duration * 1000)}`
						);
					}
				} else {
					lines.push('当前无播放内容');
				}
				if (rec.queue && Array.isArray(rec.queue.items)) lines.push(`播放列表: ${rec.queue.items.length} 首（当前第 ${(rec.queue.index ?? -1) + 1} 首）`);
				if (typeof rec.playMode === 'number') lines.push(`播放模式: ${['列表循环', '单曲循环', '随机'][rec.playMode] || rec.playMode}`);
				if (rec.favorite) lines.push('当前歌曲已收藏');
				if (!rec.musicApiUp) lines.push('提示: 音乐服务未在线，可调用 alger_setup action=start 启动。');
				return textBlock(lines);
			}
		},
		execute: () => actions.status(),
		timeoutMs: cfg.timeoutMs
	};

	const setup = {
		name: 'alger_setup',
		description:
			'管理插件内置的音乐服务（开源网易云音乐 API，端口 ' + cfg.musicApiPort + '，仅本机回环）：action=check 只检查；action=start 启动（默认）；action=stop 停止。插件加载时服务会自动启动，一般无需手动调用。',
		parameters: compileParameters({
			action: {
				type: 'string',
				enum: ['check', 'start', 'stop'],
				required: true,
				description: '操作：check=仅检查；start=启动音乐服务；stop=停止音乐服务。'
			}
		}),
		output: {
			schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				const lines = (rec.steps || []).map((s) => '· ' + s);
				lines.push(`音乐服务: ${rec.musicApiUp ? '在线' : '离线'}`);
				if (!rec.ok) lines.push('未能就绪，请按提示处理。');
				return textBlock(lines);
			}
		},
		execute: (rawArgs) => actions.setup(asRecord(rawArgs)),
		timeoutMs: Math.max(cfg.timeoutMs, 45000)
	};

	const search = {
		name: 'alger_search',
		description:
			'用插件内置的开源音乐 API 服务（127.0.0.1:' + cfg.musicApiPort + '）搜索。type=1 歌曲 / 10 专辑 / 1000 歌单 / 1004 歌手 / 1009 MV。返回紧凑列表（含歌曲 id），供 alger_play 点歌。',
		parameters: compileParameters({
			keywords: { type: 'string', required: true, description: '搜索关键词（歌名 / 歌手 / 歌单名）。' },
			type: { type: 'integer', description: '搜索类型：1=歌曲(默认)，10=专辑，1000=歌单，1004=歌手，1009=MV。' },
			limit: { type: 'integer', description: '返回条数，默认 10，最大 50。' }
		}),
		output: {
			schema: { type: 'object', properties: { keyword: { type: 'string' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				const lines = [`搜索「${rec.keyword}」（type=${rec.type}）共 ${rec.total ?? 0} 条，返回 ${(rec.items || []).length} 条：`];
				(rec.items || []).forEach((item, i) => {
					if (rec.type === 1) {
						lines.push(
							`${i + 1}. [${item.id}] ${item.name} - ${item.artists}（${item.album}${item.durationMs ? '，' + fmtDuration(item.durationMs) : ''}）`
						);
					} else {
						lines.push(`${i + 1}. [${item.id}] ${item.name}${item.desc ? ' - ' + item.desc : ''}`);
					}
				});
				if (!rec.items?.length) lines.push('（无结果）');
				lines.push('提示: 想播放某一首，用 alger_play songId=<id> 或 keyword=<歌名>。');
				return textBlock(lines);
			}
		},
		execute: (rawArgs) => actions.search(asRecord(rawArgs)),
		timeoutMs: cfg.timeoutMs
	};

	const song = {
		name: 'alger_song',
		description:
			'获取单曲详情：歌曲信息、歌词、可播放直链（部分歌曲因版权限制没有可用直链）。',
		parameters: compileParameters({
			id: { type: 'integer', required: true, description: '歌曲 id（来自 alger_search 结果）。' }
		}),
		output: {
			schema: { type: 'object', properties: { id: { type: 'integer' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				const lines = [`[${rec.id}] ${rec.name}`];
				if (rec.artists) lines.push('歌手: ' + rec.artists);
				if (rec.album) lines.push('专辑: ' + rec.album);
				if (rec.durationMs) lines.push('时长: ' + fmtDuration(rec.durationMs));
				lines.push(`直链: ${rec.url ? '可用（可播放）' : '无（版权限制）'}`);
				if (rec.lyric) lines.push('歌词: 有（' + rec.lyric.split('\n').length + ' 行）');
				return textBlock(lines);
			}
		},
		execute: (rawArgs) => actions.song(asRecord(rawArgs)),
		timeoutMs: cfg.timeoutMs
	};

	const playlist = {
		name: 'alger_playlist',
		description:
			'获取歌单详情与歌曲列表（通过插件内置的开源音乐 API，歌单 id 来自 alger_search type=1000 或分享链接的数字部分）。',
		parameters: compileParameters({
			id: { type: 'integer', required: true, description: '歌单 id（来自 alger_search type=1000 或分享链接的数字部分）。' },
			limit: { type: 'integer', description: '最多返回多少首，默认 100，最大 500。' }
		}),
		output: {
			schema: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				const lines = [`歌单「${rec.name}」（id=${rec.id}，共 ${rec.trackCount ?? 0} 首，返回 ${(rec.tracks || []).length} 首）：`];
				(rec.tracks || []).slice(0, 20).forEach((t, i) => {
					lines.push(`${i + 1}. [${t.id}] ${t.name} - ${t.artists}`);
				});
				if ((rec.tracks || []).length > 20) lines.push(`…（还有 ${(rec.tracks || []).length - 20} 首）`);
				return textBlock(lines);
			}
		},
		execute: (rawArgs) => actions.playlist(asRecord(rawArgs)),
		timeoutMs: cfg.timeoutMs
	};

	const play = {
		name: 'alger_play',
		description:
			'点歌：立即播放指定歌曲（浏览器内置 <audio> 引擎出声，替换当前播放队列为单曲）。给 songId 播指定单曲；只给 keyword 则搜索并播最佳匹配。',
		parameters: compileParameters({
			keyword: { type: 'string', description: '歌名/歌手关键词（与 songId 二选一）。' },
			songId: { type: 'integer', description: '歌曲 id（来自 alger_search，优先于 keyword）。' }
		}),
		output: {
			schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				const lines = (rec.steps || []).map((s) => '· ' + s);
				if (rec.ok) lines.push('♪ 已播放：' + (rec.playedName || ''));
				if (rec.guidance) lines.push('提示: ' + rec.guidance);
				return textBlock(lines);
			}
		},
		execute: (rawArgs) => actions.play(asRecord(rawArgs)),
		timeoutMs: cfg.timeoutMs
	};

	const queue = {
		name: 'alger_queue',
		description:
			'播放列表操作：action=add 把指定歌曲（songId 或 keyword 最佳匹配）追加到播放列表末尾；action=add-all 把某关键词的全部搜索结果（limit 控制数量）一键加入播放列表；action=add-next 插入到当前歌曲之后；action=playlist 按 playlistId 整单播放歌单（替换队列并立即播放第一首）；action=playlist-add 把歌单全部歌曲追加到播放列表末尾（不播放）；action=jump 按 index 跳转播放队列中指定位置的歌曲（队列不变）；action=clear 清空播放列表；action=favorites 播放收藏列表（整单替换队列并立即播放第一首）。',
		parameters: compileParameters({
			action: {
				type: 'string',
				enum: ['add', 'add-all', 'add-next', 'playlist', 'playlist-add', 'jump', 'clear', 'favorites'],
				required: true,
				description: '操作：add=追加单曲；add-all=整批搜索结果加入；add-next=插入下一首；playlist=整单播放歌单；playlist-add=歌单整单追加到播放列表；jump=按 index 跳转播放；clear=清空播放列表。'
			},
			songId: { type: 'integer', description: '歌曲 id（add/add-next 用，与 keyword 二选一）。' },
			keyword: { type: 'string', description: '歌名/歌手关键词（add/add-next/add-all 用）。' },
			playlistId: { type: 'integer', description: '歌单 id（playlist/playlist-add 用，来自 alger_search type=1000）。' },
			index: { type: 'integer', description: '队列下标 0 起（jump 用）。' },
			limit: { type: 'integer', description: 'add-all 时最多加入多少首，默认 20，最大 50。' }
		}),
		output: {
			schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				const lines = (rec.steps || []).map((s) => '· ' + s);
				if (rec.ok) lines.push(`队列: ${rec.queueLength ?? '?'} 首（本次${rec.added ?? 0} 首，${rec.mode || 'append'}）`);
				if (rec.playedName) lines.push('♪ 开始播放：' + rec.playedName);
				if (rec.guidance) lines.push('提示: ' + rec.guidance);
				return textBlock(lines);
			}
		},
		execute: (rawArgs) => actions.queue(asRecord(rawArgs)),
		timeoutMs: cfg.timeoutMs
	};

	const control = {
		name: 'alger_control',
		description:
			'播放控制：toggle-play 播放/暂停切换、play 播放、pause 暂停、next 下一首、prev 上一首、volume-up 音量加、volume-down 音量减、toggle-favorite 收藏/取消收藏当前歌曲、playmode 切换播放模式（0=列表循环/1=单曲循环/2=随机）。',
		parameters: compileParameters({
			action: {
				type: 'string',
				enum: ['toggle-play', 'play', 'pause', 'next', 'prev', 'volume-up', 'volume-down', 'toggle-favorite', 'playmode'],
				required: true,
				description: '要执行的控制动作。'
			}
		}),
		output: {
			schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				const lines = [];
				if (rec.message) lines.push(rec.message);
				if (typeof rec.playing === 'boolean') lines.push(rec.playing ? '▶ 播放中' : '⏸ 已暂停');
				if (rec.song) lines.push('当前: ' + rec.song);
				if (typeof rec.playMode === 'number') lines.push(`播放模式: ${['列表循环', '单曲循环', '随机'][rec.playMode] || rec.playMode}`);
				return textBlock(lines);
			}
		},
		execute: (rawArgs) => actions.control(asRecord(rawArgs)),
		timeoutMs: cfg.timeoutMs
	};

	const say = {
		name: 'alger_say',
		description:
			'让右下角的音乐宠物开口说一句话（宠物气泡提示约 6 秒），用于播报点歌/状态/鼓励等。台词要简短。',
		parameters: compileParameters({
			text: { type: 'string', required: true, description: '让宠物说的台词，50 字以内。' }
		}),
		output: {
			schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				return textBlock('宠物说：「' + (rec.text || '') + '」');
			}
		},
		execute: (rawArgs) => actions.say(asRecord(rawArgs)),
		timeoutMs: cfg.timeoutMs
	};

	const recommend = {
		name: 'alger_recommend',
		description:
			'仅在用户明确要求立即推荐、直接播放或“来一批歌”时调用。按钮式快速推荐会把完整一批歌曲加入播放列表，并从第一首推荐开始播放；如果用户只是在表达情绪、犹豫或闲聊，应先自然回应、提供情绪价值和想法，不要为了结构化而自动搜索或急着给结果。',
		parameters: compileParameters({}),
		output: {
			schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				const lines = [];
				if (rec.ok) lines.push('♫ 已加入 ' + ((rec.tracks || []).length || 0) + ' 首推荐，并开始播放本批第一首。');
				if (rec.guidance) lines.push('提示: ' + rec.guidance);
				return textBlock(lines);
			}
		},
		execute: (rawArgs) => actions.recommend(asRecord(rawArgs)),
		timeoutMs: Math.max(cfg.timeoutMs, 45000)
	};

	const preference = {
		name: 'alger_preference',
		description:
			'管理月宝儿的长期音乐偏好。只有用户明确说“以后”“记住”“不要再推荐”之类长期指令时，才使用 remember/forget；普通情绪表达和一次性点歌不要写入。summary 只读，clear 清空本地偏好。',
		parameters: compileParameters({
			action: { type: 'string', enum: ['summary', 'remember', 'forget', 'clear'], required: true, description: '偏好操作。' },
			kind: { type: 'string', enum: ['artist', 'track', 'language', 'style', 'energy'], description: 'remember 时必填。' },
			value: { type: 'string', description: 'remember 时必填的明确偏好值。' },
			weight: { type: 'number', description: '偏好强度 -1 到 1；-1 表示明确不要推荐。' },
			ruleId: { type: 'string', description: 'forget 时必填。' }
		}),
		output: {
			schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				if (rec.rule) return textBlock(`已记住：${rec.rule.kind} = ${rec.rule.value}`);
				if (rec.forgotten) return textBlock('已忘记这条偏好。');
				if (rec.cleared) return textBlock('已清空本地推荐偏好。');
				return textBlock('已读取本地推荐偏好。');
			}
		},
		execute: (rawArgs) => actions.preference(asRecord(rawArgs)),
		timeoutMs: cfg.timeoutMs
	};

	const habitsTool = {
		name: 'alger_habits',
		description:
			'查看或清空月宝儿的本地听歌记忆（纯本地，不上传）：summary 返回常听歌曲 Top、常听歌手、今日收听时长、近 7 天深夜活跃度；clear 一键清空全部记忆。用于回答「最近常听什么」「今天听了多久」等习惯类问题。',
		parameters: compileParameters({
			action: {
				type: 'string',
				enum: ['summary', 'clear'],
				required: true,
				description: 'summary=查看总结；clear=清空全部听歌记忆。'
			}
		}),
		output: {
			schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				if (rec.cleared) return textBlock('已清空全部听歌记忆。');
				const lines = [];
				lines.push(`记忆: ${rec.totalSongs || 0} 首歌，累计播放 ${fmtDuration((rec.totalSeconds || 0) * 1000)}，共 ${rec.totalPlays || 0} 次`);
				if (rec.todaySeconds) lines.push(`今日已听 ${fmtDuration(rec.todaySeconds * 1000)}`);
				if (rec.topSongs && rec.topSongs.length) {
					lines.push('常听歌曲:');
					rec.topSongs.slice(0, 5).forEach((s, i) => lines.push(`  ${i + 1}. ${s.name}${s.artists ? ' - ' + s.artists : ''}（${s.plays} 次 / ${fmtDuration(s.seconds * 1000)}）`));
				}
				if (rec.topArtists && rec.topArtists.length) {
					lines.push('常听歌手: ' + rec.topArtists.map((a) => `${a.name}（${fmtDuration(a.seconds * 1000)}）`).join('、'));
				}
				if (typeof rec.nightActive === 'boolean') lines.push(rec.nightActive ? '深夜活跃：近 7 天深夜常听' : '深夜不活跃');
				lines.push('隐私: 全部数据仅存本机，可随时用 alger_habits action=clear 清空。');
				return textBlock(lines);
			}
		},
		execute: (rawArgs) => actions.habits(asRecord(rawArgs)),
		timeoutMs: cfg.timeoutMs
	};

	const similar = {
		name: 'alger_similar',
		description:
			'找与当前播放歌曲相似的歌曲（网易云相似推荐，失败自动回退歌手热门曲），默认直接加入播放列表末尾继续播放，不打断当前歌曲。用于「来点类似的」「多来几首这种的」等口味延伸。',
		parameters: compileParameters({
			songId: { type: 'integer', description: '指定歌曲 id（默认当前播放的歌曲）。' },
			limit: { type: 'integer', description: '返回数量（1-20，默认 8）。' }
		}),
		output: {
			schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
			render: (_args, value) => {
				const rec = asRecord(value);
				const lines = (rec.steps || []).map((s) => '· ' + s);
				if (rec.songs && rec.songs.length) {
					lines.push('相似歌曲：');
					rec.songs.slice(0, 10).forEach((s, i) => lines.push(`  ${i + 1}. ${s.name}${s.artists ? ' - ' + s.artists : ''}`));
				}
				if (rec.guidance) lines.push('提示: ' + rec.guidance);
				return textBlock(lines);
			}
		},
		execute: (rawArgs) => actions.similar(asRecord(rawArgs)),
		timeoutMs: Math.max(cfg.timeoutMs, 30000)
	};

	return [status, setup, search, song, playlist, play, queue, control, say, recommend, preference, habitsTool, similar];
}

export const buildToolsForTest = buildTools;

/** 读取 POST body（JSON 文本）。 */
function readBody(req) {
	return new Promise((resolve, reject) => {
		let data = '';
		req.on('data', (chunk) => {
			data += chunk;
			if (data.length > 1e6) {
				req.destroy();
				reject(new Error('body too large'));
			}
		});
		req.on('end', () => resolve(data));
		req.on('error', reject);
	});
}

function json(res, body, status = 200) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	res.end(JSON.stringify(body));
}

/** 注册浏览器浮动窗口用的 Web 路由。 */
function registerRoutes(webServer, actions) {
	const routes = [
		{
			kind: 'exact',
			path: '/dsh-alger/state',
			handler: async (_req, res) => {
				try {
					json(res, await actions.status());
				} catch (error) {
					json(res, { ok: false, error: String((error && error.message) || error) });
				}
			}
		},
		{
			kind: 'exact',
			path: '/dsh-alger/command',
			handler: async (req, res) => {
				try {
					const body = JSON.parse((await readBody(req)) || '{}');
					json(res, await actions.control(body));
				} catch (error) {
					json(res, { ok: false, error: String((error && error.message) || error) });
				}
			}
		},
		{
			kind: 'exact',
			path: '/dsh-alger/say',
			handler: async (req, res) => {
				try {
					const body = JSON.parse((await readBody(req)) || '{}');
					json(res, await actions.say(body));
				} catch (error) {
					json(res, { ok: false, error: String((error && error.message) || error) });
				}
			}
		},
		{
			kind: 'exact',
			path: '/dsh-alger/habits',
			handler: async (req, res) => {
				try {
					const body = JSON.parse((await readBody(req)) || '{}');
					const action = String(body.action || '');
					if (action === 'song') json(res, await actions.songCheck(body));
					else if (action === 'night') json(res, await actions.nightCheck());
					else json(res, await actions.habits(body));
				} catch (error) {
					json(res, { ok: false, error: String((error && error.message) || error) });
				}
			}
		},
		{
			kind: 'exact',
			path: '/dsh-alger/similar',
			handler: async (req, res) => {
				try {
					const body = JSON.parse((await readBody(req)) || '{}');
					json(res, await actions.similar(body));
				} catch (error) {
					json(res, { ok: false, error: String((error && error.message) || error) });
				}
			}
		},
		{
			kind: 'exact',
			path: '/dsh-alger/recommend',
			handler: async (req, res) => {
				try {
					const body = JSON.parse((await readBody(req)) || '{}');
					json(res, await actions.recommend(body));
				} catch (error) {
					json(res, { ok: false, error: String((error && error.message) || error) });
				}
			}
		},
		{
			kind: 'exact',
			path: '/dsh-alger/favorites',
			handler: async (req, res) => {
				try {
					const body = JSON.parse((await readBody(req)) || '{}');
					json(res, body.action === 'remove' ? await actions.favoritesRemove(body) : await actions.favoritesList());
				} catch (error) {
					json(res, { ok: false, error: String((error && error.message) || error) });
				}
			}
		},
		{
			kind: 'exact',
			path: '/dsh-alger/search',
			handler: async (req, res) => {
				try {
					const body = JSON.parse((await readBody(req)) || '{}');
					json(res, await actions.search(body));
				} catch (error) {
					json(res, { ok: false, error: String((error && error.message) || error) });
				}
			}
		},
		{
			kind: 'exact',
			path: '/dsh-alger/play',
			handler: async (req, res) => {
				try {
					const body = JSON.parse((await readBody(req)) || '{}');
					json(res, await actions.play(body));
				} catch (error) {
					json(res, { ok: false, error: String((error && error.message) || error) });
				}
			}
		},
		{
			kind: 'exact',
			path: '/dsh-alger/url',
			handler: async (req, res) => {
				try {
					const body = JSON.parse((await readBody(req)) || '{}');
					json(res, await actions.songUrl(body));
				} catch (error) {
					json(res, { ok: false, error: String((error && error.message) || error) });
				}
			}
		},
		{
			kind: 'exact',
			path: '/dsh-alger/playback',
			handler: async (req, res) => {
				try {
					const body = JSON.parse((await readBody(req)) || '{}');
					json(res, await actions.playback(body));
				} catch (error) {
					json(res, { ok: false, error: String((error && error.message) || error) });
				}
			}
		},
		{
			kind: 'exact',
			path: '/dsh-alger/queue',
			handler: async (req, res) => {
				try {
					const body = JSON.parse((await readBody(req)) || '{}');
					json(res, await actions.queue(body));
				} catch (error) {
					json(res, { ok: false, error: String((error && error.message) || error) });
				}
			}
		},
		{
			kind: 'exact',
			path: '/dsh-alger/lyric',
			handler: async (req, res) => {
				try {
					const body = JSON.parse((await readBody(req)) || '{}');
					json(res, await actions.lyric(body));
				} catch (error) {
					json(res, { ok: false, error: String((error && error.message) || error) });
				}
			}
		},
		{
			kind: 'exact',
			path: '/dsh-alger/artist',
			handler: async (req, res) => {
				try {
					const body = JSON.parse((await readBody(req)) || '{}');
					json(res, await actions.artist(body));
				} catch (error) {
					json(res, { ok: false, error: String((error && error.message) || error) });
				}
			}
		},
		{
			kind: 'exact',
			path: '/dsh-alger/setup',
			handler: async (req, res) => {
				try {
					const body = JSON.parse((await readBody(req)) || '{}');
					json(res, await actions.setup(body));
				} catch (error) {
					json(res, { ok: false, error: String((error && error.message) || error) });
				}
			}
		}
	];
	for (const route of routes) webServer.register(route);
}

export const registerRoutesForTest = registerRoutes;


/**
 * 插件入口：解析配置、构造客户端、注册 7 个工具与浮动窗口的 Web 路由。
 * @param ctx - 宿主上下文（含 subprocess.spawn、tools.register、webServer.register）。
 * @param config - 插件配置（cordis.patch.yml 中 id=alger-music 的 config）。
 */
export function apply(ctx, config) {
	let cfg;
	try {
		cfg = resolveConfig(config);
	} catch (error) {
		console.warn('[dsh-moony-singer] ' + (error instanceof Error ? error.message : String(error)));
		cfg = resolveConfig(null);
	}
	// 注意：不能直接把 ctx.subprocess.spawn 解构出来传参——宿主的 spawn 是类方法，
	// 内部读 this.internals，未绑定调用会抛 “Cannot read properties of undefined (reading 'internals')”。
	// 用箭头包装保持 this 指向 subprocess 服务实例。
	const spawn = (spec) => ctx.subprocess.spawn(spec);

	// 所有本地数据服从 DSH_HOME，确保不同 profile/隔离验收不会互相污染。
	const dataRoot = resolveDataRoot();
	// 内置播放状态机 + 音乐 API 客户端（不再依赖任何桌面播放器）
	const player = createPlayer({ file: join(dataRoot, 'moony-singer-state.json') });
	const client = createClient(cfg);
	// 听歌记忆（纯本地播放习惯记录）
	const habits = createHabits({ file: join(dataRoot, 'moony-singer-habits.json') });
	let tasteProfile = null;
	let localLibrary = null;
	let sourceResolver = null;
	let coordinator = null;
	let recommendationPool = null;
	let recommendationGenerator = null;
	let recommendationScheduler = null;
	try {
		tasteProfile = createTasteProfile({ file: join(dataRoot, 'moony-singer-recommendation.json') });
		if (cfg.recommendationLearning) {
			habits.exportLegacy().then((legacy) => tasteProfile.migrateLegacy(legacy)).catch(() => {});
		}
	} catch (error) {
		console.warn('[dsh-moony-singer] 推荐偏好档案初始化失败: ' + ((error && error.message) || String(error)));
	}
	try {
		localLibrary = createLocalLibrary({ roots: Array.isArray(cfg.localMusicPaths) ? cfg.localMusicPaths : [] });
		localLibrary.scan().catch((error) => {
			console.warn('[dsh-moony-singer] 本地音乐扫描失败: ' + ((error && error.message) || String(error)));
		});
	} catch (error) {
		console.warn('[dsh-moony-singer] 本地音乐库初始化失败: ' + ((error && error.message) || String(error)));
	}
	try {
		sourceResolver = createSourceResolver({
			local: localLibrary ? async (track) => {
				const local = await localLibrary.resolve(track.trackKey);
				return local ? {
					url: `/dsh-alger/local?trackKey=${encodeURIComponent(track.trackKey)}`,
					sourceKey: 'local-library',
					confidence: 1
				} : null;
			} : null,
			direct: async (track, options = {}) => {
				const id = Number(track?.raw?.id);
				if (!id) return null;
				const url = await client.songUrl(id, 'higher', { signal: options.signal });
				return url ? { url, sourceKey: 'netease', confidence: 1, expiresAt: Date.now() + 4 * 60 * 1000 } : null;
			},
		});
	} catch (error) {
		console.warn('[dsh-moony-singer] 音源解析器初始化失败: ' + ((error && error.message) || String(error)));
	}
	try {
		if (tasteProfile && sourceResolver) {
			const retrievers = createRetrievers({ client, localLibrary, timeoutMs: Math.min(cfg.timeoutMs, 3500) });
			coordinator = createRecommendationCoordinator({
				player,
				profile: tasteProfile,
				client,
				localLibrary,
				retrievers,
				resolver: sourceResolver,
				targetSize: Math.max(1, Math.min(30, Number(cfg.recommendationTargetSize) || 15)),
				timeoutMs: Math.max(3000, Number(cfg.timeoutMs) || 20000)
			});
			recommendationPool = createRecommendationPool({
				file: join(dataRoot, 'moony-singer-recommendation-pool.json'),
				targetSize: 60,
				batchSize: 30,
				historySize: 120
			});
			recommendationGenerator = createRecommendationGenerator({
				pool: recommendationPool,
				player,
				profile: tasteProfile,
				client,
				localLibrary,
				retrievers,
				resolver: sourceResolver,
				targetSize: 60
			});
			recommendationScheduler = createRecommendationScheduler({
				debounceMs: 10000,
				retryDelayMs: 30000,
				generate: async (input) => {
					const result = await recommendationGenerator.generate(input);
					if (!result.ok) throw new Error(result.error || result.reason || '推荐池生成失败');
					return result;
				}
			});
			recommendationPool.load().then(() => {
				if (recommendationPool.needsRefill()) recommendationScheduler.schedule('startup', { urgent: true });
			}).catch((error) => {
				console.warn('[dsh-moony-singer] 推荐池加载失败: ' + ((error && error.message) || String(error)));
				recommendationScheduler.schedule('startup-recovery', { urgent: true });
			});
		}
	} catch (error) {
		console.warn('[dsh-moony-singer] 推荐系统初始化失败: ' + ((error && error.message) || String(error)));
	}

	// 内置音乐 API 服务（netease-cloud-music-api-alger）自动启动
	const apiHandle = {
		handle: null,
		isUp: false,
		spawn,
		serverEntryPath: null
	};
	try {
		apiHandle.serverEntryPath = createRequire(import.meta.url).resolve('netease-cloud-music-api-alger/server.js');
	} catch (error) {
		console.warn('[dsh-moony-singer] 未找到内置音乐 API 依赖: ' + ((error && error.message) || String(error)));
	}
	if (apiHandle.serverEntryPath) {
		const result = startApiServer({
			spawn,
			serverEntryPath: apiHandle.serverEntryPath,
			port: cfg.musicApiPort,
			host: cfg.musicApiHost
		});
		if (!result.ok) {
			console.warn('[dsh-moony-singer] 音乐服务启动失败: ' + (result.error || ''));
		} else {
			apiHandle.handle = result.handle;
		}
	}

	// agent 状态跟踪（宠物反映 DSH 在做啥）——订阅宿主事件
	const shared = {};
	const agentState = new Map();
	function sidOf(x) {
		if (!x) return undefined;
		if (typeof x === 'string') return x;
		if (typeof x.id === 'string') return x.id;
		if (typeof x.sessionId === 'string') return x.sessionId;
		if (x.agent) return sidOf(x.agent);
		if (x.session) return sidOf(x.session);
		if (x.info && typeof x.info === 'object') return sidOf(x.info);
		if (x.exec && typeof x.exec === 'object') return sidOf(x.exec);
		return undefined;
	}
	function markAgent(sid, patch) {
		if (!sid) return;
		const e = agentState.get(sid) || { status: 'idle', lastActivity: 0 };
		agentState.set(sid, { ...e, ...patch, lastActivity: Date.now() });
	}
	if (typeof ctx.on === 'function') {
		ctx.on('agent/status', (p) => markAgent(sidOf(p && p.agent), { status: p && p.status === 'running' ? 'running' : 'idle' }));
		ctx.on('agent/turn-stopping', (p) => markAgent(sidOf(p && p.agent), { status: 'review' }));
		ctx.on('agent/error', (p) => markAgent(sidOf(p && p.agent), { status: 'failed' }));
		ctx.on('approval/request', (req, next) => {
			const sid = sidOf(req);
			markAgent(sid, { status: 'waiting' });
			const pr = Promise.resolve(next());
			pr.then(
				() => markAgent(sid, { status: 'idle' }),
				() => markAgent(sid, { status: 'idle' })
			);
			return pr;
		});
	}
	// 取最近活跃会话的状态（超过 60s 未活动视为空闲）
	shared.getAgentStatus = () => {
		const now = Date.now();
		let best = 'idle';
		let bestT = -Infinity;
		for (const [sid, e] of agentState) {
			if (now - e.lastActivity > 60000) { agentState.delete(sid); continue; }
			if (e.lastActivity > bestT) {
				bestT = e.lastActivity;
				best = e.status;
			}
		}
		return best;
	};

	const actions = buildActions(cfg, client, shared, player, apiHandle, habits, {
		coordinator,
		preference: tasteProfile ? createPreferenceAction(tasteProfile) : null,
		localLibrary,
		pool: recommendationPool,
		scheduler: recommendationScheduler
	});
	const disposers = [];
	for (const definition of buildTools(cfg, actions)) {
		disposers.push(ctx.tools.register(definition));
	}
	const webServer = ctx.get('webServer');
	if (webServer) {
		registerRoutes(webServer, actions);
	}
	if (typeof ctx.on === 'function') {
		ctx.on('dispose', () => {
			coordinator?.cancel('plugin disposed');
			recommendationScheduler?.dispose();
			habits.flush().catch(() => {});
			for (const dispose of disposers) dispose();
			if (apiHandle && apiHandle.handle) {
				stopApiServer(apiHandle.handle).catch(() => {});
			}
		});
	}
}
