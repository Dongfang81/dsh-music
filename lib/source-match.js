/**
 * dsh-music/lib/source-match.js —— 多平台音源匹配。
 *
 * 当歌曲在音乐 API 没有可用直链（版权受限）时，用歌曲元数据
 * （歌名/歌手/专辑/时长）从其他开源音源（酷我/酷狗/咪咕/B站等）
 * 匹配同曲完整音源，保证点歌能真正播放。
 *
 * 基于开源项目 @unblockneteasemusic/server（LGPL-3.0，见其 LICENSE）。
 *
 * @module dsh-music/lib/source-match
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let matchFn = null;
let matchReady = false;

function identityText(value) {
	return String(value ?? '').trim().normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ');
}

function artistTokens(value) {
	const source = Array.isArray(value) ? value : [value];
	return source.flatMap((item) => {
		const raw = typeof item === 'object' && item !== null ? item.name : item;
		return String(raw ?? '').split(/[\/\s，,、;&；]+/);
	}).map(identityText).filter(Boolean);
}

/** 精确判断请求歌手是否是候选歌手列表中的完整 token，禁止部分字符串误命中。 */
export function hasExactArtistToken(candidateArtists, requestedArtists) {
	const candidates = new Set(artistTokens(candidateArtists));
	const requested = artistTokens(requestedArtists);
	return requested.length > 0 && requested.every((artist) => candidates.has(artist));
}

/**
 * 只有标题与歌手都精确匹配请求时，才允许把候选时长交给跨源版本校验。
 * 翻唱、现场版、部分歌手名等候选一律返回 0，避免错误时长把原版过滤掉。
 */
export function safeCrossSourceDuration(track, requested) {
	if (!track || !requested) return 0;
	const titleExact = identityText(track.title ?? track.name) === identityText(requested.title ?? requested.name);
	const artistExact = hasExactArtistToken(track.artists ?? track.ar, requested.artists ?? requested.artist);
	return titleExact && artistExact ? Math.max(0, Number(track.durationMs ?? track.dt ?? track.duration) || 0) : 0;
}

/** 惰性加载 match（首次调用时 require，失败不影响插件主流程）。 */
function loadMatch() {
	if (matchReady) return matchFn;
	try {
		// 静默音源匹配库全部日志（pino silent；多平台失败重试是正常流程，无需刷屏）
		if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'silent';
		// 顺序尝试平台（酷我/酷狗/咪咕/B站），第一个成功即返回——比默认的
		// Promise.any 并发更稳（个别平台超时/报错不会拖垮整条链）
		process.env.FOLLOW_SOURCE_ORDER = '1';
		matchFn = require('@unblockneteasemusic/server/src/provider/match.js');
		matchReady = true;
	} catch {
		matchFn = null;
	}
	return matchFn;
}

/** 网易云 song 对象 → match 需要的结构（name/album/artists/duration）。 */
function toMatchInfo(song) {
	const source = song && typeof song === 'object' ? song : {};
	const artists = (source.ar || source.artists || []).map((a) => ({ id: a?.id, name: a?.name || '' }));
	const album = source.al || source.album || {};
	return {
		id: Number(source.id),
		name: source.name || '',
		alias: Array.isArray(source.alias) ? source.alias : [],
		duration: Number(source.dt) || Number(source.duration) || 0,
		album: { id: album.id, name: album.name || '' },
		artists
	};
}

/**
 * 尝试从其他平台匹配同曲音源。
 * @param {object} song - 网易云歌曲对象（含 name/ar/al/dt）
 * @param {string[]} [platforms] - 优先平台列表（默认 GD音乐台/咪咕/酷狗/酷我）
 * @returns {Promise<string|null>} 可播放直链；失败返回 null
 */
export async function matchSourceUrl(song, platforms) {
	const match = loadMatch();
	if (!match || !song || !song.name) return null;
	try {
		const info = toMatchInfo(song);
		const list = Array.isArray(platforms) && platforms.length > 0
			? platforms
			: ['pyncmd', 'migu', 'kugou', 'kuwo'];
		const result = await match(info.id, list, info);
		return result && typeof result.url === 'string' && result.url ? result.url : null;
	} catch {
		return null;
	}
}

/**
 * 用「歌名 - 歌手」关键词直接匹配音源（覆盖歌曲在音乐 API 已下架的场景）。
 * @param {string} name - 歌名
 * @param {string} [artist] - 歌手名
 * @param {string[]} [platforms] - 优先平台列表
 * @param {number} [durationMs] - 目标歌曲时长（毫秒）；提供后各平台按时长校验版本，
 *   避免命中现场串烧/翻唱/同名前几首的错配
 * @returns {Promise<{url:string, source:string, title:string}|null>} 匹配结果
 */
export async function matchSourceByKeyword(name, artist, platforms, durationMs) {
	const match = loadMatch();
	const title = String(name || '').trim();
	if (!match || !title) return null;
	try {
		// 关键词 = 「歌名 - 歌手」（find.js 用它搜索各平台）
		const kw = artist && String(artist).trim()
			? title + ' - ' + String(artist).trim()
			: title;
		const info = {
			id: 0,
			name: title,
			alias: [],
			duration: Number(durationMs) || 0,
			album: { id: 0, name: '' },
			artists: artist ? [{ id: 0, name: String(artist).trim() }] : []
		};
		info.keyword = kw;
		const list = Array.isArray(platforms) && platforms.length > 0
			? platforms
			: ['pyncmd', 'migu', 'kugou', 'kuwo'];
		const result = await match(0, list, info);
		if (result && typeof result.url === 'string' && result.url) {
			return { url: result.url, source: result.source, title: result.title || title };
		}
		return null;
	} catch {
		return null;
	}
}
