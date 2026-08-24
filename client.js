/**
 * Copyright (C) 2026 DongfangXie (dongfangxie)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * dsh-moony-singer —— Client half（浏览器浮动播放器）。
 *
 * 由 DSH web 的模块加载器（window.__ModuleLoader__.load）挂载：右下角浮动小窗，
 * 实时展示内置播放引擎的状态，提供 播放/暂停、上一首、下一首、收藏、播放模式、
 * 搜索点歌 与内置音乐服务管理。播放由页面内 <audio> 元素出声，
 * 状态经插件服务端路由 /dsh-alger/* 中转（本机音乐 API 不直接暴露给页面）。
 */
window.__ModuleLoader__.load({
	id: "@dongfang81/dsh-music",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var ReactDOM = require("react-dom");
		var h = React.createElement;

		/** 轮询间隔（ms）。 */
		var POLL_MS = 1500;
		/** 展开宽度。 */
		var WIDTH = 280;
		/** 本地存储键。 */
		var STORE_X = "dsh-alger:x";
		var STORE_Y = "dsh-alger:y";
		var STORE_MOONY_ID = "dsh-moony-singer:pet-id:v1";
		var STORE_PET_SCALE = "dsh-moony-singer:pet-scale:v1";
		var PET_SCALE_MIN = 0.6;
		var PET_SCALE_MAX = 1.8;
		var PET_SCALE_STEP = 0.1;
		/** 读宠物缩放（localStorage，非法值回退 1）。 */
		function readPetScale(storage) {
			try {
				var v = Number(storage && storage.getItem(STORE_PET_SCALE));
				if (Number.isFinite(v) && v >= PET_SCALE_MIN && v <= PET_SCALE_MAX) return v;
			} catch { /* 回退默认 */ }
			return 1;
		}
		var MOONY_STATUS = Object.freeze({
			idle: Object.freeze({ signal: "transparent" }),
			running: Object.freeze({ signal: "#3B82F6" }),
			waiting: Object.freeze({ signal: "#F59E0B" }),
			failed: Object.freeze({ signal: "#EF4444" }),
			review: Object.freeze({ signal: "#10B981" })
		});
		var MOONY_CATALOG = Object.freeze([
			Object.freeze({ id: "classic", name: "Moony Classic", role: "初代经典", ear: "classic", tail: "none", motion: "float", colors: Object.freeze({ ear: "#6D5BD0", highlight: "#A99AF2", rim: "#D8D0FF" }) }),
			Object.freeze({ id: "pulse", name: "Moony · Pulse", role: "节拍追逐者", ear: "pulse", tail: "none", motion: "beat", colors: Object.freeze({ ear: "#6944C4", highlight: "#C2A5FF", rim: "#DED1FF" }) }),
			Object.freeze({ id: "echo", name: "Moony · Echo", role: "回忆共振者", ear: "echo", tail: "orbit", motion: "orbit", colors: Object.freeze({ ear: "#394B91", highlight: "#8EA8E8", rim: "#B8C8F5" }) }),
			Object.freeze({ id: "drift", name: "Moony · Drift", role: "沉浸漂流者", ear: "drift", tail: "comet", motion: "drift", colors: Object.freeze({ ear: "#6799A2", highlight: "#B9E0E2", rim: "#D5F2F1" }) }),
			Object.freeze({ id: "spark", name: "Moony · Spark", role: "新声探索者", ear: "spark", tail: "none", motion: "scan", colors: Object.freeze({ ear: "#C88322", highlight: "#F2D16D", rim: "#FFE4A3" }) }),
			Object.freeze({ id: "chorus", name: "Moony · Chorus", role: "跟唱共鸣者", ear: "chorus", tail: "curl", motion: "chorus", colors: Object.freeze({ ear: "#B85388", highlight: "#F3A6C7", rim: "#FFD0E3" }) }),
			Object.freeze({ id: "hush", name: "Moony · Hush", role: "安静陪伴者", ear: "hush", tail: "none", motion: "hush", colors: Object.freeze({ ear: "#647654", highlight: "#B9C5A6", rim: "#DBE3CE" }) }),
			Object.freeze({ id: "loop", name: "Moony · Loop", role: "循环收藏家", ear: "loop", tail: "none", motion: "loop", colors: Object.freeze({ ear: "#238E91", highlight: "#7FE2D7", rim: "#BFF7EE" }) }),
			Object.freeze({ id: "bass", name: "Moony · Bass", role: "低频承载者", ear: "bass", tail: "none", motion: "bass", colors: Object.freeze({ ear: "#3E365C", highlight: "#82739F", rim: "#C9B9E6" }) }),
			Object.freeze({ id: "vinyl", name: "Moony · Vinyl", role: "黑胶漫游者", ear: "vinyl", tail: "needle", motion: "vinyl", colors: Object.freeze({ ear: "#7A3F4D", highlight: "#D49A8A", rim: "#F2C9B8" }) })
		]);
		var MOONY_BY_ID = Object.freeze(MOONY_CATALOG.reduce(function (out, pet) { out[pet.id] = pet; return out; }, {}));
		var MOONY_SOFT_GLOW_EARS = Object.freeze({ pulse: true, echo: true, hush: true });
		var MOONY_PHASE_CIRCUMFERENCE = 188.5;

		function getMoony(id) {
			return typeof id === "string" && Object.prototype.hasOwnProperty.call(MOONY_BY_ID, id) ? MOONY_BY_ID[id] : MOONY_BY_ID.classic;
		}

		function normalizeHexColor(value) {
			var match = typeof value === "string" ? value.trim().match(/^#([0-9a-f]{6})$/i) : null;
			return match ? "#" + match[1].toUpperCase() : null;
		}

		function colorWithAlpha(value, alpha) {
			var hex = normalizeHexColor(value);
			if (!hex) return "rgba(255, 255, 255, " + alpha + ")";
			return "rgba(" + parseInt(hex.slice(1, 3), 16) + ", " + parseInt(hex.slice(3, 5), 16) + ", " + parseInt(hex.slice(5, 7), 16) + ", " + alpha + ")";
		}

		function dominantColorFromPixels(data) {
			if (!data || typeof data.length !== "number") return null;
			var buckets = Object.create(null);
			for (var i = 0; i + 3 < data.length; i += 4) {
				var alpha = Number(data[i + 3]);
				if (alpha < 128) continue;
				var r = Number(data[i]);
				var g = Number(data[i + 1]);
				var b = Number(data[i + 2]);
				var key = (r >> 4) + ":" + (g >> 4) + ":" + (b >> 4);
				var bucket = buckets[key] || (buckets[key] = { count: 0, r: 0, g: 0, b: 0 });
				bucket.count += 1;
				bucket.r += r;
				bucket.g += g;
				bucket.b += b;
			}
			var winner = null;
			Object.keys(buckets).forEach(function (key) {
				if (!winner || buckets[key].count > winner.count) winner = buckets[key];
			});
			if (!winner) return null;
			var hex = function (number) { return Math.round(number / winner.count).toString(16).padStart(2, "0").toUpperCase(); };
			return "#" + hex(winner.r) + hex(winner.g) + hex(winner.b);
		}

		function extractAmbientColor(url) {
			return new Promise(function (resolve) {
				if (typeof url !== "string" || !url.trim() || typeof Image !== "function") { resolve(null); return; }
				var settled = false;
				var timer = null;
				var finish = function (color) {
					if (settled) return;
					settled = true;
					if (timer) clearTimeout(timer);
					resolve(color || null);
				};
				var image = new Image();
				image.crossOrigin = "anonymous";
				image.decoding = "async";
				image.onload = function () {
					try {
						var canvas = document.createElement("canvas");
						canvas.width = 16;
						canvas.height = 16;
						var context = canvas.getContext("2d", { willReadFrequently: true });
						if (!context) { finish(null); return; }
						context.drawImage(image, 0, 0, 16, 16);
						finish(dominantColorFromPixels(context.getImageData(0, 0, 16, 16).data));
					} catch { finish(null); }
				};
				image.onerror = function () { finish(null); };
				timer = setTimeout(function () { finish(null); }, 5000);
				image.src = url.trim();
			});
		}

		function resolveMoonyLight(pet, status, isPlaying, ambientColor) {
			if (status !== "idle") return MOONY_STATUS[status].signal;
			return isPlaying ? (normalizeHexColor(ambientColor) || pet.colors.rim) : pet.colors.rim;
		}

		function resolveMoonPhase(value) {
			var number = Number(value);
			var progress = Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
			var opacity = progress <= .92 ? 1 : Math.max(0, (1 - progress) / .08);
			return { progress: progress, opacity: Number(opacity.toFixed(3)) };
		}

		function bindAudioBuffering(audio, onChange) {
			var starts = ["loadstart", "waiting", "stalled"];
			var stops = ["canplay", "canplaythrough", "playing", "seeked", "ended", "error"];
			var start = function () { onChange(true); };
			var stop = function () { onChange(false); };
			starts.forEach(function (name) { audio.addEventListener(name, start); });
			stops.forEach(function (name) { audio.addEventListener(name, stop); });
			return function () {
				starts.forEach(function (name) { audio.removeEventListener(name, start); });
				stops.forEach(function (name) { audio.removeEventListener(name, stop); });
			};
		}

		function MoonyPhaseRing(props) {
			var phase = resolveMoonPhase(props && props.progress);
			var offset = Number((MOONY_PHASE_CIRCUMFERENCE * (1 - phase.progress)).toFixed(2));
			var buffering = Boolean(props && props.buffering);
			return h("svg", {
				className: "dsa-moony-phase" + (buffering ? " buffering" : ""), viewBox: "0 0 64 64",
				role: "img", "aria-label": "播放进度 " + Math.round(phase.progress * 100) + "%"
			}, [
				h("circle", { key: "track", className: "dsa-moony-phase-track", cx: 32, cy: 32, r: 30 }),
				h("circle", { key: "progress", className: "dsa-moony-phase-progress", cx: 32, cy: 32, r: 30, style: { strokeDasharray: MOONY_PHASE_CIRCUMFERENCE, strokeDashoffset: offset, opacity: phase.opacity } }),
				h("circle", { key: "gap", className: "dsa-moony-phase-gap", cx: 32, cy: 32, r: 30 })
			]);
		}

		function MoonySoftHalos() {
			return h("span", { key: "soft-halos", className: "dsa-moony-soft-halos", "aria-hidden": true }, [
				h("i", { key: "left", className: "dsa-moony-soft-halo left" }),
				h("i", { key: "right", className: "dsa-moony-soft-halo right" })
			]);
		}

		function getLocalStorage() {
			try { return typeof window !== "undefined" ? window.localStorage : null; }
			catch { return null; }
		}

		function readStoredMoonyId(storage) {
			try { return getMoony(storage && storage.getItem(STORE_MOONY_ID)).id; }
			catch { return "classic"; }
		}

		function writeStoredMoonyId(storage, id) {
			var safeId = getMoony(id).id;
			try { if (storage) storage.setItem(STORE_MOONY_ID, safeId); } catch { /* memory state remains usable */ }
			return safeId;
		}

		function MoonyThumbnail(props) {
			var pet = getMoony(props && props.petId);
			var style = {
				"--moony-ear": pet.colors.ear, "--moony-ear-highlight": pet.colors.highlight,
				"--moony-rim": pet.colors.rim, "--moony-rim-soft": colorWithAlpha(pet.colors.rim, .58),
				"--moony-light": pet.colors.rim, "--moony-light-soft": colorWithAlpha(pet.colors.rim, .72), "--moony-signal": "transparent"
			};
			return h("span", { className: "dsa-moony-thumb", "aria-hidden": true }, h("span", {
				className: "dsa-moony-pet", "data-moony-id": pet.id, "data-moony-ear": pet.ear, "data-moony-motion": pet.motion, style: style
			}, h("span", { className: "dsa-moony-rhythm" }, [
				pet.tail !== "none" ? h("span", { key: "tail", className: "dsa-moony-tail", "data-moony-tail": pet.tail }) : null,
				h("span", { key: "left", className: "dsa-moony-ear left" }),
				h("span", { key: "right", className: "dsa-moony-ear right" }),
				h("span", { key: "face", className: "dsa-moony-face" })
			])));
		}

		function MoonyPicker(props) {
			var selectedId = getMoony(props && props.selectedId).id;
			var onSelect = props && typeof props.onSelect === "function" ? props.onSelect : function () {};
			var autoMatch = Boolean(props && props.autoMatch);
			var onToggleAuto = props && typeof props.onToggleAutoMatch === "function" ? props.onToggleAutoMatch : function () {};
			return h("div", { className: "dsa-moony-menu", role: "menu", "aria-label": "选择 Moony" }, [
				// 自动匹配宠物开关（听歌时自动切换角色）；仅在有回调时渲染
				typeof props && props && typeof props.onToggleAutoMatch === "function"
					? h("button", {
							key: "auto-match", type: "button", role: "switch", "aria-checked": autoMatch,
							className: "dsa-moony-auto" + (autoMatch ? " on" : ""),
							title: autoMatch ? "自动匹配已开启：听歌时自动切换成最合拍的角色" : "自动匹配已关闭",
							onClick: function (e) { e.stopPropagation(); onToggleAuto(); }
						}, [
							h("span", { className: "dsa-moony-auto-copy" }, "听歌自动匹配宠物"),
							h("span", { className: "dsa-moony-auto-check" }, autoMatch ? "✓ 开" : "关")
						])
					: null,
				MOONY_CATALOG.map(function (pet) {
					var selected = pet.id === selectedId;
					return h("button", {
						key: pet.id, type: "button", role: "menuitemradio", className: "dsa-moony-option" + (selected ? " on" : ""),
						"data-moony-choice": pet.id, "aria-checked": selected, title: pet.name + " · " + pet.role,
						onClick: function () { onSelect(pet.id); }
					}, [
						MoonyThumbnail({ petId: pet.id }),
						h("span", { className: "dsa-moony-option-copy" }, [h("strong", null, pet.name), h("small", null, pet.role)]),
						h("span", { className: "dsa-moony-option-check" }, selected ? "✓" : "")
					]);
				})
			]);
		}

		function createLongPressHandlers(options) {
			var input = options || {};
			var timerRef = input.timerRef || { current: null };
			var triggeredRef = input.triggeredRef || { current: false };
			var setTimer = input.setTimer || setTimeout;
			var clearTimer = input.clearTimer || clearTimeout;
			var clear = function () {
				if (timerRef.current !== null) clearTimer(timerRef.current);
				timerRef.current = null;
			};
			return {
				onPointerDown: function () {
					triggeredRef.current = false;
					clear();
					timerRef.current = setTimer(function () {
						timerRef.current = null;
						triggeredRef.current = true;
						if (typeof input.onLongPress === "function") input.onLongPress();
					}, input.delay || 550);
				},
				onPointerUp: clear,
				onPointerLeave: clear,
				onPointerCancel: clear,
				onClick: function (event) {
					if (triggeredRef.current) {
						triggeredRef.current = false;
						if (event && typeof event.preventDefault === "function") event.preventDefault();
						return;
					}
					if (typeof input.onClick === "function") input.onClick(event);
				}
			};
		}

		function FavoriteMembershipPicker(props) {
			var song = props && props.song;
			var collections = Array.isArray(props && props.collections) ? props.collections.filter(function (item) { return item && item.id !== "all"; }) : [];
			var selected = Object.create(null);
			collections.forEach(function (item) { selected[item.id] = Array.isArray(item.songIds) && song && item.songIds.some(function (id) { return String(id) === String(song.id); }); });
			return h("div", { className: "dsa-fav-picker", role: "dialog", "aria-label": "收藏到" }, [
				h("div", { key: "title", className: "dsa-fav-panel-title" }, "收藏到…"),
				collections.length ? collections.map(function (item) {
					return h("label", { key: item.id, className: "dsa-fav-check" }, [
						h("input", { type: "checkbox", value: item.id, defaultChecked: selected[item.id], onChange: function (event) { selected[item.id] = Boolean(event.target.checked); } }),
						h("span", null, item.name)
					]);
				}) : h("div", { key: "empty", className: "dsa-fav-empty" }, "还没有自定义目录，可先新建一个。"),
				h("div", { key: "actions", className: "dsa-fav-panel-actions" }, [
					h("button", { type: "button", onClick: function () { if (typeof props.onClose === "function") props.onClose(); } }, "取消"),
					h("button", { type: "button", className: "primary", onClick: function () { if (typeof props.onSave === "function") props.onSave(Object.keys(selected).filter(function (id) { return selected[id]; })); } }, "保存")
				])
			]);
		}

		function FavoriteCollectionPanel(props) {
			var collections = Array.isArray(props && props.collections) ? props.collections : [];
			var songs = Array.isArray(props && props.songs) ? props.songs : [];
			var activeId = props && props.activeId || "all";
			var active = collections.find(function (item) { return item.id === activeId; }) || collections[0] || { id: "all", name: "全部收藏", system: true };
			return h("div", { className: "dsa-fav-panel", role: "dialog", "aria-label": "收藏列表" }, [
				h("div", { key: "head", className: "dsa-fav-panel-head" }, [
					h("strong", null, "收藏列表"),
					h("button", { type: "button", className: "dsa-fav-close", title: "关闭", onClick: props && props.onClose }, "✕")
				]),
				h("div", { key: "tabs", className: "dsa-fav-tabs" }, collections.map(function (item) {
					return h("button", { key: item.id, type: "button", className: item.id === active.id ? "active" : "", onClick: function () { if (typeof props.onSelect === "function") props.onSelect(item.id); } }, item.name + " " + (item.count || 0));
				})),
				h("div", { key: "tools", className: "dsa-fav-tools" }, [
					h("button", { type: "button", disabled: songs.length === 0, onClick: function () { if (typeof props.onPlay === "function") props.onPlay(active.id); } }, "播放此目录"),
					active.id !== "all" ? h("button", { type: "button", "data-collection-rename": active.id, onClick: function () { if (typeof props.onRename === "function") props.onRename(active); } }, "重命名") : null,
					active.id !== "all" ? h("button", { type: "button", "data-collection-delete": active.id, onClick: function () { if (typeof props.onDelete === "function") props.onDelete(active); } }, "删除目录") : null,
					h("button", { type: "button", onClick: function () { if (typeof props.onCreate === "function") props.onCreate(); } }, "＋ 新建")
				]),
				h("div", { key: "songs", className: "dsa-fav-songs" }, songs.length ? songs.map(function (song) {
					return h("div", { key: song.id, className: "dsa-fav-song" }, [
						h("span", { className: "t", title: song.name }, song.name),
						h("span", { className: "s", title: song.artists || "" }, song.artists || ""),
						h("button", { type: "button", onClick: function () { if (typeof props.onOrganize === "function") props.onOrganize(song); } }, "收藏到…")
					]);
				}) : h("div", { className: "dsa-fav-empty" }, "这个目录还没有歌曲"))
			]);
		}

		function QueueSongRow(props) {
			var item = props.item || {};
			var index = Number(props.index);
			return h("div", {
				className: "dsa-qitem" + (props.current ? " cur" : "") + (props.selected && !props.current ? " sel" : ""),
				title: "单击选中，双击播放",
				onClick: function () { if (typeof props.onSelect === "function") props.onSelect(index); },
				onDoubleClick: function () { if (typeof props.onJump === "function") props.onJump(index); }
			}, [
				h("span", { key: "number", className: "n" }, (index + 1) + "."),
				h("span", { key: "title", className: "t" }, item.name),
				h("span", { key: "artist", className: "s" }, item.artists || ""),
				h("button", {
					key: "remove", type: "button", className: "dsa-qremove", "aria-label": "从播放列表移除", title: "从播放列表移除",
					onClick: function (event) { event.stopPropagation(); if (typeof props.onRemove === "function") props.onRemove(index); },
					onDoubleClick: function (event) { event.stopPropagation(); }
				}, "×")
			]);
		}

		function queuePayloadForSearchItem(item) {
			if (item && item.crossSource && typeof item.playKeyword === "string" && item.playKeyword.trim()) {
				return { action: "add", keyword: item.playKeyword.trim() };
			}
			return { action: "add", songId: item && item.id };
		}

		/* ---------- 微信分享面板（朋友无需安装插件） ----------
		 * 网易云公开链接 + 剪贴板复制 + 二维码（二维码走公共服务，失败自动降级隐藏，
		 * 分享核心链路始终可用：复制链接 → 微信粘贴 → 自动渲染歌曲卡片）。
		 */
		function SharePanel(props) {
			var song = props && props.song;
			var link = shareLinkFor(song);
			var [qrTier, setQrTier] = React.useState(0);
			var [copied, setCopied] = React.useState(false);
			React.useEffect(function () { setQrTier(0); setCopied(false); }, [link]);
			if (!song || !link) return null;
			var qrSrc = null;
			if (qrTier === 0) qrSrc = "https://api.pwmqr.com/qrcode/create/?url=" + encodeURIComponent(link);
			else if (qrTier === 1) qrSrc = "https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=" + encodeURIComponent(link);
			return h("div", { className: "dsa-share-menu", role: "dialog", "aria-label": "分享这首歌" }, [
				// 关闭按钮：标准弹窗右上角
				h("button", { className: "dsa-share-x", title: "关闭", onClick: props.onClose }, "✕"),
				h("div", { className: "dsa-share-head" }, [
					h("img", { className: "dsa-share-cover", src: song.albumPic || "", alt: "", draggable: false }),
					h("div", { className: "dsa-share-meta" }, [
						h("strong", null, song.name || ""),
						h("small", null, String(song.artists || "").split(",").filter(Boolean).join(" / "))
					])
				]),
				h("div", { className: "dsa-share-link", title: link }, link),
				h("div", { className: "dsa-share-row" }, [
					h("button", {
						className: "dsa-btn dsa-mode dsa-share-copy" + (copied ? " on" : ""),
						onClick: function () {
							copyTextToClipboard(link).then(function (ok) {
								setCopied(ok);
								if (ok && typeof props.onCopied === "function") props.onCopied(link);
							});
						}
					}, copied ? "✓ 已复制" : "复制链接")
				]),
				qrTier < 2 && qrSrc
					? h("div", { className: "dsa-share-qr-wrap" }, [
							h("img", { className: "dsa-share-qr", src: qrSrc, alt: "二维码", onError: function () { setQrTier(function (t) { return Math.min(2, t + 1); }); } }),
							h("small", null, "朋友扫码即可打开（或复制链接发微信）")
						])
					: h("div", { className: "dsa-share-qr-wrap fail" }, [
							h("small", null, "二维码服务暂不可用，请用「复制链接」分享")
						])
			]);
		}

		function resolveMoonyState(input) {
			var value = input && typeof input === "object" ? input : {};
			var status = typeof value.agentStatus === "string" && Object.prototype.hasOwnProperty.call(MOONY_STATUS, value.agentStatus) ? value.agentStatus : "idle";
			var mediaUrl = typeof value.mediaUrl === "string" && value.mediaUrl.trim() ? value.mediaUrl.trim() : null;
			return { pet: getMoony(value.petId), status: status, faceMode: mediaUrl ? "media" : "blank", mediaUrl: mediaUrl };
		}

		function MoonyPet(props) {
			var input = props && typeof props === "object" ? props : {};
			var value = resolveMoonyState({ petId: input.petId, agentStatus: input.agentStatus, mediaUrl: input.mediaUrl });
			var pet = value.pet;
			var softGlow = Object.prototype.hasOwnProperty.call(MOONY_SOFT_GLOW_EARS, pet.ear);
			var light = resolveMoonyLight(pet, value.status, Boolean(input.isPlaying), input.ambientColor);
			var style = {
				"--moony-ear": pet.colors.ear, "--moony-ear-highlight": pet.colors.highlight,
				"--moony-rim": pet.colors.rim, "--moony-rim-soft": colorWithAlpha(pet.colors.rim, .58),
				"--moony-light": light, "--moony-light-soft": colorWithAlpha(light, .72),
				"--moony-signal": MOONY_STATUS[value.status].signal
			};
			var parts = [
				softGlow ? MoonySoftHalos() : null,
				pet.tail !== "none" ? h("span", { key: "tail", className: "dsa-moony-tail", "data-moony-tail": pet.tail }) : null,
				h("span", { key: "left", className: "dsa-moony-ear left" }, h("i", { className: "dsa-moony-signal" })),
				h("span", { key: "right", className: "dsa-moony-ear right" }, h("i", { className: "dsa-moony-signal" })),
				h("span", { key: "face", className: "dsa-moony-face" }, value.faceMode === "media" ? h("img", { key: value.mediaUrl, src: value.mediaUrl, alt: "", draggable: false, onLoad: function (event) { event.currentTarget.hidden = false; }, onError: function (event) { event.currentTarget.hidden = true; } }) : null),
				MoonyPhaseRing({ key: "phase", progress: input.playbackProgress, buffering: input.isBuffering })
			];
			return h("div", {
				className: "dsa-pet dsa-moony-pet" + (input.isPlaying ? " singing" : "") + " dsa-agent-" + value.status,
				"data-moony-id": pet.id, "data-moony-ear": pet.ear, "data-moony-motion": pet.motion,
				"data-moony-soft-glow": softGlow ? true : undefined, style: style,
				title: input.title || pet.name, onPointerDown: input.onPointerDown, onClick: input.onClick
			}, h("span", { className: "dsa-moony-rhythm" }, parts));
		}

		/* ---------- API ---------- */
		function getState() {
			return fetch("/dsh-alger/state", { cache: "no-store" }).then(function (r) { return r.json(); });
		}
		function post(path, body) {
			return fetch(path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body || {})
			}).then(function (r) { return r.json(); });
		}
		var command = function (action) { return post("/dsh-alger/command", { action: action }); };
		var searchMusic = function (keywords, type) { return post("/dsh-alger/search", { keywords: keywords, type: type || 1, limit: 30 }); };
		var queueApi = function (payload) { return post("/dsh-alger/queue", payload); };
		var favoritesApi = function (payload) { return post("/dsh-alger/favorites", payload); };
		var setupApp = function (action) { return post("/dsh-alger/setup", { action: action }); };
		var getLyric = function (id) { return post("/dsh-alger/lyric", { id: id }); };
		var getArtist = function (id) { return post("/dsh-alger/artist", { id: id }); };
		var reportPlayback = function (payload) { return post("/dsh-alger/playback", payload); };

		/* ---------- LRC 解析与歌词行定位 ----------
		 * 历史事故（教训）：同一个全局正则对象绝不能在 exec() 循环里又被 replace() 使用
		 * （replace 会重置 lastIndex → exec 反复命中同一处 → 无限循环 → 渲染进程崩溃），
		 * 也不能跨行共享 lastIndex（时间戳结束在行尾时残留 lastIndex 会吞掉后续所有行）。
		 * 因此：每行使用独立正则对象，显式重置 lastIndex，并加行数/匹配数上限兜底。
		 */
		function parseLrc(text) {
			var lines = [];
			var MAX_LINES = 5000;
			var MAX_TS_PER_LINE = 50;
			String(text || "").split("\n").forEach(function (line) {
				if (lines.length >= MAX_LINES) return;
				// 1) 每行独立的时间戳正则（绝不复用全局对象）
				var tsRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
				var ts = [];
				var m;
				tsRe.lastIndex = 0;
				while (ts.length < MAX_TS_PER_LINE && (m = tsRe.exec(line))) ts.push(m);
				if (ts.length === 0) return;
				// 2) 去标签用另一个新正则字面量（与 tsRe 互不影响）
				var text2 = line.replace(/\[[^\]]*\]/g, "").trim();
				ts.forEach(function (t) {
					var frac = t[3] ? Number(String(t[3]).padEnd(3, "0")) / 1000 : 0;
					lines.push({ t: Number(t[1]) * 60 + Number(t[2]) + frac, text: text2 });
				});
			});
			lines.sort(function (a, b) { return a.t - b.t; });
			return lines;
		}
		function currentLrcLine(lrc, position) {
			if (!lrc || lrc.length === 0 || typeof position !== "number") return null;
			var cur = null;
			for (var i = 0; i < lrc.length; i++) {
				if (lrc[i].t <= position) cur = lrc[i];
				else break;
			}
			return cur;
		}
		/* ---------- 微信分享：网易云公开链接 + 剪贴板（朋友无需装插件） ----------
		 * 插件内 songId 即网易云歌曲 ID，拼公开链接即可让任何人在微信/浏览器打开收听；
		 * 复制走 navigator.clipboard，失败（非安全上下文/权限拒绝）回退 textarea + execCommand。
		 */
		function shareLinkFor(song) {
			var id = song && Number(song.id);
			return id > 0 ? "https://music.163.com/song?id=" + id : null;
		}
		function legacyCopy(text) {
			try {
				var ta = document.createElement("textarea");
				ta.value = text;
				ta.setAttribute("readonly", "");
				ta.style.position = "fixed";
				ta.style.top = "-9999px";
				ta.style.opacity = "0";
				document.body.appendChild(ta);
				ta.select();
				var ok = false;
				try { ok = document.execCommand("copy"); } catch { /* ignore */ }
				document.body.removeChild(ta);
				return ok;
			} catch { return false; }
		}
		function copyTextToClipboard(text) {
			return new Promise(function (resolve) {
				try {
					if (navigator.clipboard && navigator.clipboard.writeText) {
						navigator.clipboard.writeText(text).then(function () { resolve(true); }).catch(function () { resolve(legacyCopy(text)); });
						return;
					}
				} catch { /* 走兜底 */ }
				resolve(legacyCopy(text));
			});
		}
		/**
		 * 卡拉 OK 逐字进度：当前歌词行「已唱过」的比例 0~1。
		 * 行尾取下一句时间戳；最后一行没有下一句，用前文合理句长（0.2~20s）的均值兜底，
		 * 完全没有参考时按 4 秒估算。非法输入一律返回 0。
		 */
		function karaokeProgress(lrc, idx, position) {
			if (!lrc || !Array.isArray(lrc) || lrc.length === 0 || !Number.isInteger(idx) || idx < 0 || idx >= lrc.length) return 0;
			if (typeof position !== "number" || !Number.isFinite(position)) return 0;
			var start = Number(lrc[idx].t) || 0;
			if (position <= start) return 0;
			var end = idx + 1 < lrc.length ? Number(lrc[idx + 1].t) || start : start;
			if (!(end > start)) {
				var total = 0, n = 0;
				for (var i = 1; i < lrc.length; i++) {
					var gap = (Number(lrc[i].t) || 0) - (Number(lrc[i - 1].t) || 0);
					if (gap > 0.2 && gap < 20) { total += gap; n++; }
				}
				end = start + (n > 0 ? total / n : 4);
			}
			var span = end - start;
			if (!(span > 0.05)) return 0;
			var p = (position - start) / span;
			return p <= 0 ? 0 : p >= 1 ? 1 : p;
		}

		/* ---------- 系统媒体控制（Media Session API） ----------
		 * macOS 控制中心 / 耳机与键盘媒体键直接控制月宝儿：播放中的 <audio>
		 * 会自动成为系统媒体会话的播放源，这里补充歌名/歌手/封面元数据并同步
		 * 播放状态。浏览器不支持或异常时全部静默降级（不抛错、不影响播放）。
		 */
		var _msSongId = null; // 已发布元数据的歌曲 id（歌变了才重建 metadata）
		function syncMediaSession(song, isPlaying) {
			try {
				if (typeof navigator === "undefined" || !navigator.mediaSession) return;
				var ms = navigator.mediaSession;
				var s = song || null;
				var sid = s && s.id ? String(s.id) : "";
				if (sid && sid !== _msSongId) {
					_msSongId = sid;
					var artwork = s.albumPic ? [{ src: s.albumPic, sizes: "512x512" }] : [];
					try {
						ms.metadata = new MediaMetadata({ title: s.name || "", artist: s.artists || "", album: s.album || "", artwork: artwork });
					} catch {
						try { ms.metadata = new MediaMetadata({ title: s.name || "", artist: s.artists || "" }); } catch { ms.metadata = null; }
					}
				} else if (!sid && _msSongId) {
					_msSongId = null;
					ms.metadata = null;
				}
				ms.playbackState = isPlaying ? "playing" : "paused";
			} catch { /* 忽略 */ }
		}

		/* ---------- 听歌自动匹配宠物（Web Audio 分析低频/能量 → 角色映射） ---------- */
		var STORE_AUTO_MATCH = "dsh-moony-singer:auto-match:v1";
		function readAutoMatch(storage) {
			try { return (storage && storage.getItem(STORE_AUTO_MATCH)) !== "0"; }
			catch { return true; }
		}
		function writeAutoMatch(storage, on) {
			try { if (storage) storage.setItem(STORE_AUTO_MATCH, on ? "1" : "0"); } catch { /* ignore */ }
		}
		/**
		 * 音频特征 → Moony 角色映射（全覆盖：任何有效音频都映射到一个角色，
		 * 不追求精确——推荐只是建议，用户点「变身」才生效）。
		 * 输入: { bass (低频占比 0~1), energy (整体能量 0~1), vocal (中频人声占比 0~1) }
		 * 原则: 极安静→Hush；重低音→Bass；强劲→Pulse；人声突出→Chorus；
		 *       舒缓→Drift；中低频→Echo；其余→Classic（兜底）。
		 */
		function moonyForAudio(feat) {
			var bass = Number(feat && feat.bass) || 0;
			var energy = Number(feat && feat.energy) || 0;
			var vocal = Number(feat && feat.vocal) || 0;
			if (energy < 0.14) return "hush";                    // 极安静/纯音乐
			if (bass > 0.52 && energy > 0.3) return "bass";      // 重低音
			if (energy > 0.6) return "pulse";                    // 强劲节拍
			if (vocal > 0.45 && energy > 0.24) return "chorus";  // 人声突出
			if (energy < 0.3) return "drift";                    // 舒缓
			if (bass > 0.42 && energy > 0.26) return "echo";     // 中低频回忆感
			return "classic";                                    // 均衡兜底
		}
		/**
		 * 歌词密度 → Moony 角色（即时信号，零额外请求、不依赖 Web Audio）：
		 * 歌词本来就是切歌时拉取的现成数据——纯音乐/极稀疏 → Drift（沉浸漂流）；
		 * 歌词密集 → Chorus（跟唱共鸣）；中间地带返回 null，交给音频分析补充。
		 */
		function petForLyricDensity(lineCount, durationSec) {
			var n = Number(lineCount) || 0;
			var d = Number(durationSec) || 0;
			if (d <= 0 || n <= 0) return null;
			var perMin = n / (d / 60); // 每分钟歌词行数
			if (perMin <= 0.4) return "drift";
			if (perMin >= 9) return "chorus";
			return null;
		}
		/**
		 * 创建挂在 audio 元素上的音频分析器。
		 *
		 * 静音铁律：createMediaElementSource 会把 audio 输出重路由进 Web Audio 图，
		 * 一旦路由，若 AudioContext 处于 suspended（自动播放策略），音频就「播放中
		 * 但无声」。因此本实现【只在上下文确认 running 之后才路由】；在此之前 audio
		 * 保持原生直连扬声器，任何情况下都不会因为分析器而静音。路由后若上下文被
		 * 挂起，则在采样与用户交互时持续尝试恢复。
		 * @returns {function|null} 采样函数（返回 {bass,energy,vocal} 或 null）
		 */
		function attachAudioAnalyzer(audio) {
			try {
				if (typeof window === "undefined" || !window.AudioContext || !audio) return null;
				var ctx = new (window.AudioContext || window.webkitAudioContext)();
				var routed = false; // 是否已把 audio 重路由进 Web Audio 图
				var analyser = null;
				var buf = new Uint8Array(0);
				var resumePending = false;
				var routeNow = function () {
					if (routed) return;
					try {
						var src = ctx.createMediaElementSource(audio);
						analyser = ctx.createAnalyser();
						analyser.fftSize = 256;
						src.connect(analyser);
						analyser.connect(ctx.destination); // 保持音频输出（重路由后必须连回 destination）
						buf = new Uint8Array(analyser.frequencyBinCount);
						routed = true;
					} catch {
						/* 路由失败（如重复路由）：保持原生输出 */
					}
				};
				var resumeCtx = function () {
					if (ctx.state !== "suspended" || resumePending) return;
					resumePending = true;
					var p = ctx.resume();
					if (p && typeof p.then === "function") {
						var settled = false;
						var finish = function () { if (!settled) { settled = true; resumePending = false; } };
						p.then(function () {
							finish();
							if (ctx.state === "running") routeNow(); // 恢复成功后立即路由
						}).catch(function () { finish(); /* 浏览器拦截时忽略，稍后重试 */ });
						// 兜底：resume 长期不落定（如无音频设备）→ 释放 pending 允许重试
						setTimeout(function () { finish(); }, 2500);
					} else {
						resumePending = false;
					}
				};
				document.addEventListener("pointerdown", resumeCtx, true); // 用户交互恢复音频上下文
				resumeCtx();
				return function sample() {
					if (audio.paused || audio.ended || audio.readyState < 2) return null;
					resumeCtx(); // 未 running 时持续尝试恢复；恢复成功后才路由
					if (!routed || !analyser || ctx.state !== "running") return null;
					analyser.getByteFrequencyData(buf);
					var n = buf.length;
					var bassSum = 0, midSum = 0, total = 0;
					var bassEnd = Math.floor(n * 0.18), midStart = Math.floor(n * 0.18), midEnd = Math.floor(n * 0.55);
					for (var i = 0; i < n; i++) {
						var v = buf[i];
						total += v;
						if (i < bassEnd) bassSum += v;
						else if (i >= midStart && i < midEnd) midSum += v;
					}
					if (total < 1) return null;
					var energy = total / (n * 255);
					return { bass: bassSum / total, energy: energy, vocal: midSum / total };
				};
			} catch {
				return null;
			}
		}

		// 秒 → m:ss（进度条用）
		function fmtClock(sec) {
			if (!Number.isFinite(sec) || sec <= 0) return "0:00";
			var s = Math.floor(sec);
			return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
		}

		/* ---------- 样式 ---------- */
		var MOONY_CSS = [
			".dsa-pet{position:relative;width:64px;height:64px;cursor:grab;overflow:visible;user-select:none}",
			".dsa-moony-thumb{position:relative;display:block;flex:none;width:30px;height:30px;overflow:visible}.dsa-moony-thumb>.dsa-moony-pet{position:relative;display:block;width:64px;height:64px;transform:scale(.42);transform-origin:2px 2px;pointer-events:none}.dsa-moony-thumb .dsa-moony-rhythm,.dsa-moony-thumb .dsa-moony-ear,.dsa-moony-thumb [data-moony-tail]{animation:none!important}",
			".dsa-pet:active{cursor:grabbing}.dsa-moony-rhythm{position:absolute;inset:0;display:block}",
			".dsa-moony-face{position:absolute;inset:0;z-index:2;display:block;overflow:hidden;border-radius:50%;border:3px solid rgba(255,255,255,.9);background:linear-gradient(145deg,#f5f2f8 4%,#d6cfdf 58%,#aaa1b9);box-shadow:inset 4px 5px 8px rgba(255,255,255,.58),inset -6px -7px 11px rgba(55,40,76,.14),0 8px 18px rgba(0,0,0,.34)}",
			".dsa-moony-face img{width:100%;height:100%;display:block;object-fit:cover}",
			".dsa-moony-phase{position:absolute;inset:-4px;z-index:2;width:72px;height:72px;overflow:visible;pointer-events:none;transform:rotate(-90deg)}.dsa-moony-phase circle{fill:none;vector-effect:non-scaling-stroke;transform-origin:32px 32px}.dsa-moony-phase-track{stroke:rgba(255,255,255,.2);stroke-width:1.25}.dsa-moony-phase-progress{stroke:color-mix(in srgb,var(--moony-light) 58%,white 42%);stroke-width:2.2;stroke-linecap:round;filter:drop-shadow(0 0 2px rgba(255,255,255,.72)) drop-shadow(0 0 6px var(--moony-light-soft))}.dsa-moony-phase-gap{opacity:0;stroke:color-mix(in srgb,var(--moony-light) 58%,white 42%);stroke-width:2.2;stroke-linecap:round;stroke-dasharray:138 50.5;filter:drop-shadow(0 0 5px var(--moony-light-soft))}.dsa-moony-phase.buffering .dsa-moony-phase-progress{opacity:.24!important}.dsa-moony-phase.buffering .dsa-moony-phase-gap{opacity:.95;animation:dsa-moony-phase-flow 1.45s linear infinite}",
			".dsa-moony-ear{position:absolute;z-index:3;display:block;background:linear-gradient(145deg,var(--moony-ear-highlight),var(--moony-ear));border:3px solid var(--moony-rim);box-shadow:inset 3px 3px 6px rgba(255,255,255,.2),inset -4px -5px 7px rgba(30,18,60,.18),0 0 9px var(--moony-rim-soft),0 5px 9px rgba(0,0,0,.2);filter:drop-shadow(0 0 5px var(--moony-light-soft));transform-origin:50% 90%;transition:border-color .35s,filter .35s,box-shadow .35s}",
			".dsa-moony-ear::before{content:'';position:absolute;inset:6px;border:1px solid var(--moony-light-soft);border-radius:inherit;background:radial-gradient(circle at 35% 28%,var(--moony-light-soft),transparent 72%);box-shadow:inset 0 0 8px var(--moony-light-soft);transition:background .5s,border-color .5s,box-shadow .5s}",
			".dsa-moony-soft-halos{position:absolute;inset:0;z-index:2;display:block;pointer-events:none}.dsa-moony-soft-halo{position:absolute;display:block;border-radius:50%;background:var(--moony-light-soft);filter:blur(7px);opacity:.82;transform-origin:50% 90%;transition:background .5s}",
			".dsa-moony-signal{position:absolute;z-index:4;right:6px;top:6px;width:7px;height:7px;border-radius:50%;background:var(--moony-signal);box-shadow:0 0 8px var(--moony-signal)}",
			".dsa-moony-pet[data-moony-ear='classic'] .dsa-moony-ear{top:-17px;width:22px;height:22px;border-radius:55% 45% 25% 30%}.dsa-moony-pet[data-moony-ear='classic'] .left{left:3px}.dsa-moony-pet[data-moony-ear='classic'] .right{right:3px}",
			".dsa-moony-pet[data-moony-ear='pulse'] .dsa-moony-ear{top:-36px;width:27px;height:48px;border-radius:59% 41% 20% 30%;clip-path:polygon(0 0,100% 8%,72% 100%,48% 66%,25% 100%)}.dsa-moony-pet[data-moony-ear='pulse'] .left{left:1px;transform:rotate(-12deg)}.dsa-moony-pet[data-moony-ear='pulse'] .right{right:1px;transform:scaleX(-1) rotate(-12deg)}",
			".dsa-moony-pet[data-moony-ear='echo'] .dsa-moony-ear{top:-26px;width:39px;height:34px;border-radius:65% 35% 58% 42%;clip-path:polygon(0 14%,100% 0,72% 100%,18% 82%)}.dsa-moony-pet[data-moony-ear='echo'] .left{left:-9px;transform:rotate(-18deg)}.dsa-moony-pet[data-moony-ear='echo'] .right{right:-9px;transform:scaleX(-1) rotate(-18deg)}",
			".dsa-moony-pet[data-moony-ear='drift'] .dsa-moony-ear{top:-40px;width:24px;height:59px;border-radius:55% 45% 68% 32%}.dsa-moony-pet[data-moony-ear='drift'] .left{left:-18px;transform:rotate(26deg)}.dsa-moony-pet[data-moony-ear='drift'] .right{right:-18px;transform:rotate(-26deg)}",
			".dsa-moony-pet[data-moony-ear='spark'] .left{left:5px;top:-39px;width:19px;height:50px;border-radius:60% 40% 18% 28%;transform:rotate(-23deg)}.dsa-moony-pet[data-moony-ear='spark'] .right{right:-7px;top:-20px;width:37px;height:29px;border-radius:70% 30% 55% 45%;transform:rotate(8deg)}",
			".dsa-moony-pet[data-moony-ear='chorus'] .dsa-moony-ear{top:-28px;width:39px;height:40px;clip-path:polygon(50% 0,65% 39%,100% 20%,76% 60%,98% 84%,56% 75%,40% 100%,29% 68%,0 75%,25% 47%)}.dsa-moony-pet[data-moony-ear='chorus'] .left{left:-7px;transform:rotate(-9deg)}.dsa-moony-pet[data-moony-ear='chorus'] .right{right:-7px;transform:scaleX(-1) rotate(-9deg)}",
			".dsa-moony-pet[data-moony-ear='hush'] .dsa-moony-ear{top:-28px;width:37px;height:32px;border-radius:70% 30% 62% 38%;clip-path:polygon(0 10%,100% 0,78% 100%,18% 85%)}.dsa-moony-pet[data-moony-ear='hush'] .left{left:-9px;transform:rotate(-22deg)}.dsa-moony-pet[data-moony-ear='hush'] .right{right:-9px;transform:scaleX(-1) rotate(-22deg)}",
			".dsa-moony-pet[data-moony-ear='loop'] .dsa-moony-ear{top:-31px;width:33px;height:38px;border:5px solid var(--moony-rim);border-radius:50%;background:transparent;box-shadow:inset 0 0 8px var(--moony-light-soft),0 0 9px var(--moony-rim-soft)}.dsa-moony-pet[data-moony-ear='loop'] .dsa-moony-ear::before{inset:5px;background:transparent}.dsa-moony-pet[data-moony-ear='loop'] .left{left:-4px;transform:rotate(-18deg)}.dsa-moony-pet[data-moony-ear='loop'] .right{right:-4px;transform:rotate(18deg)}",
			".dsa-moony-pet[data-moony-ear='bass'] .dsa-moony-ear{top:-18px;width:31px;height:24px;border-radius:58% 42% 34% 28%}.dsa-moony-pet[data-moony-ear='bass'] .left{left:-2px;transform:rotate(-10deg)}.dsa-moony-pet[data-moony-ear='bass'] .right{right:-2px;transform:rotate(10deg)}",
			".dsa-moony-pet[data-moony-ear='vinyl'] .dsa-moony-ear{top:-23px;width:29px;height:29px;border-radius:50%;box-shadow:inset 0 0 0 5px rgba(34,20,26,.18),inset 0 0 0 7px var(--moony-light-soft),0 0 9px var(--moony-rim-soft)}.dsa-moony-pet[data-moony-ear='vinyl'] .left{left:-3px}.dsa-moony-pet[data-moony-ear='vinyl'] .right{right:-3px}",
			".dsa-moony-pet[data-moony-ear='pulse'] .dsa-moony-soft-halo{top:-25px;width:27px;height:45px}.dsa-moony-pet[data-moony-ear='echo'] .dsa-moony-soft-halo{top:-16px;width:39px;height:31px}.dsa-moony-pet[data-moony-ear='hush'] .dsa-moony-soft-halo{top:-26px;width:37px;height:30px}",
			".dsa-moony-tail{position:absolute;z-index:1;pointer-events:none;filter:drop-shadow(0 0 6px var(--moony-light-soft));transition:filter .5s}.dsa-moony-tail[data-moony-tail='orbit']{right:-8px;bottom:-5px;width:38px;height:32px;border:6px solid var(--moony-ear);border-left-color:transparent;border-radius:50%;transform:rotate(25deg)}",
			".dsa-moony-tail[data-moony-tail='comet']{right:-17px;bottom:5px;width:42px;height:17px;border-radius:70% 30% 70% 30%;background:linear-gradient(90deg,var(--moony-ear-highlight),var(--moony-ear));transform:rotate(24deg)}",
			".dsa-moony-tail[data-moony-tail='curl']{right:-7px;bottom:-6px;width:31px;height:31px;border:6px solid var(--moony-ear);border-left-color:transparent;border-radius:50%;transform:rotate(12deg)}",
			".dsa-moony-tail[data-moony-tail='needle']{right:-19px;bottom:2px;width:44px;height:27px;border-right:3px solid var(--moony-ear);border-bottom:3px solid var(--moony-ear);border-radius:0 0 17px 0;transform:rotate(10deg);transform-origin:10% 90%}.dsa-moony-tail[data-moony-tail='needle']::after{content:'';position:absolute;right:-4px;bottom:-4px;width:7px;height:7px;border-radius:50%;background:var(--moony-rim);box-shadow:0 0 6px var(--moony-light-soft)}",
			".dsa-moony-pet.dsa-agent-idle[data-moony-motion='float'] .dsa-moony-ear{animation:dsa-moony-idle-float 3.2s ease-in-out infinite alternate}.dsa-moony-pet.dsa-agent-idle[data-moony-motion='beat'] .dsa-moony-ear{animation:dsa-moony-idle-beat 1.15s ease-in-out infinite alternate}.dsa-moony-pet.dsa-agent-idle[data-moony-motion='orbit'] .dsa-moony-ear{animation:dsa-moony-idle-orbit 3.8s ease-in-out infinite alternate}.dsa-moony-pet.dsa-agent-idle[data-moony-motion='drift'] .dsa-moony-ear{animation:dsa-moony-idle-drift 4.2s ease-in-out infinite alternate}.dsa-moony-pet.dsa-agent-idle[data-moony-motion='scan'] .dsa-moony-ear{animation:dsa-moony-idle-scan 2.1s ease-in-out infinite alternate}.dsa-moony-pet.dsa-agent-idle[data-moony-motion='chorus'] .dsa-moony-ear{animation:dsa-moony-idle-chorus 2.7s ease-in-out infinite alternate}.dsa-moony-pet.dsa-agent-idle[data-moony-motion='hush'] .dsa-moony-ear{animation:dsa-moony-idle-hush 5s ease-in-out infinite alternate}.dsa-moony-pet.dsa-agent-idle[data-moony-motion='loop'] .dsa-moony-ear{animation:dsa-moony-idle-loop 2.6s ease-in-out infinite}.dsa-moony-pet.dsa-agent-idle[data-moony-motion='bass'] .dsa-moony-ear{animation:dsa-moony-idle-bass 2.2s ease-in-out infinite}.dsa-moony-pet.dsa-agent-idle[data-moony-motion='vinyl'] .dsa-moony-ear{animation:dsa-moony-idle-vinyl 4s linear infinite}",
			".dsa-moony-pet.dsa-agent-idle[data-moony-motion='orbit'] .dsa-moony-tail{animation:dsa-moony-idle-tail-orbit 2.8s ease-in-out infinite alternate}.dsa-moony-pet.dsa-agent-idle[data-moony-motion='drift'] .dsa-moony-tail{animation:dsa-moony-idle-tail-drift 3.6s ease-in-out infinite alternate}.dsa-moony-pet.dsa-agent-idle[data-moony-motion='chorus'] .dsa-moony-tail{animation:dsa-moony-idle-tail-chorus 1.4s ease-in-out infinite alternate}.dsa-moony-pet.dsa-agent-idle[data-moony-motion='vinyl'] .dsa-moony-tail{animation:dsa-moony-idle-tail-vinyl 4.8s ease-in-out infinite alternate}",
			".dsa-agent-running .dsa-moony-ear,.dsa-agent-waiting .dsa-moony-ear,.dsa-agent-failed .dsa-moony-ear,.dsa-agent-review .dsa-moony-ear{border-color:var(--moony-signal);filter:drop-shadow(0 0 5px var(--moony-signal))}",
			".dsa-moony-pet[data-moony-soft-glow='true'] .dsa-moony-ear{filter:none}",
			".dsa-agent-running .dsa-moony-ear{animation:dsa-moony-running .52s ease-in-out infinite alternate}.dsa-agent-running .dsa-moony-ear.right{animation-direction:alternate-reverse}.dsa-agent-waiting .dsa-moony-ear{animation:dsa-moony-waiting 1.4s ease-in-out infinite}.dsa-agent-failed .dsa-moony-ear{animation:dsa-moony-failed .24s linear 3}.dsa-agent-review .dsa-moony-ear{animation:dsa-moony-review 1s ease-in-out infinite alternate}",
			".dsa-agent-running .dsa-moony-tail{animation:dsa-moony-tail-sway .52s ease-in-out infinite alternate}.dsa-agent-waiting .dsa-moony-tail{animation:dsa-moony-tail-listen 1.4s ease-in-out infinite}.dsa-agent-failed .dsa-moony-tail{animation:dsa-moony-tail-failed .24s linear 3}.dsa-agent-review .dsa-moony-tail{animation:dsa-moony-tail-review 1s ease-in-out infinite alternate}",
			".dsa-moony-pet[data-moony-motion='float'].singing .dsa-moony-rhythm{animation:dsa-moony-dance-classic-body 1.6s ease-in-out infinite}.dsa-moony-pet[data-moony-motion='float'].singing .dsa-moony-ear{animation:dsa-moony-dance-classic-ear .8s cubic-bezier(.45,0,.55,1) infinite}",
			".dsa-moony-pet[data-moony-motion='beat'].singing .dsa-moony-rhythm{animation:dsa-moony-dance-pulse-body .72s ease-in-out infinite}.dsa-moony-pet[data-moony-motion='beat'].singing .dsa-moony-ear{animation:dsa-moony-dance-pulse-ear .36s cubic-bezier(.2,.85,.35,1) infinite alternate}.dsa-moony-pet[data-moony-motion='beat'].singing .dsa-moony-ear.right{animation-delay:-.36s}",
			".dsa-moony-pet[data-moony-motion='orbit'].singing .dsa-moony-rhythm{animation:dsa-moony-dance-echo-body 1.8s ease-in-out infinite}.dsa-moony-pet[data-moony-motion='orbit'].singing .dsa-moony-ear{animation:dsa-moony-dance-echo-ear 1.4s cubic-bezier(.2,.75,.35,1) infinite}.dsa-moony-pet[data-moony-motion='orbit'].singing .dsa-moony-ear.left{animation-delay:-.36s}.dsa-moony-pet[data-moony-motion='orbit'].singing .dsa-moony-ear.right{animation-delay:-.18s}.dsa-moony-pet[data-moony-motion='orbit'].singing .dsa-moony-tail{animation:dsa-moony-dance-echo-tail 1.4s cubic-bezier(.2,.75,.35,1) infinite}",
			".dsa-moony-pet[data-moony-motion='drift'].singing .dsa-moony-rhythm{animation:dsa-moony-dance-drift-body 3.6s ease-in-out infinite}.dsa-moony-pet[data-moony-motion='drift'].singing .dsa-moony-ear{animation:dsa-moony-dance-drift-ear 3.2s ease-in-out infinite}.dsa-moony-pet[data-moony-motion='drift'].singing .dsa-moony-ear.right{animation-delay:-1.6s}.dsa-moony-pet[data-moony-motion='drift'].singing .dsa-moony-tail{animation:dsa-moony-dance-drift-tail 3.8s cubic-bezier(.22,.8,.32,1) infinite}",
			".dsa-moony-pet[data-moony-motion='scan'].singing .dsa-moony-rhythm{animation:dsa-moony-dance-spark-body 2.4s ease-in-out infinite}.dsa-moony-pet[data-moony-motion='scan'].singing .dsa-moony-ear{animation:dsa-moony-dance-spark-ear 2.4s ease-in-out infinite}.dsa-moony-pet[data-moony-motion='scan'].singing .dsa-moony-ear::after{content:'';position:absolute;left:50%;top:-5px;width:9px;height:9px;border-radius:50%;background:var(--moony-rim);box-shadow:0 0 5px var(--moony-rim),0 0 14px var(--moony-rim),0 0 24px var(--moony-light-soft);translate:-50% 0;opacity:0;pointer-events:none;animation:dsa-moony-dance-spark-flash 2.4s linear infinite}",
			".dsa-moony-pet[data-moony-motion='chorus'].singing .dsa-moony-rhythm{animation:dsa-moony-dance-chorus-body 4.8s ease-in-out infinite}.dsa-moony-pet[data-moony-motion='chorus'].singing .dsa-moony-ear{animation:dsa-moony-dance-chorus-ear 4.8s ease-in-out infinite}.dsa-moony-pet[data-moony-motion='chorus'].singing .dsa-moony-ear.right{animation-delay:-.18s}.dsa-moony-pet[data-moony-motion='chorus'].singing .dsa-moony-tail{animation:dsa-moony-dance-chorus-tail 4.8s ease-in-out infinite}",
			".dsa-moony-pet[data-moony-motion='hush'].singing .dsa-moony-rhythm{animation:dsa-moony-dance-hush-body 4.8s ease-in-out infinite}.dsa-moony-pet[data-moony-motion='hush'].singing .dsa-moony-ear{animation:dsa-moony-dance-hush-ear 4.8s ease-in-out infinite}.dsa-moony-pet[data-moony-motion='hush'].singing .dsa-moony-ear.right{animation-delay:-2.4s}",
			".dsa-moony-pet[data-moony-motion='loop'].singing .dsa-moony-rhythm{animation:dsa-moony-dance-loop-body 1.8s ease-in-out infinite}.dsa-moony-pet[data-moony-motion='loop'].singing .dsa-moony-ear{animation:dsa-moony-dance-loop-ear .9s ease-in-out infinite}.dsa-moony-pet[data-moony-motion='loop'].singing .dsa-moony-ear.right{animation-delay:-.45s}",
			".dsa-moony-pet[data-moony-motion='bass'].singing .dsa-moony-rhythm{animation:dsa-moony-dance-bass-body 1.4s cubic-bezier(.2,.7,.25,1) infinite}.dsa-moony-pet[data-moony-motion='bass'].singing .dsa-moony-ear{animation:dsa-moony-dance-bass-ear 1.4s cubic-bezier(.2,.7,.25,1) infinite}",
			".dsa-moony-pet[data-moony-motion='vinyl'].singing .dsa-moony-rhythm{animation:dsa-moony-dance-vinyl-body 3.6s ease-in-out infinite}.dsa-moony-pet[data-moony-motion='vinyl'].singing .dsa-moony-ear{animation:dsa-moony-dance-vinyl-ear 3.6s linear infinite}.dsa-moony-pet[data-moony-motion='vinyl'].singing .dsa-moony-tail{animation:dsa-moony-dance-vinyl-tail 3.6s ease-in-out infinite alternate}",
			"@keyframes dsa-moony-dance-classic-body{0%,100%{translate:0 0}25%{translate:0 -1px}50%{translate:0 0}75%{translate:0 -2px}}@keyframes dsa-moony-dance-classic-ear{0%,100%{rotate:-2deg;translate:0 0}50%{rotate:2deg;translate:0 -2px}}",
			"@keyframes dsa-moony-dance-pulse-body{0%,100%{translate:0 0;scale:1}50%{translate:0 -2px;scale:1.015}}@keyframes dsa-moony-dance-pulse-ear{from{rotate:-5deg;translate:0 3px;scale:.97 1}to{rotate:6deg;translate:0 -5px;scale:1 1.04}}",
			"@keyframes dsa-moony-dance-echo-body{0%,100%{translate:0 0}35%{translate:-1px -1px}70%{translate:1px -2px}}@keyframes dsa-moony-dance-echo-ear{0%,18%,100%{rotate:-3deg;translate:0 1px}38%{rotate:7deg;translate:0 -4px}58%{rotate:1deg;translate:0 -1px}}@keyframes dsa-moony-dance-echo-tail{0%,18%,100%{rotate:-6deg;translate:0 1px}38%{rotate:8deg;translate:1px -2px}58%{rotate:2deg;translate:0 0}}",
			"@keyframes dsa-moony-dance-drift-body{0%,100%{translate:-1px 1px;rotate:-1deg}50%{translate:2px -4px;rotate:1.5deg}}@keyframes dsa-moony-dance-drift-ear{0%,100%{rotate:-3deg;translate:0 1px}50%{rotate:4deg;translate:1px -2px}}@keyframes dsa-moony-dance-drift-tail{0%,100%{rotate:-7deg;translate:-1px 2px}58%{rotate:11deg;translate:3px -3px}76%{rotate:6deg;translate:2px -1px}}",
			"@keyframes dsa-moony-dance-spark-body{0%,100%{translate:0 0;scale:1}4%{translate:0 -3px;scale:1.025}10%{translate:0 0;scale:1}52%{translate:0 -1px}}@keyframes dsa-moony-dance-spark-ear{0%,100%{rotate:-2deg;translate:0 0}4%{rotate:7deg;translate:0 -4px}10%{rotate:0;translate:0 -1px}52%{rotate:2deg;translate:0 -2px}}@keyframes dsa-moony-dance-spark-flash{0%,3%,10%,100%{opacity:0;scale:.4}4%,7%{opacity:1;scale:1.35}}",
			"@keyframes dsa-moony-dance-chorus-body{0%,25%,50%,100%{translate:0 0;scale:1}12.5%,37.5%{translate:0 -2px;scale:1.01}62.5%,87.5%{translate:0 -5px;scale:1.035}75%{translate:0 1px;scale:1.01}}@keyframes dsa-moony-dance-chorus-ear{0%,25%,50%,100%{rotate:-3deg;translate:0 0}12.5%,37.5%{rotate:4deg;translate:0 -2px}62.5%,87.5%{rotate:10deg;translate:0 -6px}75%{rotate:-7deg;translate:0 1px}}@keyframes dsa-moony-dance-chorus-tail{0%,25%,50%,100%{rotate:-5deg;translate:0 1px}12.5%,37.5%{rotate:5deg;translate:0 -1px}62.5%{rotate:13deg;translate:2px -3px}75%{rotate:-10deg;translate:-1px 2px}87.5%{rotate:10deg;translate:1px -3px}}",
			"@keyframes dsa-moony-dance-hush-body{0%,100%{translate:0 0;scale:1}50%{translate:0 -1px;scale:1.012}}@keyframes dsa-moony-dance-hush-ear{0%,100%{rotate:-1deg;translate:0 0;scale:1}50%{rotate:1deg;translate:0 -1px;scale:1.01}}",
			"@keyframes dsa-moony-dance-loop-body{0%,100%{translate:0 0}50%{translate:0 -2px}}@keyframes dsa-moony-dance-loop-ear{0%,100%{rotate:-5deg;scale:1}50%{rotate:5deg;scale:1.04}}",
			"@keyframes dsa-moony-dance-bass-body{0%,58%,100%{translate:0 1px;scale:1 .98}68%{translate:0 -3px;scale:1.035 1.02}80%{translate:0 0;scale:1}}@keyframes dsa-moony-dance-bass-ear{0%,58%,100%{rotate:-2deg;translate:0 2px}68%{rotate:4deg;translate:0 -3px}82%{rotate:0;translate:0 0}}",
			"@keyframes dsa-moony-dance-vinyl-body{0%,100%{translate:0 0}50%{translate:0 -2px}}@keyframes dsa-moony-dance-vinyl-ear{0%,100%{rotate:-10deg}50%{rotate:10deg}}@keyframes dsa-moony-dance-vinyl-tail{from{rotate:-5deg;translate:0 1px}to{rotate:9deg;translate:1px -2px}}",
			"@keyframes dsa-moony-idle-float{from{rotate:-2deg}to{rotate:2deg}}@keyframes dsa-moony-idle-beat{from{translate:0 0}to{translate:0 -2px}}@keyframes dsa-moony-idle-orbit{from{rotate:-2deg}to{rotate:3deg}}@keyframes dsa-moony-idle-drift{from{translate:0 0}to{translate:0 2px}}@keyframes dsa-moony-idle-scan{from{rotate:-1deg}to{rotate:3deg}}@keyframes dsa-moony-idle-chorus{from{translate:0 0}to{translate:0 -2px}}@keyframes dsa-moony-idle-hush{from{scale:1}to{scale:.98}}@keyframes dsa-moony-idle-loop{0%,100%{rotate:-2deg}50%{rotate:2deg}}@keyframes dsa-moony-idle-bass{0%,100%{translate:0 1px}50%{translate:0 -1px}}@keyframes dsa-moony-idle-vinyl{0%,100%{rotate:-8deg}50%{rotate:8deg}}@keyframes dsa-moony-idle-tail-orbit{from{rotate:-7deg}to{rotate:7deg}}@keyframes dsa-moony-idle-tail-drift{from{translate:0 0}to{translate:1px -2px}}@keyframes dsa-moony-idle-tail-chorus{from{rotate:-2deg}to{rotate:5deg}}@keyframes dsa-moony-idle-tail-vinyl{from{rotate:-4deg}to{rotate:6deg}}",
			"@keyframes dsa-moony-phase-flow{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}",
			"@keyframes dsa-moony-running{from{rotate:-7deg}to{rotate:7deg}}@keyframes dsa-moony-waiting{0%,100%{translate:-1px 0}50%{translate:2px 1px}}@keyframes dsa-moony-failed{0%,100%{translate:0 0}25%{translate:-2px 0}75%{translate:2px 0}}@keyframes dsa-moony-review{from{translate:0 0}to{translate:0 -3px}}",
			"@keyframes dsa-moony-tail-sway{from{rotate:-5deg}to{rotate:7deg}}@keyframes dsa-moony-tail-listen{0%,100%{translate:0 0}50%{translate:0 -2px}}@keyframes dsa-moony-tail-failed{0%,100%{translate:0 0}25%{translate:-2px 0}75%{translate:2px 0}}@keyframes dsa-moony-tail-review{from{translate:0 0}to{translate:0 -2px}}",
			".dsa-moony-menu{position:absolute;right:0;top:48px;z-index:30;width:224px;max-height:min(420px,calc(100vh - 120px));overflow-y:auto;overscroll-behavior:contain;padding:6px;border:1px solid rgba(255,255,255,.2);border-radius:12px;background:rgba(21,22,31,.96);box-shadow:0 14px 34px rgba(0,0,0,.48);backdrop-filter:blur(18px);display:grid;gap:3px;scrollbar-width:thin}",
			".dsa-share{width:28px;padding:0;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.07);color:rgba(255,255,255,.9);border-radius:9px;text-shadow:none}",
			".dsa-share:hover{background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.3)}",
			".dsa-share.active{background:rgba(96,165,250,.2);border-color:rgba(96,165,250,.5);color:#93c5fd}",
			".dsa-share-menu{position:absolute;right:0;top:48px;z-index:30;width:244px;padding:10px;border:1px solid rgba(255,255,255,.2);border-radius:12px;background:rgba(21,22,31,.96);box-shadow:0 14px 34px rgba(0,0,0,.48);backdrop-filter:blur(18px)}",
			".dsa-share-x{position:absolute;top:8px;right:8px;width:22px;height:22px;border:none;background:transparent;color:rgba(255,255,255,.6);border-radius:7px;cursor:pointer;font-size:12px;line-height:1;display:flex;align-items:center;justify-content:center;z-index:2}",
			".dsa-share-x:hover{background:rgba(255,255,255,.12);color:#fff}",
			".dsa-share-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;padding-right:26px}",
			".dsa-share-cover{width:42px;height:42px;border-radius:8px;object-fit:cover;flex:none;background:rgba(255,255,255,.08)}",
			".dsa-share-meta{flex:1;min-width:0}",
			".dsa-share-meta strong{display:block;font-size:12.5px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dsa-share-meta small{display:block;font-size:10.5px;color:rgba(255,255,255,.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}",
			".dsa-share-link{margin-bottom:8px;padding:6px 8px;border-radius:8px;background:rgba(255,255,255,.08);font-size:10.5px;color:rgba(255,255,255,.75);word-break:break-all;max-height:44px;overflow-y:auto;line-height:1.4;scrollbar-width:thin}",
			".dsa-share-row{display:flex;align-items:center;gap:6px;margin-bottom:8px}",
			".dsa-share-copy{flex:1;border:1px solid rgba(96,165,250,.45);background:rgba(96,165,250,.14);color:#93c5fd;border-radius:9px;font-size:11.5px;padding:6px 0;cursor:pointer;font-weight:600}",
			".dsa-share-copy:hover{background:rgba(96,165,250,.24)}",
			".dsa-share-copy.on{border-color:rgba(52,211,153,.5);background:rgba(52,211,153,.14);color:#6ee7b7}",
			".dsa-share-qr-wrap{display:flex;flex-direction:column;align-items:center;gap:5px;padding-top:8px;border-top:1px solid rgba(255,255,255,.1)}",
			".dsa-share-qr{width:132px;height:132px;border-radius:8px;background:#fff;padding:6px}",
			".dsa-share-qr-wrap small{font-size:10px;color:rgba(255,255,255,.5)}",
			".dsa-share-qr-wrap.fail small{color:rgba(255,255,255,.4)}",
			"@media (prefers-reduced-motion:reduce){.dsa-moony-rhythm,.dsa-moony-ear,.dsa-moony-ear::after,.dsa-moony-tail,.dsa-moony-phase-gap{animation:none!important}}"
		].join("\n");
		var CSS = [
			"#dsh-alger-root{position:fixed;left:0;top:0;z-index:2147483000;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;user-select:none;color:#fff}",
			".dsa-card{width:" + WIDTH + "px;border-radius:16px;overflow:hidden;background:linear-gradient(135deg,rgba(255,255,255,0.10),rgba(255,255,255,0.03)),rgba(13,15,24,0.66);backdrop-filter:blur(22px) saturate(160%);-webkit-backdrop-filter:blur(22px) saturate(160%);border:1px solid rgba(255,255,255,0.16);box-shadow:0 14px 40px rgba(0,0,0,0.42),inset 0 1px 0 rgba(255,255,255,0.16)}",
			".dsa-drag{cursor:grab}.dsa-drag:active{cursor:grabbing}",
			".dsa-header{display:flex;align-items:center;gap:9px;padding:8px 10px}",
			".dsa-cover{flex:none;width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:17px;box-shadow:inset 0 0 0 1px rgba(255,255,255,0.22),0 4px 12px rgba(0,0,0,0.35);overflow:hidden}",
			".dsa-cover img{width:100%;height:100%;object-fit:cover}",
			".dsa-meta{flex:1;min-width:0}",
			".dsa-title{font-size:13px;font-weight:600;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 4px rgba(0,0,0,0.4)}",
			".dsa-artist{font-size:10.5px;line-height:14px;color:rgba(255,255,255,0.75);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dsa-actions{flex:none;display:flex;align-items:center;gap:2px}",
			".dsa-btn{flex:none;width:26px;height:26px;border:none;border-radius:8px;background:transparent;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:13px;padding:0;text-shadow:0 1px 3px rgba(0,0,0,0.35)}",
			".dsa-btn:hover{background:rgba(255,255,255,0.16)}",
			".dsa-btn:disabled{opacity:0.35;cursor:not-allowed}",
			".dsa-btn-primary{width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,rgba(255,255,255,0.95),rgba(255,255,255,0.72));color:#11131f;font-size:14px;box-shadow:0 4px 14px rgba(0,0,0,0.35)}",
			".dsa-btn-primary:hover{filter:brightness(1.05)}",
			".dsa-mode{font-size:10px;min-width:32px;padding:0 3px;color:rgba(255,255,255,0.85)}",
			".dsa-mode.has-fav{color:#fca5a5}",
			".dsa-mode-icon{width:24px;height:24px;color:rgba(255,255,255,0.8)}",
			".dsa-shape-wrap{position:relative;display:flex;align-items:stretch;border-radius:9px;background:linear-gradient(135deg,#fbbf24,#f97316);box-shadow:0 0 10px rgba(251,146,60,0.55),0 2px 8px rgba(0,0,0,0.3);transition:filter .15s,box-shadow .15s}.dsa-shape-wrap:hover{filter:brightness(1.08);box-shadow:0 0 16px rgba(251,146,60,0.8),0 2px 10px rgba(0,0,0,0.35)}",
			".dsa-shape{font-size:11px;font-weight:700;width:auto;min-width:42px;padding:0 7px;border-radius:9px 0 0 9px;color:#1c1200}.dsa-shape-arrow{width:22px;border-left:1px solid rgba(89,48,0,.25);border-radius:0 9px 9px 0;color:#1c1200;font-size:10px}.dsa-shape:hover,.dsa-shape-arrow:hover{background:rgba(255,255,255,.2)}",
			".dsa-moony-option{width:100%;height:42px;border:1px solid transparent;border-radius:9px;background:transparent;color:#fff;display:flex;align-items:center;gap:8px;padding:5px 7px;text-align:left;cursor:pointer}.dsa-moony-option:hover{background:rgba(255,255,255,.09)}.dsa-moony-option.on{border-color:rgba(251,191,36,.5);background:rgba(251,146,60,.13)}",
			".dsa-moony-option-copy{min-width:0;flex:1;display:flex;flex-direction:column;line-height:1.15}.dsa-moony-option-copy strong{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dsa-moony-option-copy small{margin-top:2px;font-size:9px;color:rgba(255,255,255,.58)}.dsa-moony-option-check{width:14px;color:#fbbf24;font-size:12px;text-align:center}",
			".dsa-moony-auto{width:100%;height:34px;margin-top:4px;border:1px solid rgba(255,255,255,.14);border-radius:9px;background:rgba(255,255,255,.04);color:rgba(255,255,255,.7);display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 10px;text-align:left;cursor:pointer}.dsa-moony-auto:hover{background:rgba(255,255,255,.09)}.dsa-moony-auto.on{border-color:rgba(251,191,36,.5);color:#fbbf24}.dsa-moony-auto-copy{font-size:10.5px}.dsa-moony-auto-check{font-size:10px;flex:none;color:rgba(255,255,255,.5)}.dsa-moony-auto.on .dsa-moony-auto-check{color:#fbbf24}",
			".dsa-body{padding:2px 12px 12px}",
			".dsa-controls{display:flex;align-items:center;justify-content:center;gap:3px;margin-top:4px}",
			".dsa-progress{display:flex;align-items:center;gap:7px;margin-top:6px}",
			".dsa-progress .tp{flex:none;min-width:30px;font-size:9.5px;color:rgba(255,255,255,0.55);text-align:center;font-variant-numeric:tabular-nums}",
			".dsa-range{flex:1;min-width:0;height:3px;-webkit-appearance:none;appearance:none;background:rgba(255,255,255,0.18);border-radius:3px;outline:none;cursor:pointer}",
			".dsa-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:11px;height:11px;border-radius:50%;background:#fff;border:none;box-shadow:0 1px 4px rgba(0,0,0,0.45)}",
			".dsa-range:disabled{opacity:0.4;cursor:not-allowed}",
			".dsa-lyrics{margin-top:7px;max-height:180px;overflow-y:auto;border:1px solid rgba(255,255,255,0.12);border-radius:10px;background:rgba(255,255,255,0.05);padding:5px 4px;scrollbar-width:thin;overscroll-behavior:contain}",
			".dsa-lyric-line{padding:3px 10px;font-size:11.5px;line-height:1.55;color:rgba(255,255,255,0.6);border-radius:8px;cursor:pointer;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:color .18s,background .18s}",
			".dsa-lyric-line:hover{background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.9)}",
			".dsa-lyric-line.cur{color:#fbbf24;font-weight:700;text-shadow:0 0 10px rgba(251,191,36,0.4)}",
			".dsa-lyric-line.cur.karaoke{color:rgba(255,255,255,0.5);text-shadow:none;font-weight:400}",
			".dsa-lyric-k-wrap{display:block;overflow:hidden;text-align:center}",
			".dsa-lyric-k-wrap.scroll{text-align:left}",
			".dsa-lyric-karaoke{display:inline-block;white-space:nowrap;background-image:linear-gradient(90deg,#fbbf24 0,#fbbf24 var(--k,0%),rgba(255,255,255,0.5) var(--k,0%),rgba(255,255,255,0.5) 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}",
			".dsa-lyric-empty{padding:14px 10px;text-align:center;font-size:11px;color:rgba(255,255,255,0.45)}",
			".dsa-lyric.active{color:#fbbf24;background:rgba(251,191,36,0.14)}",
			".dsa-search{display:flex;gap:6px;margin-top:8px}",
			".dsa-input{flex:1;min-width:0;background:rgba(255,255,255,0.13);border:1px solid rgba(255,255,255,0.22);border-radius:9px;color:#fff;font-size:12px;padding:5px 9px;outline:none;backdrop-filter:blur(6px)}",
			".dsa-input:focus{border-color:rgba(255,255,255,0.5);background:rgba(255,255,255,0.17)}",
			".dsa-input::placeholder{color:rgba(255,255,255,0.5)}",
			".dsa-go{flex:none;border:none;border-radius:9px;background:transparent;color:#fff;font-size:12px;padding:0 12px;cursor:pointer;font-weight:600}",
			".dsa-go:hover{background:rgba(255,255,255,0.16)}",
			".dsa-go:disabled{opacity:0.5;cursor:not-allowed}",
			".dsa-results{margin-top:6px;max-height:260px;overflow-y:auto}",
			".dsa-item{display:flex;align-items:center;gap:8px;padding:5px 7px;border-radius:8px;cursor:pointer}",
			".dsa-item:hover{background:rgba(255,255,255,0.10)}",
			".dsa-item .t{flex:1;min-width:0;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dsa-item .s{font-size:10px;color:rgba(255,255,255,0.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px}",
			".dsa-item .p{font-size:10px;color:rgba(255,255,255,0.45);flex:none}",
			".dsa-notice{margin-top:7px;padding:5px 9px;border-radius:8px;font-size:11px;line-height:1.45;background:rgba(245,158,11,0.16);border:1px solid rgba(245,158,11,0.35);color:#fcd34d}",
			".dsa-notice.ok{background:rgba(52,211,153,0.14);border-color:rgba(52,211,153,0.35);color:#6ee7b7}",
			".dsa-notice.err{background:rgba(239,68,68,0.14);border-color:rgba(239,68,68,0.35);color:#fca5a5}",
			".dsa-notice-action{margin-left:8px;border:0;background:transparent;color:inherit;font:inherit;font-weight:700;text-decoration:underline;cursor:pointer}",
			".dsa-fav-panel,.dsa-fav-picker{margin-top:8px;padding:8px;border:1px solid rgba(255,255,255,.16);border-radius:11px;background:rgba(10,12,20,.86);box-shadow:0 8px 24px rgba(0,0,0,.28)}",
			".dsa-fav-panel-head{display:flex;align-items:center;justify-content:space-between;font-size:12px}.dsa-fav-close{border:0;background:transparent;color:rgba(255,255,255,.55);cursor:pointer}",
			".dsa-fav-tabs{display:flex;gap:4px;margin-top:7px;overflow-x:auto;padding-bottom:2px}.dsa-fav-tabs button,.dsa-fav-tools button,.dsa-fav-panel-actions button{flex:none;border:1px solid rgba(255,255,255,.16);border-radius:7px;background:rgba(255,255,255,.06);color:rgba(255,255,255,.75);font-size:10px;padding:3px 7px;cursor:pointer}.dsa-fav-tabs button.active{border-color:#f87171;color:#fca5a5;background:rgba(239,68,68,.13)}",
			".dsa-fav-tools{display:flex;gap:4px;margin-top:6px;flex-wrap:wrap}.dsa-fav-tools button:disabled{opacity:.35;cursor:not-allowed}",
			".dsa-fav-songs{max-height:150px;overflow-y:auto;margin-top:6px}.dsa-fav-song{display:flex;align-items:center;gap:5px;padding:4px 3px;border-top:1px solid rgba(255,255,255,.06);font-size:10.5px}.dsa-fav-song .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsa-fav-song .s{max-width:70px;color:rgba(255,255,255,.48);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsa-fav-song button{border:0;background:transparent;color:#fca5a5;font-size:9.5px;cursor:pointer}",
			".dsa-fav-panel-title{font-size:12px;font-weight:700;margin-bottom:6px}.dsa-fav-check{display:flex;align-items:center;gap:7px;padding:4px 2px;font-size:11px;cursor:pointer}.dsa-fav-check input{accent-color:#ef4444}.dsa-fav-empty{padding:10px 4px;text-align:center;color:rgba(255,255,255,.45);font-size:10px}.dsa-fav-panel-actions{display:flex;justify-content:flex-end;gap:5px;margin-top:7px}.dsa-fav-panel-actions button.primary{background:#ef4444;border-color:#ef4444;color:#fff}",
			".dsa-ready{display:flex;align-items:center;gap:8px;margin-top:8px;padding:6px 9px;border-radius:9px;background:rgba(255,255,255,0.06);font-size:11px;color:rgba(255,255,255,0.8)}",
			".dsa-ready .dot{width:8px;height:8px;border-radius:50%;flex:none}",
			".dsa-ready .dot.ok{background:#34d399;box-shadow:0 0 6px rgba(52,211,153,0.8)}",
			".dsa-ready .dot.wait{background:#f59e0b;box-shadow:0 0 6px rgba(245,158,11,0.8)}",
			".dsa-ready .dot.bad{background:#ef4444;box-shadow:0 0 6px rgba(239,68,68,0.8)}",
			".dsa-ready .txt{flex:1;min-width:0}",
			".dsa-ready .act{flex:none;border:none;border-radius:8px;background:linear-gradient(135deg,#f59e0b,#f97316);color:#1c1200;font-size:11px;font-weight:700;padding:4px 10px;cursor:pointer}",
			".dsa-ready .act:hover{filter:brightness(1.1)}",
			".dsa-ready .act:disabled{opacity:0.5;cursor:wait}",
			".dsa-mini{display:flex;align-items:center;gap:8px;padding:7px 12px;border-radius:999px;cursor:pointer;background:linear-gradient(135deg,rgba(255,255,255,0.10),rgba(255,255,255,0.03)),rgba(13,15,24,0.7);backdrop-filter:blur(18px) saturate(160%);-webkit-backdrop-filter:blur(18px) saturate(160%);border:1px solid rgba(255,255,255,0.16);box-shadow:0 10px 30px rgba(0,0,0,0.4);white-space:nowrap;max-width:280px}",
			".dsa-mini .dot{width:8px;height:8px;border-radius:50%;flex:none}",
			".dsa-mini .dot.ok{background:#34d399;box-shadow:0 0 6px rgba(52,211,153,0.8)}",
			".dsa-mini .dot.wait{background:#f59e0b;box-shadow:0 0 6px rgba(245,158,11,0.8)}",
			".dsa-mini .dot.bad{background:#ef4444;box-shadow:0 0 6px rgba(239,68,68,0.8)}",
			".dsa-mini .t{font-size:12px;font-weight:600;max-width:170px;overflow:hidden;text-overflow:ellipsis}",
			".dsa-mini .hint{font-size:10px;color:rgba(255,255,255,0.6)}",
			".dsa-fav{color:rgba(255,255,255,0.92)}.dsa-fav:hover{background:rgba(255,255,255,0.14);color:#fff}",
			".dsa-fav.active{color:#ef4444;text-shadow:0 0 8px rgba(239,68,68,0.7)}.dsa-fav.active:hover{background:rgba(239,68,68,0.16);color:#ef4444}",
			".dsa-conn{flex:none;display:flex;align-items:center;gap:5px;border:1px solid rgba(255,255,255,0.22);border-radius:999px;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.85);font-size:10.5px;padding:3px 9px;cursor:pointer;white-space:nowrap}",
			".dsa-conn:hover{background:rgba(255,255,255,0.16)}",
			".dsa-conn:disabled{opacity:0.55;cursor:wait}",
			".dsa-conn .dot{width:7px;height:7px;border-radius:50%;flex:none}",
			".dsa-conn .dot.ok{background:#34d399;box-shadow:0 0 6px rgba(52,211,153,0.9)}",
			".dsa-conn .dot.wait{background:#f59e0b;box-shadow:0 0 6px rgba(245,158,11,0.9)}",
			".dsa-conn .dot.bad{background:#ef4444;box-shadow:0 0 6px rgba(239,68,68,0.9)}",
			".dsa-types{display:flex;gap:4px;margin-top:7px}",
			".dsa-type{flex:1;border:1px solid rgba(255,255,255,0.18);background:transparent;color:rgba(255,255,255,0.75);border-radius:8px;font-size:11px;padding:3px 0;cursor:pointer}",
			".dsa-type.active{background:rgba(255,255,255,0.16);border-color:rgba(255,255,255,0.4);color:#fff;font-weight:600}",
			".dsa-type:hover{background:rgba(255,255,255,0.08)}",
			".dsa-close-results{flex:none;width:22px;border:1px solid rgba(255,255,255,0.14);background:transparent;color:rgba(255,255,255,0.5);border-radius:8px;font-size:10px;padding:3px 0;cursor:pointer}",
			".dsa-close-results:hover{background:rgba(255,255,255,0.1);color:#fff}",
			".dsa-queue{margin-top:8px;border:1px solid rgba(255,255,255,0.12);border-radius:10px;background:rgba(255,255,255,0.05)}",
			".dsa-queue-title{display:flex;align-items:center;gap:6px;padding:6px 9px;font-size:11px;font-weight:600;color:rgba(255,255,255,0.85);cursor:pointer}",
			".dsa-queue-title .cnt{color:rgba(255,255,255,0.5);font-weight:400}",
			".dsa-queue-title .fold{margin-left:auto;color:rgba(255,255,255,0.5)}",
			".dsa-qclear-row{padding:3px 6px 4px;border-top:1px dashed rgba(255,255,255,0.08);margin-top:2px;text-align:center}",
			".dsa-qclear{border:none;background:transparent;color:rgba(255,255,255,0.35);font-size:9.5px;padding:2px 8px;cursor:pointer;border-radius:6px}",
			".dsa-qclear:hover{color:rgba(255,255,255,0.6);background:rgba(255,255,255,0.06)}",
			".dsa-qclear:disabled{opacity:0.3;cursor:not-allowed}",
			".dsa-queue-list{max-height:130px;overflow-y:auto;padding:0 6px 6px}",
			".dsa-qitem{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:7px;font-size:11px;color:rgba(255,255,255,0.8);cursor:pointer}",
			".dsa-qitem:hover{background:rgba(255,255,255,0.08)}",
			".dsa-qitem.cur{background:rgba(59,130,246,0.22);color:#fff}",
			".dsa-qitem.sel{box-shadow:inset 0 0 0 1px rgba(255,255,255,0.5);background:rgba(255,255,255,0.12);color:#fff}",
			".dsa-qitem .n{flex:none;width:16px;text-align:right;color:rgba(255,255,255,0.4);font-size:10px}",
			".dsa-qitem .t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dsa-qitem .s{font-size:10px;color:rgba(255,255,255,0.5);max-width:80px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dsa-qremove{flex:none;width:18px;height:18px;padding:0;border:0;border-radius:50%;background:transparent;color:rgba(255,255,255,.55);font-size:15px;line-height:16px;cursor:pointer;opacity:0;pointer-events:none;transition:opacity .14s,background .14s}.dsa-qitem:hover .dsa-qremove,.dsa-qremove:focus-visible{opacity:1;pointer-events:auto}.dsa-qremove:hover{background:rgba(239,68,68,.2);color:#fca5a5}",
			".dsa-addall{margin-top:6px;width:100%;border:1px dashed rgba(255,255,255,0.25);background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.85);border-radius:8px;font-size:11px;padding:4px 0;cursor:pointer}",
			".dsa-addall:hover{background:rgba(255,255,255,0.12)}",
			".dsa-addall:disabled{opacity:0.5;cursor:not-allowed}",
			/* ---- 宠物（收起态）：宠物固定，气泡锚定在左/右侧（自动换边） ---- */
			".dsa-pet-wrap{position:fixed;z-index:2147483000;width:64px;height:64px;user-select:none}",
			".dsa-pet-scale{position:absolute;left:0;top:0;width:64px;height:64px;will-change:transform;transition:transform .12s ease-out}",
			".dsa-pet-bubble-pos{position:absolute;top:50%;transform:translateY(-50%);display:flex;align-items:center}",
			".dsa-pet-bubble-pos.right{left:74px}",
			".dsa-pet-bubble-pos.left{right:74px}",
			".dsa-pet-bubble{position:relative;background:rgba(13,15,24,0.9);border:1px solid rgba(255,255,255,0.22);border-radius:14px;padding:7px 12px;font-size:12px;line-height:1.4;color:#fff;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,0.35);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}",
			".dsa-pet-bubble.sing{animation:dsa-bubble-bob .5s ease-in-out infinite alternate}",
			".dsa-pet-bubble.notice{background:rgba(16,45,34,0.92);border-color:rgba(52,211,153,0.55);color:#a7f3d0;font-weight:600}",
			".dsa-pet-bubble-pos.right .dsa-pet-bubble.notice + .dsa-pet-bubble-tail,.dsa-pet-bubble.notice ~ .dsa-pet-bubble-tail{border-right-color:rgba(16,45,34,0.92)}",
			".dsa-pet-bubble-pos.left .dsa-pet-bubble.notice ~ .dsa-pet-bubble-tail{border-left-color:rgba(16,45,34,0.92)}",
			".dsa-pet-bubble .dsa-marquee{display:flex;width:max-content;animation-name:dsa-marquee;animation-timing-function:linear;animation-iteration-count:infinite;will-change:transform}",
			".dsa-pet-bubble .dsa-marquee span{white-space:nowrap;padding-right:28px}",
			"@keyframes dsa-marquee{from{transform:translateX(0)}to{transform:translateX(-50%)}}",
			".dsa-pet-bubble-tail{position:absolute;top:50%;width:0;height:0;border-top:6px solid transparent;border-bottom:6px solid transparent;transform:translateY(-50%)}",
			".dsa-pet-bubble-pos.right .dsa-pet-bubble-tail{left:-7px;border-right:7px solid rgba(13,15,24,0.9)}",
			".dsa-pet-bubble-pos.left .dsa-pet-bubble-tail{right:-7px;border-left:7px solid rgba(13,15,24,0.9)}",
			".dsa-pet-notes{position:absolute;top:-24px;right:-10px;display:flex;gap:2px;font-size:14px;color:#fbbf24;pointer-events:none;text-shadow:0 1px 4px rgba(0,0,0,0.5)}",
			".dsa-pet-notes span{animation:dsa-note-float 1.3s ease-in-out infinite}",
			".dsa-pet-notes span:nth-child(2){animation-delay:.35s}",
			".dsa-pet-notes span:nth-child(3){animation-delay:.7s}",
			"@keyframes dsa-bubble-bob{from{transform:translateY(0)}to{transform:translateY(-2px)}}",
			"@keyframes dsa-note-float{0%{transform:translateY(0);opacity:0}30%{opacity:1}100%{transform:translateY(-14px);opacity:0}}"
		].concat(MOONY_CSS).join("\n");

		function injectCss() {
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-alger-music";
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/* ---------- 图标（内联 SVG 字符） ---------- */
		var ICONS = {
			play: "▶",
			pause: "❚❚",
			prev: "⏮",
			next: "⏭",
			collapse: "—",
			search: "🔍"
		};

		// 播放模式图标（0=列表循环 / 1=单曲循环 / 2=随机），通用描边 SVG，三态切换
		var MODE_ICON_PATHS = [
			// 列表循环
			["M17 1l4 4-4 4", "M3 11V9a4 4 0 0 1 4-4h14", "M7 23l-4-4 4-4", "M21 13v2a4 4 0 0 1-4 4H3"],
			// 单曲循环（带 1）
			["M17 1l4 4-4 4", "M3 11V9a4 4 0 0 1 4-4h14", "M7 23l-4-4 4-4", "M21 13v2a4 4 0 0 1-4 4H3", "M11 10l1-1v4"],
			// 随机（交叉箭头）
			["M16 3h5v5", "M4 20L21 3", "M21 16v5h-5", "M15 15l6 6", "M4 4l5 5"]
		];
		function PlayModeIcon(props) {
			var paths = MODE_ICON_PATHS[(props && props.mode ? props.mode : 0) % 3];
			return h("svg", {
				width: 15,
				height: 15,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 2,
				strokeLinecap: "round",
				strokeLinejoin: "round"
			}, paths.map(function (d, i) {
				return h("path", { key: i, d: d });
			}));
		}

		// 常见「分享」图标（三个节点连线，Feather share-2 风格），与播放模式图标同为描边 SVG
		function ShareIcon() {
			return h("svg", {
				width: 15,
				height: 15,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 2,
				strokeLinecap: "round",
				strokeLinejoin: "round"
			}, [
				h("circle", { key: "a", cx: 18, cy: 5, r: 3 }),
				h("circle", { key: "b", cx: 6, cy: 12, r: 3 }),
				h("circle", { key: "c", cx: 18, cy: 19, r: 3 }),
				h("line", { key: "l1", x1: 8.59, y1: 13.51, x2: 15.42, y2: 17.49 }),
				h("line", { key: "l2", x1: 15.41, y1: 6.51, x2: 8.59, y2: 10.49 })
			]);
		}

		function readyDot(state) {
			if (!state) return "wait";
			if (!state.musicApiUp) return "bad";
			return "ok";
		}

		function readyText(state) {
			if (!state) return "连接中…";
			if (!state.musicApiUp) return "音乐服务未就绪";
			return "已就绪";
		}

		function needSetup(state) {
			return state && !state.musicApiUp;
		}

		/* ---------- 宠物显示状态（浮窗与侧边栏开关共享） ---------- */
		var petVis = { hidden: false, subs: [] };
		function setPetHidden(v) {
			petVis.hidden = !!v;
			petVis.subs.forEach(function (fn) { fn(petVis.hidden); });
		}
		function onPetHidden(fn) {
			petVis.subs.push(fn);
			return function () { petVis.subs = petVis.subs.filter(function (f) { return f !== fn; }); };
		}

		/* ---------- 侧边栏底部宠物开关（与一键重启同组） ---------- */
		function PetToggleButton() {
			var [hidden, setHidden] = React.useState(petVis.hidden);
			React.useEffect(function () { return onPetHidden(setHidden); }, []);
			return h("div", {
				style: { padding: "4px 2px 2px", width: "100%" }
			}, h("button", {
				type: "button",
				title: hidden ? "激活月宝儿音乐宠物" : "关闭月宝儿音乐宠物",
				onClick: function () { setPetHidden(!petVis.hidden); },
				style: {
					width: "100%",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					gap: 6,
					padding: "8px 12px",
					fontFamily: "inherit",
					fontSize: 13,
					lineHeight: "20px",
					color: hidden ? "var(--dsw-alias-label-secondary, #666)" : "#60a5fa",
					background: hidden ? "transparent" : "rgba(96,165,250,.12)",
					border: hidden
						? "1px solid var(--dsw-alias-border-2, rgba(128,128,128,.25))"
						: "1px solid rgba(96,165,250,.4)",
					borderRadius: 10,
					cursor: "pointer"
				}
			}, "♪ 音乐宠物"));
		}

		/* ---------- 浮动播放器 ---------- */
		function MusicPlayer() {
			var [state, setState] = React.useState(null);
			var stateRef = React.useRef(null); // 供 audio 事件回调读取最新状态（避免闭包过期）
			stateRef.current = state;
			var [petId, setPetId] = React.useState(function () { return readStoredMoonyId(getLocalStorage()); });
			var [autoMatch, setAutoMatch] = React.useState(function () { return readAutoMatch(getLocalStorage()); });
			// 自动匹配变身：信号（歌词密度/音频分析）确定角色后【直接切换】宠物并开口说明。
			// 用户开启自动匹配即表示交给月宝儿管理，不再询问；手动选角会关闭自动匹配。
			var applyPetSwitch = function (target) {
				if (!target) return;
				var cur = readStoredMoonyId(getLocalStorage());
				if (cur === target) return;
				setPetId(writeStoredMoonyId(getLocalStorage(), target));
				var roleLines = {
					"bass": "这低音，我来扛！",
					"pulse": "节拍来了，跟上我！",
					"hush": "嘘…安静听。",
					"chorus": "一起唱～",
					"echo": "这首歌，有点回忆的味道。",
					"drift": "漂在这旋律里吧。",
					"classic": "经典的味道，正合我意。",
					"spark": "新声音，探索起来！",
					"loop": "循环再循环～",
					"vinyl": "黑胶质感，怀旧一下。"
				};
				post("/dsh-alger/say", { text: roleLines[target] || ("这首适合我 " + getMoony(target).name + " ！") }).catch(function () { /* 忽略 */ });
			};
			var selectMoony = function (id) {
				setPetId(writeStoredMoonyId(getLocalStorage(), id));
				// 手动选择角色 → 关闭自动匹配（用户显式意愿优先）
				setAutoMatch(false);
				writeAutoMatch(getLocalStorage(), false);
			};
			// 宠物缩放（滚轮在宠物上调整；容器缩放不破坏内部动画）
			var [petScale, setPetScale] = React.useState(function () { return readPetScale(getLocalStorage()); });
			var onPetWheel = function (e) {
				e.preventDefault();
				e.stopPropagation();
				var next = Math.round((petScale + (e.deltaY < 0 ? PET_SCALE_STEP : -PET_SCALE_STEP)) * 10) / 10;
				next = Math.max(PET_SCALE_MIN, Math.min(PET_SCALE_MAX, next));
				setPetScale(next);
				try { if (getLocalStorage()) getLocalStorage().setItem(STORE_PET_SCALE, String(next)); } catch { /* ignore */ }
			};
			// 默认宠物形态（收起）：每次打开先看到宠物，点击才切换播放器
			var [collapsed, setCollapsed] = React.useState(true);
			var [shapeMenuOpen, setShapeMenuOpen] = React.useState(false);
			var [pos, setPos] = React.useState(null);
			var posRef = React.useRef(null);
			var dragRef = React.useRef(null);
			var cardRef = React.useRef(null);
			var [query, setQuery] = React.useState("");
			var [searchType, setSearchType] = React.useState(1); // 1=歌曲 1000=歌单
			var [searched, setSearched] = React.useState(false); // 是否已搜索过（控制歌曲/歌单 tab 显隐）
			var [searching, setSearching] = React.useState(false);
			var [results, setResults] = React.useState(null);
			var [queueOpen, setQueueOpen] = React.useState(false);
			var [selectedIdx, setSelectedIdx] = React.useState(null); // 播放列表"单击选中"的行
			var [favOptimistic, setFavOptimistic] = React.useState(null); // 收藏乐观状态（null=跟随真实状态）
			var [favoritesOpen, setFavoritesOpen] = React.useState(false);
			var [favoriteData, setFavoriteData] = React.useState(null);
			var [activeFavoriteId, setActiveFavoriteId] = React.useState("all");
			var [membershipSong, setMembershipSong] = React.useState(null);
			var heartTimerRef = React.useRef(null);
			var heartTriggeredRef = React.useRef(false);
			// 关闭/激活与侧边栏开关按钮共享（pub/sub）
			var [hidden, setHidden] = React.useState(petVis.hidden);
			React.useEffect(function () { return onPetHidden(setHidden); }, []);
			var [notice, setNotice] = React.useState(null); // {kind:'ok'|'err'|'', text}
			var [busy, setBusy] = React.useState(false);
			var recommendRequestRef = React.useRef(0);
			var [lrc, setLrc] = React.useState(null); // [{t,text}] 当前歌歌词
			var [lyricsOpen, setLyricsOpen] = React.useState(false); // 展开视图歌词面板
			var [shareOpen, setShareOpen] = React.useState(false); // 微信分享面板
			var [kScroll, setKScroll] = React.useState(false); // 卡拉OK当前行横向跟随（文字超宽时滚动窗口跟高亮边缘）
			var lyricsRef = React.useRef(null); // 歌词面板滚动容器
			var lyricManualAt = React.useRef(0); // 用户手动滚动时间戳（5s 内暂停自动跟随）
			var [artistInfo, setArtistInfo] = React.useState(null); // {id, avatar}
			var [ambientColor, setAmbientColor] = React.useState(null); // 当前唱片取色；失败时由角色本色回退
			var noticeTimer = React.useRef(null);
			var lrcFor = React.useRef(null); // 已取歌词的 songId
			var artistFor = React.useRef(null); // 已取头像的 artistId
			var suppressClickRef = React.useRef(false);

			var flash = function (kind, text) {
				setNotice({ kind: kind || "", text: text });
				if (noticeTimer.current) clearTimeout(noticeTimer.current);
				noticeTimer.current = setTimeout(function () { setNotice(null); }, 6000);
			};

			var refresh = React.useCallback(function () {
				getState().then(function (s) { setState(s); }).catch(function () { /* 忽略瞬时失败 */ });
			}, []);

			// 轮询
			React.useEffect(function () {
				refresh();
				var timer = setInterval(refresh, POLL_MS);
				return function () { clearInterval(timer); };
			}, [refresh]);

			// ---------- 内置 <audio> 播放引擎 ----------
			// 服务端状态机是唯一事实来源：轮询发现 currentUrl 变化就切换播放；
			// 音频事件（进度/结束/播放状态）定时上报回服务端。
			var audioRef = React.useRef(null);
			var lastUrlRef = React.useRef(null); // 已加载的直链，避免重复播放
			var lastSongIdRef = React.useRef(null); // 已识别的歌曲（听歌记忆重播检测）
			var saidSongRef = React.useRef(null); // 已开口说过的歌曲（每首只说一次）
			var [prog, setProg] = React.useState({ pos: 0, dur: 0 }); // 进度条显示（audio 实时事件驱动）
			var [buffering, setBuffering] = React.useState(false); // waiting/stalled 到 canplay/playing 的真实缓冲窗口
			var seekingRef = React.useRef(false); // 拖动中不刷新滑块位置
			// 创建 audio 元素（惰性，仅一次）
			React.useEffect(function () {
				if (audioRef.current) return;
				var audio = document.createElement("audio");
				audio.style.display = "none";
				document.body.appendChild(audio);
				var syncProg = function () {
					if (seekingRef.current) return;
					setProg({ pos: audio.currentTime || 0, dur: audio.duration || 0 });
				};
				audio.addEventListener("timeupdate", syncProg);
				audio.addEventListener("durationchange", syncProg);
				audio.addEventListener("loadedmetadata", syncProg);
				audio.addEventListener("ended", function () {
					// 自然结束：按播放模式处理（单曲循环本地重播；列表循环/随机交给服务端 next）
					reportPlayback({ playing: false, position: 0, duration: audio.duration || 0, ready: true });
					var mode = stateRef.current && typeof stateRef.current.playMode === "number" ? stateRef.current.playMode : 0;
					if (mode === 1) {
						try { audio.currentTime = 0; var rp = audio.play(); if (rp && typeof rp.catch === "function") rp.catch(function () {}); } catch { /* ignore */ }
						return;
					}
					command("next").then(function () { setTimeout(refresh, 300); }).catch(function () {});
				});
				audio.addEventListener("error", function () {
					reportPlayback({ playing: false, position: 0, duration: audio.duration || 0, ready: true });
				});
				var unbindBuffering = bindAudioBuffering(audio, setBuffering);
				audioRef.current = audio;
				// 音频分析器（听歌自动匹配宠物）惰性挂载：默认不挂，避免重路由静音风险；
				// 开启时（含页面加载后勾选）由 ensureAnalyzer 挂载。
				if (readAutoMatch(getLocalStorage())) ensureAnalyzer();
				return function () {
					if (analyzerTimerRef.current) clearInterval(analyzerTimerRef.current);
					analyzerTimerRef.current = null;
					analyzerRef.current = null;
					unbindBuffering();
					try { audio.pause(); audio.src = ""; } catch { /* ignore */ }
					if (audio.parentNode) audio.parentNode.removeChild(audio);
					audioRef.current = null;
				};
			}, []);

			// 系统媒体控制：注册媒体键响应（控制中心/耳机/键盘；一次性注册，全部静默降级）
			React.useEffect(function () {
				if (typeof navigator === "undefined" || !navigator.mediaSession) return;
				var ms = navigator.mediaSession;
				var mediaCommand = function (action) { command(action).catch(function () { /* 忽略 */ }); };
				var handlers = {
					play: function () { mediaCommand("play"); },
					pause: function () { mediaCommand("pause"); },
					previoustrack: function () { mediaCommand("prev"); },
					nexttrack: function () { mediaCommand("next"); },
					seekto: function (d) {
						if (seekToRef.current) seekToRef.current(d && typeof d.seekTime === "number" ? d.seekTime : 0);
					}
				};
				Object.keys(handlers).forEach(function (name) {
					try { ms.setActionHandler(name, handlers[name]); } catch { /* 不支持的动作忽略 */ }
				});
				return function () {
					Object.keys(handlers).forEach(function (name) {
						try { ms.setActionHandler(name, null); } catch { /* ignore */ }
					});
				};
			}, []);

			// 自动匹配状态引用（供音频分析器读取最新值，避免闭包过期）
			var autoMatchRef = React.useRef(autoMatch);
			autoMatchRef.current = autoMatch;
			// 自动匹配候选与稳定计数
			var candidateRef = React.useRef(null);
			var stableCountRef = React.useRef(0);
			var currentSongRef = React.useRef(null); // 当前分析中的歌曲（切歌时重置）
			var recentRef = React.useRef([]); // 最近几次采样（取能量最高者当特征，前奏的低能量采样会被主旋律覆盖）
			var analyzerRef = React.useRef(null); // 已挂载的采样函数（createMediaElementSource 对同一元素只能调一次）
			var analyzerTimerRef = React.useRef(null);
			// 惰性挂载音频分析器并启动采样定时器。行为：识别到稳定风格后
			// 识别到稳定风格后【直接切换】宠物并开口说明（不询问——开启自动匹配即代表授权）。
			// 即时性：不跳过前奏——音频数据就绪即采样（800ms 间隔），连续 2 次
			// 命中同一角色即推荐（约 1.6–2.4s 出结果）；用「最近 3 次采样中能量
			// 最高的一次」作为特征，前奏低能量段不会压住主旋律。
			var ensureAnalyzer = function () {
				var audio = audioRef.current;
				if (!audio || analyzerRef.current) return;
				if (typeof window === "undefined" || !window.AudioContext) return;
				var sampleAudio = attachAudioAnalyzer(audio);
				if (!sampleAudio) return;
				analyzerRef.current = sampleAudio;
				analyzerTimerRef.current = setInterval(function () {
					if (!autoMatchRef.current) return;
					var song = stateRef.current && stateRef.current.playing ? stateRef.current.playing.song : null;
					if (!song || !audio.src) return;
					// 切歌时重置候选与推荐，避免旧歌特征误匹配新歌
					if (currentSongRef.current !== song.id) {
						currentSongRef.current = song.id;
						candidateRef.current = null;
						stableCountRef.current = 0;
						recentRef.current = [];
												return;
					}
					var feat = sampleAudio();
					if (!feat) return;
					recentRef.current.push(feat);
					if (recentRef.current.length > 3) recentRef.current.shift();
					// 取能量最高的采样作为当前特征（前奏铺垫能量低，会被主旋律覆盖）
					var eff = recentRef.current[0];
					for (var i = 1; i < recentRef.current.length; i++) {
						if (recentRef.current[i].energy > eff.energy) eff = recentRef.current[i];
					}
					var target = moonyForAudio(eff);
					if (!target) { stableCountRef.current = 0; return; }
					// 连续 N 次命中同一角色才推荐（避免特征波动导致推荐频繁跳动）
					if (candidateRef.current === target) stableCountRef.current += 1;
					else { candidateRef.current = target; stableCountRef.current = 1; }
					if (stableCountRef.current >= 2) {
						stableCountRef.current = 0;
						applyPetSwitch(target); // 直接切换，不询问（用户已授权自动匹配）
					}
				}, 800);
			};
			// 自动匹配开关变化：开启时确保分析器挂载（修复「勾选后不生效」——
			// 分析器不再只在页面加载时按初始状态挂载）；关闭时清掉当前推荐
			React.useEffect(function () {
				if (autoMatch) ensureAnalyzer();
			}, [autoMatch]);

			var seekEndTimerRef = React.useRef(null);
			var seekToRef = React.useRef(null); // 系统媒体键 seek 回调（避免闭包过期）
			// 跳转到指定秒数（进度条拖动 / 歌词行点击 / 媒体键共用；直接用 audio.currentTime，随后由 timeupdate 接管）
			var seekTo = function (v) {
				var audio = audioRef.current;
				if (!audio || typeof v !== "number" || !Number.isFinite(v)) return;
				seekingRef.current = true;
				try { audio.currentTime = v; } catch { /* ignore */ }
				setProg({ pos: v, dur: audio.duration || prog.dur });
				clearTimeout(seekEndTimerRef.current);
				seekEndTimerRef.current = setTimeout(function () { seekingRef.current = false; }, 600);
			};
			seekToRef.current = seekTo;
			// 进度条：拖动 seek
			var onSeek = function (e) {
				seekTo(Number(e.target.value));
			};

			// 状态轮询 → 直链变化时播放 / 播放状态同步
			React.useEffect(function () {
				var audio = audioRef.current;
				if (!audio) return;
				var st = state || {};
				var url = st.currentUrl || null;
				// 无当前曲（清空播放列表等）：停止并释放
				if (!url) {
					if (lastUrlRef.current) lastUrlRef.current = null;
					if (!audio.paused) audio.pause();
					if (audio.src) { try { audio.removeAttribute("src"); audio.load(); } catch { /* ignore */ } }
					return;
				}
				if (url !== lastUrlRef.current) {
					lastUrlRef.current = url;
					audio.src = url;
					audio.volume = typeof st.volume === "number" ? st.volume : 0.8;
					var p = audio.play();
					if (p && typeof p.catch === "function") p.catch(function () { /* 浏览器阻止自动播放时静默 */ });
				} else if (typeof st.volume === "number" && Math.abs(audio.volume - st.volume) > 0.01) {
					audio.volume = st.volume;
				}
				// 播放/暂停同步（服务端控制 → 浏览器执行）
				var stPlaying = Boolean(st.playing && st.playing.isPlaying);
				if (stPlaying && audio.paused && audio.src) {
					var pp = audio.play();
					if (pp && typeof pp.catch === "function") pp.catch(function () {});
				} else if (!stPlaying && !audio.paused && audio.src) {
					audio.pause();
				}
				// 系统媒体控制：同步元数据与播放状态
				syncMediaSession(st.playing ? st.playing.song : null, stPlaying);
				// 听歌记忆：切到常听歌曲时月宝儿开口（每首歌只说一次）
				var sidNow = st.playing && st.playing.song ? st.playing.song.id : null;
				if (sidNow && sidNow !== lastSongIdRef.current && sidNow !== saidSongRef.current) {
					lastSongIdRef.current = sidNow;
					post("/dsh-alger/habits", { action: "song", songId: sidNow }).then(function (r) {
						if (r && r.ok && r.frequent) {
							saidSongRef.current = sidNow;
							post("/dsh-alger/say", { text: "这首你最近常听呢（第 " + r.plays + " 次了）～" }).catch(function () {});
						}
					}).catch(function () {});
				} else if (!sidNow) {
					lastSongIdRef.current = null;
				}
			}, [state]);

			// 进度上报（2s 一次，供服务端状态/模型读取）
			React.useEffect(function () {
				var timer = setInterval(function () {
					var audio = audioRef.current;
					if (!audio) return;
					reportPlayback({
						position: audio.currentTime || 0,
						duration: audio.duration || 0,
						playing: !audio.paused && !audio.ended,
						ready: true
					});
				}, 2000);
				return function () { clearInterval(timer); };
			}, []);

			// 听歌记忆：深夜提醒轮询（服务端判定并设置宠物通知，客户端 60s 问一次）
			React.useEffect(function () {
				var timer = setInterval(function () {
					post("/dsh-alger/habits", { action: "night" }).catch(function () {});
				}, 60000);
				return function () { clearInterval(timer); };
			}, []);

			// 恢复位置 / 默认右下角
			React.useEffect(function () {
				try {
					var x = localStorage.getItem(STORE_X);
					var y = localStorage.getItem(STORE_Y);
					if (x !== null && y !== null) {
						var p = { x: Number(x), y: Number(y) };
						if (Number.isFinite(p.x) && Number.isFinite(p.y)) { posRef.current = p; setPos(p); return; }
					}
				} catch { /* ignore */ }
				posRef.current = null;
				setPos(null);
			}, []);

			// 视口内钳制（仅展开态生效：收起态宠物锚点不受展开卡尺寸影响，否则会被每轮轮询往左拽）
			React.useEffect(function () {
				if (collapsed) return;
				var height = cardRef.current ? cardRef.current.offsetHeight : 260;
				var p = posRef.current;
				if (!p) return;
				var clamped = {
					x: Math.max(4, Math.min(window.innerWidth - WIDTH - 4, p.x)),
					y: Math.max(4, Math.min(window.innerHeight - height - 4, p.y))
				};
				if (clamped.x !== p.x || clamped.y !== p.y) { posRef.current = clamped; setPos(clamped); }
			}, [collapsed, state]);

			// 拖动
			var onDragStart = function (event) {
				if (event.button !== 0) return;
				dragRef.current = {
					startX: event.clientX,
					startY: event.clientY,
					origX: posRef.current ? posRef.current.x : null,
					origY: posRef.current ? posRef.current.y : null,
					moved: false
				};
				var onMove = function (ev) {
					var drag = dragRef.current;
					if (!drag) return;
					var dx = ev.clientX - drag.startX;
					var dy = ev.clientY - drag.startY;
					if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
					drag.moved = true;
					suppressClickRef.current = true;
					var baseX = drag.origX !== null ? drag.origX : window.innerWidth - WIDTH - 18;
					var baseY = drag.origY !== null ? drag.origY : window.innerHeight - 120;
					posRef.current = { x: baseX + dx, y: baseY + dy };
					setPos(posRef.current);
				};
				var onUp = function () {
					window.removeEventListener("pointermove", onMove);
					window.removeEventListener("pointerup", onUp);
					var p = posRef.current;
					if (p) {
						try {
							localStorage.setItem(STORE_X, String(p.x));
							localStorage.setItem(STORE_Y, String(p.y));
						} catch { /* ignore */ }
					}
					dragRef.current = null;
				};
				window.addEventListener("pointermove", onMove);
				window.addEventListener("pointerup", onUp);
			};

			var toggleCollapsed = function () {
				setCollapsed(!collapsed);
			};
			var transformAsMoony = function (id) {
				selectMoony(id);
				setShapeMenuOpen(false);
				setCollapsed(true);
			};

			var runCommand = function (action) {
				if (!state || !state.musicApiUp) { flash("err", "音乐服务未就绪，请先点“连接”"); return; }
				command(action).then(function (r) {
					if (r && r.ok === false) flash("err", r.error || "命令失败");
					setTimeout(refresh, 400);
				}).catch(function () { flash("err", "命令发送失败"); });
			};

			// 收藏：乐观更新——点击立即变红/变白（不等轮询），不弹文字；命令失败才提示
			var onToggleFavorite = function () {
				if (!state || !state.musicApiUp || !playing) { flash("err", "没有正在播放的歌曲"); return; }
				var target = !(favOptimistic !== null ? favOptimistic : Boolean(state.favorite));
				setFavOptimistic(target);
				setTimeout(function () { setFavOptimistic(null); }, 2500); // 2.5s 后由轮询的真实状态接管
				command("toggle-favorite").then(function (r) {
					if (r && r.ok === false) { setFavOptimistic(null); flash("err", r.error || "收藏失败"); return; }
					setTimeout(refresh, 300);
				}).catch(function () { setFavOptimistic(null); flash("err", "收藏失败"); });
			};

			// 连接按钮：服务正常时完全隐藏（自动启动，无需操作）；异常时才显示恢复入口
			var needConn = Boolean(state && !state.musicApiUp);
			var connLabel = needConn ? "启动音乐服务" : null;
			var onConnClick = function () {
				if (!state || state.musicApiUp) return;
				onSetup();
			};

			// 推荐播放：不知道听什么时一键推荐
			var onRecommend = function () {
				if (!state || !state.musicApiUp) { flash("err", "音乐服务未就绪，请先点“连接”"); return; }
				var requestId = "recommend-" + Date.now() + "-" + (recommendRequestRef.current + 1);
				recommendRequestRef.current = requestId;
				setBusy(true);
				post("/dsh-alger/recommend", { requestId: requestId }).then(function (r) {
					if (recommendRequestRef.current !== requestId) return;
					setBusy(false);
					if (r && !r.ok) flash("err", (r && r.guidance) || (r && r.error) || "推荐失败");
					// 成功时结果由宠物气泡播报（服务端 notice）
					setTimeout(refresh, 600);
				}).catch(function () {
					if (recommendRequestRef.current !== requestId) return;
					setBusy(false);
					flash("err", "推荐失败");
				});
			};

			var loadFavoriteCollection = function (collectionId) {
				var id = collectionId || "all";
				setActiveFavoriteId(id);
				return favoritesApi({ action: "list", collectionId: id }).then(function (r) {
					if (!r || r.ok === false) throw new Error((r && r.error) || "读取收藏失败");
					setFavoriteData(r);
					return r;
				});
			};
			var openFavorites = function () {
				setFavoritesOpen(true);
				setMembershipSong(null);
				loadFavoriteCollection(activeFavoriteId).catch(function (error) { flash("err", error.message || "读取收藏失败"); });
			};
			var openMemberships = function (song) {
				if (!song) return;
				favoritesApi({ action: "list", collectionId: activeFavoriteId }).then(function (r) {
					if (!r || r.ok === false) throw new Error((r && r.error) || "读取收藏失败");
					setFavoriteData(r);
					setMembershipSong(song);
				}).catch(function (error) { flash("err", error.message || "读取收藏失败"); });
			};
			var saveMemberships = function (collectionIds) {
				if (!membershipSong) return;
				favoritesApi({ action: "set-memberships", songId: membershipSong.id, collectionIds: collectionIds }).then(function (r) {
					if (!r || r.ok === false) throw new Error((r && r.error) || "整理收藏失败");
					setMembershipSong(null);
					setFavOptimistic(true);
					setTimeout(function () { setFavOptimistic(null); }, 2500);
					if (favoritesOpen) loadFavoriteCollection(activeFavoriteId);
					setTimeout(refresh, 300);
				}).catch(function (error) { flash("err", error.message || "整理收藏失败"); });
			};
			var playFavoriteCollection = function (collectionId) {
				setBusy(true);
				favoritesApi({ action: "play", collectionId: collectionId }).then(function (r) {
					setBusy(false);
					if (!r || r.ok === false) { flash("err", (r && r.guidance) || (r && r.error) || "播放收藏失败"); return; }
					setFavoritesOpen(false);
					setQueueOpen(true);
					setTimeout(refresh, 500);
				}).catch(function () { setBusy(false); flash("err", "播放收藏失败"); });
			};
			var createFavoriteCollection = function () {
				var name = typeof window.prompt === "function" ? window.prompt("新收藏目录名称") : "";
				if (!name || !name.trim()) return;
				favoritesApi({ action: "create", name: name }).then(function (r) {
					if (!r || r.ok === false) throw new Error((r && r.error) || "新建失败");
					return loadFavoriteCollection(r.collection.id);
				}).catch(function (error) { flash("err", error.message || "新建失败"); });
			};
			var renameFavoriteCollection = function (collection) {
				var name = typeof window.prompt === "function" ? window.prompt("重命名收藏目录", collection.name) : "";
				if (!name || !name.trim() || name.trim() === collection.name) return;
				favoritesApi({ action: "rename", collectionId: collection.id, name: name }).then(function (r) {
					if (!r || r.ok === false) throw new Error((r && r.error) || "重命名失败");
					return loadFavoriteCollection(collection.id);
				}).catch(function (error) { flash("err", error.message || "重命名失败"); });
			};
			var deleteFavoriteCollection = function (collection) {
				if (typeof window.confirm === "function" && !window.confirm("删除目录“" + collection.name + "”？歌曲仍保留在全部收藏中。")) return;
				favoritesApi({ action: "delete", collectionId: collection.id }).then(function (r) {
					if (!r || r.ok === false) throw new Error((r && r.error) || "删除失败");
					return loadFavoriteCollection("all");
				}).catch(function (error) { flash("err", error.message || "删除失败"); });
			};
			var heartHandlers = createLongPressHandlers({
				timerRef: heartTimerRef,
				triggeredRef: heartTriggeredRef,
				onLongPress: function () { openMemberships(playing); },
				onClick: onToggleFavorite
			});

			var onSearch = function (forcedType) {
				var q = query.trim();
				if (!q) return;
				// 展开搜索时收起播放列表，给搜索结果腾空间（搜索区在播放列表上方）
				setQueueOpen(false);
				// 切换 tab 重搜时显式传 type，避免 setTimeout 闭包捕获旧的 searchType 导致搜错类型
				var t = typeof forcedType === "number" ? forcedType : searchType;
				setSearched(true);
				setSearching(true);
				setResults(null);
				searchMusic(q, t).then(function (r) {
					setSearching(false);
					if (!r || r.ok === false) { flash("err", (r && r.error) || "搜索失败"); setResults(null); return; }
					setResults(r.items || []);
				}).catch(function () { setSearching(false); flash("err", "搜索失败"); });
			};

			var switchType = function (type) {
				setSearchType(type);
				setResults(null);
				if (query.trim()) setTimeout(function () { onSearch(type); }, 0);
			};

			// 双击歌曲：追加到播放列表末尾并立即播放（不关闭搜索列表，可连续双击多首）
			var onPlaySong = function (item) {
				setBusy(true);
				queueApi(queuePayloadForSearchItem(item)).then(function (r) {
					if (!r || !r.ok) { setBusy(false); flash("err", (r && r.guidance) || (r && r.error) || "添加失败"); return; }
					// 追加后它位于队尾：queueLength-1
					var idx = (r.queueLength || 1) - 1;
					return queueApi({ action: "jump", index: idx }).then(function (jr) {
						setBusy(false);
						// 成功：播放列表已展开、当前曲高亮，界面直观可见，无需提示
						if (!jr || !jr.ok) flash("err", (jr && jr.guidance) || (jr && jr.error) || "播放失败");
						setQueueOpen(true); // 添加成功：自动展开播放列表展示新歌
						setTimeout(refresh, 600);
					});
				}).catch(function () { setBusy(false); flash("err", "添加失败"); });
			};

			var onAddAll = function () {
				var q = query.trim();
				if (!q) return;
				setBusy(true);
				queueApi({ action: "add-all", keyword: q, limit: 30 }).then(function (r) {
					if (!r || !r.ok) { setBusy(false); flash("err", (r && r.guidance) || (r && r.error) || "加入失败"); return; }
					setQueueOpen(true); // 一键加入：自动展开播放列表（数量变化直观可见，无需提示）
					// 当前没在播放时，自动从这批歌的第一首开始按顺序播
					if (!isPlaying) {
						var added = r.added || 0;
						var idx = (r.queueLength || added) - added;
						return queueApi({ action: "jump", index: idx }).then(function (jr) {
							setBusy(false);
							if (jr && !jr.ok) flash("err", (jr && jr.guidance) || (jr && jr.error) || "播放失败");
							setTimeout(refresh, 600);
						});
					}
					setBusy(false);
					setTimeout(refresh, 500);
				}).catch(function () { setBusy(false); flash("err", "加入失败"); });
			};

			// 双击歌单：整单追加到播放列表末尾并立即播放第一首（不关闭搜索列表）
			var onPlayPlaylist = function (item) {
				setBusy(true);
				queueApi({ action: "playlist-add", playlistId: item.id }).then(function (r) {
					if (!r || !r.ok) { setBusy(false); flash("err", (r && r.guidance) || (r && r.error) || "添加失败"); return; }
					// 加入前长度 = queueLength - added，歌单第一首即该下标
					var added = r.added || 0;
					var idx = (r.queueLength || added) - added;
					return queueApi({ action: "jump", index: idx }).then(function (jr) {
						setBusy(false);
						// 成功：播放列表已展开、歌单歌曲可见，无需提示
						if (!jr || !jr.ok) flash("err", (jr && jr.guidance) || (jr && jr.error) || "播放失败");
						setQueueOpen(true); // 歌单添加成功：自动展开播放列表
						setTimeout(refresh, 600);
					});
				}).catch(function () { setBusy(false); flash("err", "添加失败"); });
			};

			// 播放列表：单击选中、双击跳转播放（保留队列）
			var onQueueSelect = function (i) {
				setSelectedIdx(i === selectedIdx ? null : i);
			};
			var onQueueJump = function (i) {
				setBusy(true);
				queueApi({ action: "jump", index: i }).then(function (r) {
					setBusy(false);
					// 成功：播放列表当前曲高亮可见，无需提示
					if (!r || !r.ok) flash("err", (r && r.guidance) || (r && r.error) || "播放失败");
					setTimeout(refresh, 600);
				}).catch(function () { setBusy(false); flash("err", "播放失败"); });
			};

			var onSetup = function () {
				setBusy(true);
				flash("", "正在启动音乐服务…");
				setupApp("start").then(function (r) {
					setBusy(false);
					if (r && r.ok) flash("ok", "音乐服务已就绪，可以开始点歌了。");
					else flash("err", (r && r.steps && r.steps[r.steps.length - 1]) || "音乐服务启动失败");
					refresh();
				}).catch(function () { setBusy(false); flash("err", "音乐服务启动失败"); });
			};

			// 清空播放列表
			var onQueueClear = function () {
				setBusy(true);
				queueApi({ action: "clear" }).then(function (r) {
					setBusy(false);
					// 成功：列表清空、界面直观可见，无需提示
					if (!r || !r.ok) flash("err", (r && r.guidance) || (r && r.error) || "清空失败");
					setTimeout(refresh, 400);
				}).catch(function () { setBusy(false); flash("err", "清空失败"); });
			};

			var onQueueRemove = function (index) {
				queueApi({ action: "remove", index: index }).then(function (r) {
					if (!r || r.ok === false) { flash("err", (r && r.error) || "移除失败"); return; }
					setSelectedIdx(null);
					setNotice({ kind: "", text: "已从播放列表移除“" + ((r.removed && r.removed.name) || "歌曲") + "”", undoToken: r.token });
					if (noticeTimer.current) clearTimeout(noticeTimer.current);
					noticeTimer.current = setTimeout(function () { setNotice(null); }, 6000);
					setTimeout(refresh, 250);
				}).catch(function () { flash("err", "移除失败"); });
			};
			var onQueueUndo = function (token) {
				queueApi({ action: "undo-remove", token: token }).then(function (r) {
					if (!r || r.ok === false) { flash("err", (r && r.error) || "撤销失败"); return; }
					flash("ok", "已恢复到播放列表");
					setTimeout(refresh, 250);
				}).catch(function () { flash("err", "撤销已失效"); });
			};

			var onSearchKey = function (event) {
				if (event.key === "Enter") onSearch();
			};

			// 播放信息：state.playing = {ok, isPlaying, song:{...}}
			var remote = state && state.playing ? state.playing : null;
			var playing = remote && remote.song ? remote.song : null;
			var isPlaying = Boolean(remote && remote.isPlaying);
			var albumArtwork = playing && playing.albumPic ? playing.albumPic : null;
			var dot = readyDot(state);
			var title = playing ? playing.name : "未在播放";
			var artist = playing ? (playing.artists || "") : (state && state.musicApiUp ? "月宝儿 Moony" : "播放器未连接");
			var canControl = Boolean(state && state.musicApiUp);

			// 唱片环境光：小尺寸采样，跨域、解码或 Canvas 失败均静默回退角色本色。
			React.useEffect(function () {
				var active = true;
				if (!isPlaying || !albumArtwork) { setAmbientColor(null); return function () { active = false; }; }
				extractAmbientColor(albumArtwork).then(function (color) {
					if (active) setAmbientColor(color);
				});
				return function () { active = false; };
			}, [albumArtwork, isPlaying]);

			// 切歌时拉歌词与作者头像
			var songId = playing ? playing.id : null;
			var artistId = playing && playing.artistList && playing.artistList[0] ? playing.artistList[0].id : null;
			React.useEffect(function () {
				if (!songId || lrcFor.current === songId) return;
				lrcFor.current = songId;
				getLyric(songId).then(function (r) {
					var lines = r && r.lyric ? parseLrc(r.lyric) : [];
					setLrc(lines);
					// 即时推荐：歌词密度信号（现成数据、零额外请求、不依赖 Web Audio）
					if (autoMatchRef.current) {
						var durSec = 0;
						var st = stateRef.current;
						if (st && st.playback && st.playback.duration) durSec = Number(st.playback.duration);
						else if (playing && playing.dt) durSec = Number(playing.dt) / 1000;
						var p = petForLyricDensity(lines.length, durSec);
						if (p) applyPetSwitch(p);
					}
				}).catch(function () { setLrc([]); });
			}, [songId]);
			React.useEffect(function () {
				if (!artistId || artistFor.current === artistId) return;
				artistFor.current = artistId;
				getArtist(artistId).then(function (r) {
					if (r && r.ok && r.avatar) setArtistInfo({ id: artistId, avatar: r.avatar });
				}).catch(function () { /* 保留旧头像 */ });
			}, [artistId]);

			// 折叠态宠物：气泡换边状态（hooks 必须无条件声明，不能在 if 里）
			var bubbleRef = React.useRef(null);
			var [bubbleSide, setBubbleSide] = React.useState("right"); // 气泡在宠物右侧/左侧
			var [bubbleMaxW, setBubbleMaxW] = React.useState(230);
			var [overflowing, setOverflowing] = React.useState(false); // 歌词溢出→marquee 流动
			// 歌词行与宠物锚点（展开/收起都计算，供测宽 effect 使用）
			// 进度以本地 <audio> timeupdate 实时值为准：服务端上报值要经过「2s 上报 + 1.5s 轮询」
			// 两级延迟（最多滞后 ~3.5s），用来定位歌词会导致「一句唱完才显示字幕」；且切歌瞬间
			// audio 归零时服务端仍持旧曲位置，回退会闪出上一句——本地值无条件优先，服务端值仅作
			// 本地值缺失（极早期 state 未就绪）时的兜底。
			var position = prog && typeof prog.pos === "number"
				? prog.pos
				: (state && state.playback ? state.playback.position : null);
			var line = currentLrcLine(lrc, position);
			// 当前歌词行索引（面板高亮 + 自动滚动用）
			var curIdx = -1;
			if (lrc && lrc.length > 0 && typeof position === "number") {
				for (var li = 0; li < lrc.length; li++) {
					if (lrc[li].t <= position) curIdx = li; else break;
				}
			}
			// 卡拉 OK 填充比例（0~1）：只作用于当前行，随本地实时进度推进（常开，无开关）
			var karaokePct = curIdx >= 0 ? karaokeProgress(lrc, curIdx, position) : 0;
			// 宠物台词/通知优先（agent 播报），其次歌词
			var isNotice = Boolean(state && state.notice);
			var bubbleText = isNotice
				? state.notice
				: (line && line.text
					? line.text
					: (playing ? title + (artist ? " · " + artist : "") : "未在播放"));
			var petX = pos ? pos.x : window.innerWidth - 110; // 与渲染用的默认位置一致
			var marqueeDur = Math.max(6, Math.min(20, (bubbleText || "").length * 0.35)); // 流动速度随词长
			// 宠物固定不动；气泡锚定右侧，宠物靠右（右侧可用空间不足阈值）则稳定换到左侧。
			// 判定只看宠物几何位置，不随歌词长度变化——避免换边后又被下一句顶回右侧。
			React.useEffect(function () {
				if (!collapsed || !bubbleRef.current) return;
				var measure = function () {
					var el = bubbleRef.current;
					if (!el) return;
					var GAP = 12;
					var petW = Math.round(64 * petScale); // 缩放后的实际视觉宽度
					var MARGIN = 8;
					var MIN_RIGHT = 160; // 右侧可用空间低于此阈值就固定放左侧
					var spaceRight = window.innerWidth - (petX + petW + GAP) - MARGIN;
					var side = spaceRight >= MIN_RIGHT ? "right" : "left";
					var max = side === "right" ? spaceRight : petX - GAP - MARGIN;
					max = Math.max(120, Math.min(230, Math.floor(max)));
					setBubbleSide(function (prev) { return prev === side ? prev : side; });
					setBubbleMaxW(function (prev) { return prev === max ? prev : max; });
					// 歌词溢出检测（marquee）：不依赖气泡实际渲染宽度（左右两侧 abs-pos 收缩方式
					// 不同会导致 clientWidth 不可靠），直接对比【歌词文本自然宽度】vs【已知气泡宽度上限】。
					var inner = el.querySelector(".dsa-pet-bubble");
					var textEl = inner ? inner.querySelector("span") : null;
					var over = textEl ? textEl.scrollWidth > bubbleMaxW + 2 : false;
					setOverflowing(function (prev) { return prev === over ? prev : over; });
				};
				measure();
				window.addEventListener("resize", measure);
				return function () { window.removeEventListener("resize", measure); };
			}, [bubbleText, bubbleMaxW, collapsed, pos, petScale]);

			// 歌词面板纵向跟随（KTV 式）：当前行锚定在面板上方约 45% 处，随句内进度
			// 缓慢连续上移（零跳变），行自然越过锚点前完全不滚动（短歌词/开头几句不动）；
			// 用户手动翻阅（滚轮/触摸）后 5 秒内暂停自动跟随，不打扰手动浏览。
			React.useEffect(function () {
				if (!lyricsOpen || curIdx < 0) return;
				var panel = lyricsRef.current;
				if (!panel) return;
				if (Date.now() - lyricManualAt.current < 5000) return;
				var el = panel.querySelector('[data-i="' + curIdx + '"]');
				if (!el) return;
				var lineH = el.clientHeight;
				var panelH = panel.clientHeight;
				if (!(lineH > 0) || !(panelH > 0)) return;
				// 行在面板内容流中的位置：用 getBoundingClientRect 相减，避免 offsetParent
				// 坐标系错位（错位会导致过早滚动 + 目标过冲、高亮行被滚出视野）
				var contentTop = el.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop;
				var ANCHOR = 0.45;
				var desired = contentTop + karaokePct * lineH - panelH * ANCHOR;
				var max = Math.max(0, panel.scrollHeight - panelH);
				var target = Math.max(0, Math.min(max, desired));
				if (Math.abs(panel.scrollTop - target) > 0.5) {
					panel.scrollTo({ top: target, behavior: "smooth" });
				}
			}, [lyricsOpen, curIdx, karaokePct]);

			// 卡拉 OK 横向跟随：当前行文字超宽时，滚动窗口让高亮边缘始终可见（KTV 式），
			// 高亮走到行尾最后一个字时正好切到下一句；文字不超宽则保持居中、无需滚动。
			React.useEffect(function () {
				if (!lyricsOpen || curIdx < 0) return;
				var panel = lyricsRef.current;
				if (!panel) return;
				var lineEl = panel.querySelector('[data-i="' + curIdx + '"]');
				var wrap = lineEl && lineEl.querySelector(".dsa-lyric-k-wrap");
				var inner = wrap && wrap.querySelector(".dsa-lyric-karaoke");
				if (!wrap || !inner) { setKScroll(false); return; }
				var overflow = inner.scrollWidth > wrap.clientWidth + 1;
				setKScroll(overflow);
				if (overflow) {
					// 高亮边缘（已唱过的位置）保持在窗口 60% 处，窗口内文字随唱逐字左移
					var edge = karaokePct * inner.scrollWidth;
					var target = Math.max(0, Math.min(inner.scrollWidth - wrap.clientWidth, edge - wrap.clientWidth * 0.6));
					if (Math.abs(wrap.scrollLeft - target) > 1) wrap.scrollLeft = target;
				}
			}, [lyricsOpen, curIdx, karaokePct]);

			// 已关闭：浮动区域完全不渲染，仅保留侧边栏底部开关作为恢复入口。
			if (hidden) return null;

			// 折叠态：会唱歌的宠物（作者形象 + 歌词气泡）
			if (collapsed) {
				var petImg = artistInfo && artistInfo.avatar ? artistInfo.avatar : (playing ? playing.albumPic : null);
				// 气泡里是歌词（非 agent 播报）时套用卡拉 OK 渐变高亮（常开，与面板一致）
				var bubbleKaraoke = !isNotice && line && lrc && lrc.length > 0 && curIdx >= 0;
				var bubbleKaraokeStyle = bubbleKaraoke ? { "--k": Math.round(karaokePct * 1000) / 10 + "%" } : null;
				var bubbleKaraokeCls = bubbleKaraoke ? "dsa-lyric-karaoke" : "";
				// 气泡锚点随缩放补偿（气泡本身不缩放，锚定在缩放后的宠物边缘）
				var bubbleOffset = Math.round(74 * petScale);
				return h("div", {
					className: "dsa-pet-wrap",
					style: { left: petX, top: pos ? pos.y : window.innerHeight - 180 },
					onWheel: onPetWheel,
					title: "滚轮缩放宠物（" + Math.round(petScale * 100) + "%）"
				}, [
					h("div", {
						ref: bubbleRef,
						className: "dsa-pet-bubble-pos " + bubbleSide,
						style: bubbleSide === "left" ? { right: bubbleOffset } : { left: bubbleOffset }
					}, [
						h("div", {
							className: "dsa-pet-bubble" +
								(isPlaying ? " sing" : "") +
								(overflowing ? " flowing" : "") +
								(isNotice ? " notice" : ""),
							style: { maxWidth: bubbleMaxW }
						}, [
							overflowing
								? h("div", { className: "dsa-marquee", style: { animationDuration: marqueeDur + "s" } }, [
										h("span", { className: bubbleKaraokeCls, style: bubbleKaraokeStyle }, bubbleText || ""),
										h("span", { className: bubbleKaraokeCls, style: bubbleKaraokeStyle }, bubbleText || "")
									])
								: h("span", { className: bubbleKaraokeCls, style: bubbleKaraokeStyle }, bubbleText || "♪ ~ ♪ ~ ♪"),
							h("span", { className: "dsa-pet-bubble-tail" })
						])
					]),
					isPlaying
						? h("div", { className: "dsa-pet-notes" }, [h("span", null, "♪"), h("span", null, "♫"), h("span", null, "♪")])
						: null,
					// 缩放容器：transform scale 只作用于此层，内部 MoonyPet 动画在自己的坐标系照常播放
					h("div", {
						className: "dsa-pet-scale",
						style: { transform: "scale(" + petScale + ")", transformOrigin: "50% 100%" }
					}, [
						h(MoonyPet, {
						petId: petId, agentStatus: state && state.agentStatus, mediaUrl: petImg, isPlaying: isPlaying, ambientColor: ambientColor,
						playbackProgress: prog.dur > 0 ? prog.pos / prog.dur : 0, isBuffering: Boolean(playing && buffering),
							title: getMoony(petId).name + " · 展开播放器", onPointerDown: onDragStart,
							onClick: function (event) {
								event.stopPropagation();
								if (suppressClickRef.current) { suppressClickRef.current = false; return; }
								toggleCollapsed();
							}
						})
					])
				]);
			}

			return h("div", {
				ref: cardRef,
				style: { position: "fixed", left: pos ? pos.x : window.innerWidth - WIDTH - 18, top: pos ? pos.y : window.innerHeight - 300, zIndex: 2147483000 },
				
			}, [
				h("div", { className: "dsa-card" }, [
					// 头部（拖动手柄）：封面 + 标题 + 右侧[已连接][切换形态]
					h("div", { className: "dsa-header dsa-drag", onPointerDown: onDragStart }, [
						h("div", { className: "dsa-cover" },
							playing && playing.albumPic
								? h("img", { src: playing.albumPic, alt: "", draggable: false })
								: h("span", null, "🎵")
						),
						h("div", { className: "dsa-meta" }, [
							h("div", { className: "dsa-title", title: title }, title),
							h("div", { className: "dsa-artist" }, artist)
						]),
						h("div", { className: "dsa-actions" }, [
							// 音乐服务异常时的恢复入口（正常时隐藏）
							needConn
								? h("button", {
										className: "dsa-conn",
										disabled: busy,
										onClick: onConnClick
									}, [
										h("span", { className: "dot " + dot }),
										h("span", null, connLabel)
									])
								: null,
							// 分享：复制网易云公开链接/二维码，发微信给没装插件的好友也能听
							h("button", {
								className: "dsa-btn dsa-share" + (shareOpen ? " active" : ""),
								title: "分享这首歌（复制链接发微信）",
								disabled: !playing,
								onClick: function (e) {
									e.stopPropagation();
									setShapeMenuOpen(false);
									setShareOpen(!shareOpen);
								}
							}, h(ShareIcon)),
							// 分裂式变身：主按钮收起为当前宠物；箭头展开静态头像菜单。
							h("div", { className: "dsa-shape-wrap", onPointerDown: function (e) { e.stopPropagation(); } }, [
								h("button", {
									className: "dsa-btn dsa-shape", "data-moony-transform": true,
									title: "变身为 " + getMoony(petId).name,
									onClick: function (e) { e.stopPropagation(); setShapeMenuOpen(false); setShareOpen(false); setCollapsed(true); }
								}, "变身"),
								h("button", {
									className: "dsa-btn dsa-shape-arrow", "data-moony-menu-toggle": true,
									title: "选择其他 Moony", "aria-haspopup": "menu", "aria-expanded": shapeMenuOpen,
									onClick: function (e) { e.stopPropagation(); setShareOpen(false); setShapeMenuOpen(!shapeMenuOpen); }
								}, shapeMenuOpen ? "▴" : "▾")
							])
						])
					]),
					// 主体
					h("div", { className: "dsa-body" }, [
						// 传输控制（含收藏）
						h("div", { className: "dsa-controls" }, [
							h("button", {
								className: "dsa-btn dsa-mode" + (state && state.favoriteCount > 0 ? " has-fav" : ""),
								title: "打开收藏列表（" + (state && state.favoriteCount ? state.favoriteCount + " 首" : "暂无收藏") + "）",
								disabled: !canControl || busy,
								onClick: openFavorites
							}, "收藏"),
							h("button", { className: "dsa-btn dsa-mode", title: "推荐播放（不知道听什么时用）", disabled: !canControl || busy, onClick: onRecommend }, "推荐"),
														h("button", { className: "dsa-btn", title: "上一首", disabled: !canControl, onClick: function () { runCommand("prev"); } }, ICONS.prev),
							h("button", {
								className: "dsa-btn dsa-btn-primary",
								title: "播放/暂停",
								disabled: !canControl,
								onClick: function () { runCommand("toggle-play"); }
							}, isPlaying ? ICONS.pause : ICONS.play),
							h("button", { className: "dsa-btn", title: "下一首", disabled: !canControl, onClick: function () { runCommand("next"); } }, ICONS.next),
							h("button", {
								className: "dsa-btn dsa-fav" + ((favOptimistic !== null ? favOptimistic : Boolean(state && state.favorite)) ? " active" : ""),
								title: "单击收藏/取消收藏；长按整理到目录",
								disabled: !canControl || !playing,
								onPointerDown: heartHandlers.onPointerDown,
								onPointerUp: heartHandlers.onPointerUp,
								onPointerLeave: heartHandlers.onPointerLeave,
								onPointerCancel: heartHandlers.onPointerCancel,
								onClick: heartHandlers.onClick
							}, "♥"),
							h("button", {
								className: "dsa-btn dsa-mode-icon",
								title: "播放模式：单击切换（列表循环 / 单曲循环 / 随机）",
								disabled: !canControl,
								onClick: function () { runCommand("playmode"); }
							}, h(PlayModeIcon, { mode: state && typeof state.playMode === "number" ? state.playMode : 0 })),
							h("button", {
								className: "dsa-btn dsa-mode dsa-lyric" + (lyricsOpen ? " active" : ""),
								title: lyricsOpen ? "收起歌词面板" : "歌词面板（随播放滚动高亮）",
								disabled: !canControl || !playing,
								onClick: function () { setLyricsOpen(!lyricsOpen); }
							}, "词")
						]),
						// 进度条
						playing
							? h("div", { className: "dsa-progress" }, [
									h("span", { className: "tp" }, fmtClock(prog.pos)),
									h("input", {
										type: "range",
										className: "dsa-range",
										min: 0,
										max: prog.dur || 0,
										step: 0.1,
										value: Math.min(prog.pos, prog.dur || 0),
										disabled: !canControl,
										onChange: onSeek
									}),
									h("span", { className: "tp" }, fmtClock(prog.dur))
								])
							: null,
						// 歌词面板（轻量：随播放滚动高亮，点击某行跳转）
						lyricsOpen && playing
							? h("div", {
									ref: lyricsRef,
									className: "dsa-lyrics",
									onWheel: function () { lyricManualAt.current = Date.now(); },
									onTouchMove: function () { lyricManualAt.current = Date.now(); }
								},
									lrc && lrc.length > 0
										? lrc.map(function (ln, i) {
												var isCur = i === curIdx;
												// 卡拉 OK（常开）：单层文字用 background-clip:text 渐变填充——
												// 渐变断点随 --k 前进，天然逐字跟唱且不会发生双层文字错位；
												// 外层 k-wrap 在文字超宽时改为横向跟随滚动（KTV 式），
												// 保证高亮确实走到行尾最后一个字才切下一句
												var content = isCur
													? h("span", { className: "dsa-lyric-k-wrap" + (kScroll ? " scroll" : "") }, [
															h("span", {
																className: "dsa-lyric-karaoke",
																style: { "--k": Math.round(karaokePct * 1000) / 10 + "%" }
															}, ln.text || "\u00A0")
														])
													: (ln.text || "\u00A0");
												return h("div", {
													key: i,
													"data-i": i,
													className: "dsa-lyric-line" + (isCur ? " cur karaoke" : ""),
													title: "点击跳转到此句",
													onClick: function () { seekTo(ln.t); }
												}, content);
											})
										: h("div", { className: "dsa-lyric-empty" }, "暂无歌词"))
							: null,
						// 搜索点歌（未搜索时只显示输入框，不显示歌曲/歌单 tab）
						h("div", { className: "dsa-search" }, [
							h("input", {
								className: "dsa-input",
								placeholder: searchType === 1 ? "搜歌名/歌手，回车或点搜索" : "搜歌单名，回车或点搜索",
								value: query,
								disabled: busy,
								onChange: function (e) { setQuery(e.target.value); },
								onFocus: function () { setQueueOpen(false); }, // 聚焦搜索：收起播放列表
								onKeyDown: onSearchKey
							}),
							h("button", {
								className: "dsa-go",
								disabled: searching || busy || !query.trim(),
								onClick: onSearch
							}, searching
								? "…"
								: h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" }, [
										h("circle", { cx: 11, cy: 11, r: 7 }),
										h("line", { x1: 21, y1: 21, x2: 16.2, y2: 16.2 })
									])
							)
						]),
						// 搜索结果（搜索后出现歌曲/歌单 tab + 关闭按钮；歌曲：双击播放 + 加入；歌单：双击播放歌单 + 整单加入）
						searched
							? h("div", { className: "dsa-types" }, [
									h("button", { className: "dsa-type" + (searchType === 1 ? " active" : ""), onClick: function () { switchType(1); } }, "歌曲"),
									h("button", { className: "dsa-type" + (searchType === 1000 ? " active" : ""), onClick: function () { switchType(1000); } }, "歌单"),
									h("button", {
										className: "dsa-close-results",
										title: "收起搜索结果",
										onClick: function () {
											setResults(null);
											setSearched(false);
											setQuery("");
											setQueueOpen(true); // 关闭搜索：展开播放列表回到浏览态
										}
									}, "✕")
								])
							: null,
						results && results.length > 0
							? h("div", { className: "dsa-results" }, [
									searchType === 1
										? h("button", { className: "dsa-addall", disabled: busy, onClick: onAddAll }, "＋ 一键加入播放列表")
										: null,
									results.map(function (item) {
										if (searchType === 1) {
											return h("div", {
												key: item.id,
												className: "dsa-item",
												title: "双击：添加并播放 " + item.name,
												onDoubleClick: function () { onPlaySong(item); }
											}, [
												h("span", { className: "t" }, item.name),
												h("span", { className: "s" }, item.artists || ""),
												h("span", { className: "p" }, item.durationMs ? Math.floor(item.durationMs / 60000) + ":" + String(Math.floor(item.durationMs / 1000) % 60).padStart(2, "0") : "")
											]);
										}
										return h("div", {
											key: item.id,
											className: "dsa-item",
											title: "双击：添加歌单并播放 " + item.name,
											onDoubleClick: function () { onPlayPlaylist(item); }
										}, [
											h("span", { className: "t" }, item.name),
											h("span", { className: "s" }, item.desc || "")
										]);
									})
								])
							: null,
						favoritesOpen && favoriteData && !membershipSong ? h(FavoriteCollectionPanel, {
							collections: favoriteData.collections,
							activeId: activeFavoriteId,
							songs: favoriteData.songs,
							onClose: function () { setFavoritesOpen(false); setMembershipSong(null); },
							onSelect: function (id) { loadFavoriteCollection(id).catch(function (error) { flash("err", error.message || "读取收藏失败"); }); },
							onPlay: playFavoriteCollection,
							onCreate: createFavoriteCollection,
							onRename: renameFavoriteCollection,
							onDelete: deleteFavoriteCollection,
							onOrganize: openMemberships
						}) : null,
						membershipSong && favoriteData ? h(FavoriteMembershipPicker, {
							song: membershipSong,
							collections: favoriteData.collections,
							onSave: saveMemberships,
							onClose: function () { setMembershipSong(null); }
						}) : null,
						// 播放列表
						state && state.queue && Array.isArray(state.queue.items)
							? h("div", { className: "dsa-queue" }, [
									h("div", { className: "dsa-queue-title", onClick: function () { setQueueOpen(!queueOpen); } }, [
										h("span", null, "播放列表"),
										h("span", { className: "cnt" }, "(" + state.queue.items.length + " 首)"),
										h("span", { className: "fold" }, queueOpen ? "▾" : "▸")
									]),
									queueOpen
									? h("div", { className: "dsa-queue-list" }, [
											state.queue.items.map(function (item, i) {
												return h(QueueSongRow, {
													key: item.id + "-" + i, item: item, index: i,
													current: i === state.queue.index,
													selected: i === selectedIdx,
													onSelect: onQueueSelect,
													onJump: onQueueJump,
													onRemove: onQueueRemove
												});
											}),
												h("div", { className: "dsa-qclear-row" }, [
													h("button", {
														className: "dsa-qclear",
														disabled: busy || state.queue.items.length === 0,
														onClick: onQueueClear
													}, "清空播放列表")
												])
											])
										: null
								])
							: null,
						// 通知
						notice
							? h("div", { className: "dsa-notice" + (notice.kind ? " " + notice.kind : "") }, [
								h("span", { key: "text" }, notice.text),
								notice.undoToken ? h("button", { key: "undo", type: "button", className: "dsa-notice-action", onClick: function () { onQueueUndo(notice.undoToken); } }, "撤销") : null
							])
							: null
					])
					]),
					shapeMenuOpen ? h(MoonyPicker, {
						selectedId: petId,
						onSelect: transformAsMoony,
						autoMatch: autoMatch,
						onToggleAutoMatch: function () {
							setAutoMatch(function (prev) { var next = !prev; writeAutoMatch(getLocalStorage(), next); return next; });
						},
					}) : null,
					shareOpen && playing ? h(SharePanel, {
						song: playing,
						onClose: function () { setShareOpen(false); },
						onCopied: function (link) {
							flash("ok", "链接已复制：去微信粘贴即可分享给朋友");
						}
					}) : null
				]);
		}

		/**
		 * 客户端插件入口：挂载浮动播放器与样式。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			ctx.effect(function () {
				var root = document.createElement("div");
				root.id = "dsh-alger-root";
				document.body.appendChild(root);
				injectCss();
				ReactDOM.render(h(MusicPlayer), root);
				return function () {
					ReactDOM.unmountComponentAtNode(root);
					if (root.parentNode) root.parentNode.removeChild(root);
				};
			});
			// 侧边栏设置按钮右边的宠物开关
			if (ctx.slots) {
				ctx.slots.inject('sidebar.footer.action', function () {
					return ctx.slots.register(
						{ name: 'sidebar.footer.action', id: 'moony-singer-pet-toggle', order: 999 },
						function () { return h(PetToggleButton); }
					);
				});
			}
		}

		var inject = ["slots"];
		exports.apply = apply;
		exports.inject = inject;
		exports.name = "@dongfang81/dsh-music";
		exports.parseLrc = parseLrc;
		exports.karaokeProgress = karaokeProgress;
		exports.syncMediaSession = syncMediaSession;
		exports.moonyForAudio = moonyForAudio;
		exports.petForLyricDensity = petForLyricDensity;
		exports.MOONY_CSS = MOONY_CSS;
		exports.MOONY_CATALOG = MOONY_CATALOG;
		exports.MOONY_STATUS = MOONY_STATUS;
		exports.getMoony = getMoony;
		exports.dominantColorFromPixels = dominantColorFromPixels;
		exports.extractAmbientColor = extractAmbientColor;
		exports.resolveMoonPhase = resolveMoonPhase;
		exports.bindAudioBuffering = bindAudioBuffering;
		exports.readStoredMoonyId = readStoredMoonyId;
		exports.writeStoredMoonyId = writeStoredMoonyId;
		exports.resolveMoonyState = resolveMoonyState;
		exports.MoonyPet = MoonyPet;
		exports.MoonyPicker = MoonyPicker;
		exports.createLongPressHandlers = createLongPressHandlers;
		exports.FavoriteCollectionPanel = FavoriteCollectionPanel;
		exports.FavoriteMembershipPicker = FavoriteMembershipPicker;
		exports.QueueSongRow = QueueSongRow;
		exports.queuePayloadForSearchItem = queuePayloadForSearchItem;
		return module.exports;
	}
});
