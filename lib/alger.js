/**
 * dsh-music/lib/alger.js —— 内置音乐 API 客户端。
 *
 * 新架构：插件自带开源网易云音乐 API 服务（netease-cloud-music-api-alger），
 * 本模块只做 HTTP 调用：搜索 / 歌曲详情 / 歌词 / 播放地址 / 歌单 / 推荐。
 * 不再管理任何桌面播放器 App。
 *
 * @module dsh-music/lib/alger
 */

/**
 * 构造内置音乐 API 客户端。
 * @param {object} cfg - 插件配置（见 index.js DEFAULTS）
 */
export function createClient(cfg, runtime = {}) {
	const apiBase = `http://${cfg.musicApiHost || '127.0.0.1'}:${cfg.musicApiPort}`;
	const fetchFn = runtime.fetch || fetch;

	/** 只验证本地 HTTP 服务可达；任何 HTTP 响应都代表进程在线。 */
	async function reachable(url, requestOptions = {}) {
		const timeoutMs = Number(requestOptions.timeoutMs) || 1000;
		const parentSignal = requestOptions.signal;
		const controller = new AbortController();
		const relayAbort = () => controller.abort(parentSignal.reason ?? new Error('request cancelled'));
		if (parentSignal?.aborted) relayAbort();
		else parentSignal?.addEventListener('abort', relayAbort, { once: true });
		const timer = setTimeout(() => controller.abort(new Error('请求超时: ' + url)), timeoutMs);
		try {
			await fetchFn(url, { signal: controller.signal });
			return true;
		} finally {
			clearTimeout(timer);
			parentSignal?.removeEventListener('abort', relayAbort);
		}
	}

	/** GET 并解析 JSON；失败抛带上下文的中文错误。 */
	async function getJson(url, requestOptions = {}) {
		const options = typeof requestOptions === 'number' ? { timeoutMs: requestOptions } : (requestOptions || {});
		const timeoutMs = Number(options.timeoutMs) || cfg.timeoutMs;
		const parentSignal = options.signal;
		const controller = new AbortController();
		const relayAbort = () => controller.abort(parentSignal.reason ?? new Error('request cancelled'));
		if (parentSignal?.aborted) relayAbort();
		else parentSignal?.addEventListener('abort', relayAbort, { once: true });
		const timer = setTimeout(() => controller.abort(new Error('请求超时: ' + url)), timeoutMs);
		let res;
		let text;
		try {
			res = await fetchFn(url, { signal: controller.signal });
			text = await res.text();
		} catch (error) {
			throw new Error('无法连接音乐服务 ' + url + '：' + ((error && error.message) || String(error)));
		} finally {
			clearTimeout(timer);
			parentSignal?.removeEventListener('abort', relayAbort);
		}
		if (!res.ok) throw new Error(`HTTP ${res.status} ${url}：${text.slice(0, 200)}`);
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}

	return {
		apiBase,
		getJson,

		/** 音乐服务是否可用（探活）。 */
		async musicApiUp(options = {}) {
			try {
				return await reachable(`${apiBase}/`, { timeoutMs: options.timeoutMs ?? 1000, signal: options.signal });
			} catch {
				return false;
			}
		},

		// ---------- 网易云 API ----------
		async search(keywords, type = 1, limit = 10, options = {}) {
			const data = await getJson(
				`${apiBase}/search?keywords=${encodeURIComponent(keywords)}&type=${type}&limit=${limit}`,
				options
			);
			if (data.code !== 200) throw new Error('搜索失败: ' + JSON.stringify(data).slice(0, 200));
			return data.result || {};
		},
		async songDetail(ids, options = {}) {
			const data = await getJson(`${apiBase}/song/detail?ids=${ids}`, options);
			if (data.code !== 200) throw new Error('获取歌曲详情失败: ' + JSON.stringify(data).slice(0, 200));
			return (data.songs || [])[0] ?? null;
		},
		async lyric(id, options = {}) {
			const data = await getJson(`${apiBase}/lyric?id=${id}`, options);
			return data?.lrc?.lyric ?? null;
		},
		async songUrl(id, level = 'higher', options = {}) {
			const data = await getJson(`${apiBase}/song/url?id=${id}&level=${level}`, options);
			const item = data?.data?.[0];
			// 无直链或试听（freeTrialInfo 存在）都视为不可播
			if (!item?.url) return null;
			if (item.freeTrialInfo || item.type === 0) return null;
			return item.url;
		},
		async playlist(id, limit = 100, options = {}) {
			const data = await getJson(`${apiBase}/playlist/detail?id=${id}&limit=${limit}`, options);
			if (data.code !== 200) throw new Error('获取歌单失败: ' + JSON.stringify(data).slice(0, 200));
			return data.playlist ?? null;
		}
	};
}
