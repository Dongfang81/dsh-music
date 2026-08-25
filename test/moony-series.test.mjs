import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function toChildren(children) {
	return children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
}

function loadClient({ imagePixels = null, imageFails = false, mediaSession = null } = {}) {
	let definition;
	const react = {
		createElement(type, props, ...children) {
			return { type, props: { ...(props || {}), children: toChildren(children) } };
		},
		useCallback(fn) { return fn; }, useEffect() {},
		useRef(value) { return { current: value }; },
		useState(value) { return [typeof value === 'function' ? value() : value, () => {}]; }
	};
	const document = {
		body: { appendChild() {} }, head: { appendChild() {} },
		createElement(tag) {
			if (tag === 'canvas') return {
				getContext() {
					return { drawImage() {}, getImageData() { return { data: imagePixels || new Uint8ClampedArray() }; } };
				}
			};
			return { dataset: {}, parentNode: { removeChild() {} } };
		}
	};
	class TestImage {
		set src(value) {
			this.currentSrc = value;
			Promise.resolve().then(() => imageFails ? this.onerror?.(new Error('image failed')) : this.onload?.());
		}
	}
	const sandbox = {
		clearInterval() {}, clearTimeout() {},
		document, Image: TestImage,
		fetch() { throw new Error('effects stay inactive in unit tests'); },
		localStorage: { getItem() { return null; }, setItem() {} },
		setInterval() { return 1; }, setTimeout() { return 1; },
		window: { __ModuleLoader__: { load(value) { definition = value; } }, addEventListener() {}, removeEventListener() {}, innerHeight: 900, innerWidth: 1440 }
	};
	class MediaMetadata {
		constructor(props) { Object.assign(this, props); }
	}
	sandbox.MediaMetadata = MediaMetadata;
	if (mediaSession) sandbox.navigator = { mediaSession };
	vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox);
	return definition.factory((name) => {
		if (name === 'react') return react;
		if (name === 'react-dom') return { render() {}, unmountComponentAtNode() {} };
		throw new Error(`unexpected client dependency: ${name}`);
	});
}

test('catalog contains the first wave and the three retained listening-style characters', () => {
	const { MOONY_CATALOG } = loadClient();
	assert.deepEqual(Array.from(MOONY_CATALOG, (pet) => pet.id), [
		'classic', 'pulse', 'echo', 'drift', 'spark', 'chorus', 'hush',
		'loop', 'bass', 'vinyl'
	]);
	assert.equal(new Set(Array.from(MOONY_CATALOG, (pet) => pet.id)).size, 10);
	assert.deepEqual(Array.from(MOONY_CATALOG, (pet) => pet.motion), [
		'float', 'beat', 'orbit', 'drift', 'scan', 'chorus', 'hush',
		'loop', 'bass', 'vinyl'
	]);
	assert.equal(new Set(Array.from(MOONY_CATALOG, (pet) => pet.motion)).size, 10);
	for (const pet of MOONY_CATALOG) {
		assert.match(pet.name, /^Moony/);
		assert.match(pet.colors.ear, /^#[0-9A-F]{6}$/);
		assert.match(pet.colors.highlight, /^#[0-9A-F]{6}$/);
		assert.match(pet.colors.rim, /^#[0-9A-F]{6}$/);
	}
});

test('state polling slows down when collapsed, hidden, or in a background tab', () => {
	const { statePollDelay } = loadClient();
	assert.equal(statePollDelay({ collapsed: false, hidden: false, documentHidden: false }), 1500);
	assert.equal(statePollDelay({ collapsed: true, hidden: false, documentHidden: false }), 5000);
	assert.equal(statePollDelay({ collapsed: false, hidden: true, documentHidden: false }), 15000);
	assert.equal(statePollDelay({ collapsed: false, hidden: false, documentHidden: true }), 15000);
});

test('state poller coalesces refreshes while one request is in flight', async () => {
	const { createStatePoller } = loadClient();
	const timers = [];
	const requests = [];
	const poller = createStatePoller({
		request() { return new Promise((resolve) => requests.push(resolve)); },
		getDelay() { return 5000; },
		setTimer(fn, delay) { timers.push({ fn, delay }); return timers.length; },
		clearTimer() {}
	});
	poller.start();
	poller.refresh();
	poller.refresh();
	assert.equal(requests.length, 1);
	requests.shift()();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(requests.length, 1, 'multiple pending refreshes become one follow-up request');
	requests.shift()();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(timers.at(-1).delay, 5000);
	poller.stop();
});

test('state fetch timeout aborts a hung request so polling can recover', async () => {
	const { fetchJsonWithTimeout } = loadClient();
	const timers = [];
	const cleared = [];
	const pending = fetchJsonWithTimeout('/dsh-alger/state', { timeoutMs: 5000 }, {
		AbortController,
		fetch(_path, options) {
			return new Promise((_resolve, reject) => {
				options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
			});
		},
		setTimer(fn, delay) { timers.push({ fn, delay }); return timers.length; },
		clearTimer(id) { cleared.push(id); }
	});
	assert.equal(timers[0].delay, 5000);
	timers[0].fn();
	await assert.rejects(() => pending, /request timeout/);
	assert.deepEqual(cleared, [1]);
});

test('compact state signatures ignore object identity and collection reloads require an open stale panel', () => {
	const { compactStateSignature, shouldReloadCollection } = loadClient();
	const first = {
		stateRevision: 3,
		musicApiUp: true,
		playing: { song: { id: 1, name: '晴天' }, isPlaying: true },
		queue: { count: 60, index: 4, revision: 8 },
		favorites: { count: 2, revision: 5 },
		recommendation: { ready: true, count: 60, generating: false, lastError: null }
	};
	assert.equal(compactStateSignature(first), compactStateSignature(JSON.parse(JSON.stringify(first))));
	assert.notEqual(compactStateSignature(first), compactStateSignature({ ...first, queue: { ...first.queue, revision: 9 } }));
	assert.equal(shouldReloadCollection(null, 4, true), true);
	assert.equal(shouldReloadCollection(4, 4, true), false);
	assert.equal(shouldReloadCollection(4, 5, false), false);
	assert.equal(shouldReloadCollection(4, 5, true), true);
});

test('playback reporter sends on transitions and checkpoints only while active', async () => {
	const { createPlaybackReporter } = loadClient();
	let active = false;
	let nextTimer = 0;
	const timers = new Map();
	const sent = [];
	const reporter = createPlaybackReporter({
		read: () => ({ playing: active, position: sent.length * 5 }),
		send: async (payload) => { sent.push(payload); },
		intervalMs: 5000,
		setTimer(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
		clearTimer(id) { timers.delete(id); }
	});
	active = true;
	await reporter.setPlaying(true);
	assert.equal(sent.length, 1);
	assert.equal(timers.size, 1);
	assert.equal([...timers.values()][0].delay, 5000);
	await reporter.setPlaying(true);
	assert.equal(sent.length, 1, 'repeated play events do not duplicate sends or timers');
	assert.equal(timers.size, 1);

	const [timerId, timer] = [...timers.entries()][0];
	timers.delete(timerId);
	timer.fn();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(sent.length, 2);
	assert.equal(timers.size, 1, 'a periodic checkpoint schedules its successor after settling');
	await reporter.checkpoint();
	assert.equal(sent.length, 3);
	assert.equal(timers.size, 1);

	active = false;
	await reporter.setPlaying(false);
	assert.equal(sent.length, 4, 'pause is reported immediately');
	assert.equal(timers.size, 0, 'paused playback has no periodic wakeup');
	reporter.dispose();
	assert.equal(timers.size, 0);
});

test('audio analyzer lifecycle samples only when enabled playing and visible', async () => {
	const { createAnalyzerLifecycle } = loadClient();
	let nextTimer = 0;
	const timers = new Map();
	const events = [];
	const lifecycle = createAnalyzerLifecycle({
		sample: () => ({ energy: 0.5 }),
		onSample: (value) => events.push(['sample', value.energy]),
		resume: async () => { events.push(['resume']); },
		suspend: async () => { events.push(['suspend']); },
		close: async () => { events.push(['close']); },
		intervalMs: 800,
		setTimer(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
		clearTimer(id) { timers.delete(id); }
	});
	lifecycle.update({ enabled: true, playing: true, visible: true });
	await Promise.resolve();
	assert.deepEqual(events, [['resume']]);
	assert.equal(timers.size, 1);
	assert.equal([...timers.values()][0].delay, 800);
	lifecycle.update({ enabled: true, playing: true, visible: true });
	assert.equal(timers.size, 1, 'repeated active updates keep one sampler');

	const [timerId, timer] = [...timers.entries()][0];
	timers.delete(timerId);
	timer.fn();
	assert.deepEqual(events.at(-1), ['sample', 0.5]);
	assert.equal(timers.size, 1);
	lifecycle.update({ enabled: true, playing: false, visible: true });
	await Promise.resolve();
	assert.equal(timers.size, 0);
	assert.deepEqual(events.at(-1), ['suspend']);
	lifecycle.update({ enabled: true, playing: true, visible: false });
	assert.equal(timers.size, 0);
	lifecycle.update({ enabled: true, playing: true, visible: true });
	await Promise.resolve();
	assert.deepEqual(events.at(-1), ['resume']);
	assert.equal(timers.size, 1);
	lifecycle.dispose();
	await Promise.resolve();
	assert.equal(timers.size, 0);
	assert.deepEqual(events.at(-1), ['close']);
});

test('moon phase clamps progress and fades only through the final eight percent', () => {
	const { resolveMoonPhase } = loadClient();
	assert.deepEqual(Object.values(resolveMoonPhase(-1)), [0, 1]);
	assert.deepEqual(Object.values(resolveMoonPhase(0.5)), [0.5, 1]);
	assert.deepEqual(Object.values(resolveMoonPhase(0.92)), [0.92, 1]);
	assert.deepEqual(Object.values(resolveMoonPhase(0.96)), [0.96, 0.5]);
	assert.deepEqual(Object.values(resolveMoonPhase(2)), [1, 0]);
});

test('Moony renders a static moon phase ring and a separate buffering gap', () => {
	const { MoonyPet, MOONY_CSS } = loadClient();
	const paused = MoonyPet({ petId: 'classic', isPlaying: false, playbackProgress: 0.5, isBuffering: false });
	const ring = findNodes(paused, (node) => node.props?.className === 'dsa-moony-phase')[0];
	const track = findNodes(paused, (node) => node.props?.className === 'dsa-moony-phase-track')[0];
	const progress = findNodes(paused, (node) => node.props?.className === 'dsa-moony-phase-progress')[0];
	assert.ok(ring);
	assert.ok(track, 'the full orbit must remain faintly visible even at new moon');
	assert.equal(ring.props['aria-label'], '播放进度 50%');
	assert.equal(progress.props.style.strokeDashoffset, 94.25);
	assert.equal(progress.props.style.opacity, 1);
	assert.doesNotMatch(ring.props.className, /buffering/);

	const buffering = MoonyPet({ petId: 'classic', playbackProgress: 0.5, isBuffering: true });
	assert.match(findNodes(buffering, (node) => String(node.props?.className || '').startsWith('dsa-moony-phase'))[0].props.className, /buffering/);
	assert.equal(findNodes(buffering, (node) => node.props?.className === 'dsa-moony-phase-gap').length, 1);
	assert.match(MOONY_CSS, /\.dsa-moony-phase\.buffering \.dsa-moony-phase-gap\{[^}]*animation:dsa-moony-phase-flow/);
	assert.doesNotMatch(MOONY_CSS, /\.dsa-moony-phase-progress\{[^}]*animation:/);
	const ringRule = MOONY_CSS.match(/\.dsa-moony-phase\{([^}]*)\}/)?.[1];
	const progressRule = MOONY_CSS.match(/\.dsa-moony-phase-progress\{([^}]*)\}/)?.[1];
	assert.ok(Number(ringRule?.match(/inset:(-?\d+)px/)?.[1]) <= -4, 'the phase ring must sit clearly outside the face');
	assert.ok(Number(progressRule?.match(/stroke-width:(\d+(?:\.\d+)?)/)?.[1]) >= 2, 'the progress arc must remain visible on a dark UI');
	assert.match(progressRule, /color-mix\([^;]*white/, 'dark character colors must be lifted toward white for contrast');
});

test('audio buffering bindings start on starvation events and clear on recovery', () => {
	const { bindAudioBuffering } = loadClient();
	const listeners = new Map();
	const removed = [];
	const audio = {
		addEventListener(name, callback) { listeners.set(name, callback); },
		removeEventListener(name, callback) { removed.push([name, callback]); }
	};
	const states = [];
	const unbind = bindAudioBuffering(audio, (value) => states.push(value));
	for (const name of ['loadstart', 'waiting', 'stalled']) listeners.get(name)();
	for (const name of ['canplay', 'canplaythrough', 'playing', 'seeked', 'ended', 'error']) listeners.get(name)();
	assert.deepEqual(states, [true, true, true, false, false, false, false, false, false]);
	unbind();
	assert.equal(removed.length, 9);
});

test('favorite heart is a one-click toggle with no organization gesture', () => {
	const { FavoriteHeartButton } = loadClient();
	const events = [];
	const tree = FavoriteHeartButton({ active: true, disabled: false, onToggle() { events.push('favorite'); } });
	assert.equal(tree.type, 'button');
	assert.equal(tree.props.title, '收藏/取消收藏当前歌曲');
	assert.equal(tree.props.onPointerDown, undefined);
	assert.equal(tree.props.onPointerUp, undefined);
	tree.props.onClick();
	assert.deepEqual(events, ['favorite']);
});

test('favorite list keeps the compact play icon directly after the song count', () => {
	const { FavoriteListPanel } = loadClient();
	const events = [];
	const tree = FavoriteListPanel({
		songs: [
			{ id: 1, name: '晴天', artists: '周杰伦' },
			{ id: 2, name: '夜曲', artists: '周杰伦' }
		],
		onPlayAll() { events.push('all'); },
		onPlayFrom(index) { events.push(`from:${index}`); }
	});
	const head = findNodes(tree, (node) => node.props?.className === 'dsa-favorites-head')[0];
	assert.equal(head.props.children[1].props.children, '2 首');
	const play = head.props.children[2];
	assert.equal(play.type, 'button');
	assert.equal(play.props['aria-label'], '播放全部收藏');
	assert.notEqual(play.props.children, '播放全部');
	play.props.onClick();
	const rows = findNodes(tree, (node) => node.props?.className === 'dsa-favorite-row');
	rows[1].props.onClick();
	assert.deepEqual(events, ['all', 'from:1']);
});

test('favorite rows expose a lightweight remove control without starting playback', () => {
	const { FavoriteListPanel } = loadClient();
	const events = [];
	const tree = FavoriteListPanel({
		songs: [{ id: 1, name: '晴天', artists: '周杰伦' }],
		onPlayFrom(index) { events.push(`play:${index}`); },
		onRemove(song) { events.push(`remove:${song.id}`); }
	});
	const row = findNodes(tree, (node) => node.props?.className === 'dsa-favorite-row')[0];
	const remove = findNodes(row, (node) => node.type === 'button' && node.props?.['aria-label'] === '取消收藏晴天')[0];
	assert.equal(row.type, 'div', 'row must not nest a remove button inside another button');
	assert.equal(row.props.role, 'button');
	assert.ok(remove);
	remove.props.onClick({ stopPropagation() { events.push('stop'); } });
	assert.deepEqual(events, ['stop', 'remove:1']);
	row.props.onClick();
	assert.deepEqual(events, ['stop', 'remove:1', 'play:0']);
});

test('queue song row exposes one lightweight remove control that does not select the row', () => {
	const { QueueSongRow } = loadClient();
	const events = [];
	const tree = QueueSongRow({
		item: { id: 1, name: '晴天', artists: '周杰伦' }, index: 2,
		onSelect() { events.push('select'); },
		onJump() { events.push('jump'); },
		onRemove(index) { events.push(`remove:${index}`); }
	});
	const remove = findNodes(tree, (node) => node.type === 'button' && node.props?.['aria-label'] === '从播放列表移除')[0];
	assert.ok(remove);
	remove.props.onClick({ stopPropagation() { events.push('stop'); } });
	assert.deepEqual(events, ['stop', 'remove:2']);
});

test('search rows add by their catalog song id', () => {
	const { queuePayloadForSearchItem } = loadClient();
	assert.deepEqual(Object.values(queuePayloadForSearchItem({ id: 123 })), ['add', 123]);
});

test('an empty strict search surfaces the server guidance instead of looking broken', () => {
	const { searchFeedbackForResponse } = loadClient();
	assert.equal(searchFeedbackForResponse({ ok: true, items: [], guidance: '没有找到可靠原唱。' }), '没有找到可靠原唱。');
	assert.equal(searchFeedbackForResponse({ ok: true, items: [{ id: 1 }] }), null);
});

test('resolver falls back to Classic, idle, and a blank face', () => {
	const { resolveMoonyState } = loadClient();
	const value = resolveMoonyState({ petId: 'missing', agentStatus: 'unknown', mediaUrl: '' });
	assert.equal(value.pet.id, 'classic');
	assert.equal(value.status, 'idle');
	assert.equal(value.faceMode, 'blank');
	assert.equal(value.mediaUrl, null);
});

test('resolver accepts approved states and trimmed media URLs', () => {
	const { resolveMoonyState } = loadClient();
	const value = resolveMoonyState({ petId: 'echo', agentStatus: 'review', mediaUrl: ' https://img.test/a.jpg ' });
	assert.equal(value.pet.id, 'echo');
	assert.equal(value.status, 'review');
	assert.equal(value.faceMode, 'media');
	assert.equal(value.mediaUrl, 'https://img.test/a.jpg');
});

test('dominant album color ignores transparent pixels and favors the most common visible color', () => {
	const { dominantColorFromPixels } = loadClient();
	const pixels = new Uint8ClampedArray([
		238, 32, 48, 255,
		238, 32, 48, 255,
		238, 32, 48, 255,
		25, 85, 220, 255,
		20, 240, 80, 0
	]);
	assert.equal(dominantColorFromPixels(pixels), '#EE2030');
	assert.equal(dominantColorFromPixels(new Uint8ClampedArray([20, 240, 80, 0])), null);
});

test('album image sampling returns a light color and safely falls back when loading fails', async () => {
	const pixels = new Uint8ClampedArray([
		42, 156, 202, 255,
		42, 156, 202, 255,
		230, 90, 30, 255
	]);
	const sampled = loadClient({ imagePixels: pixels });
	assert.equal(await sampled.extractAmbientColor('https://img.test/album.jpg'), '#2A9CCA');
	const failed = loadClient({ imageFails: true });
	assert.equal(await failed.extractAmbientColor('https://img.test/broken.jpg'), null);
});

test('Moony light prioritizes agent status over album ambience and role rim', () => {
	const { MoonyPet } = loadClient();
	const idle = MoonyPet({ petId: 'classic', agentStatus: 'idle', isPlaying: false });
	assert.equal(idle.props.style['--moony-light'], '#D8D0FF');

	const playing = MoonyPet({ petId: 'classic', agentStatus: 'idle', isPlaying: true, ambientColor: '#1A8FB8' });
	assert.equal(playing.props.style['--moony-light'], '#1A8FB8');
	assert.match(playing.props.style['--moony-light-soft'], /^rgba\(26, 143, 184, /);

	const running = MoonyPet({ petId: 'classic', agentStatus: 'running', isPlaying: true, ambientColor: '#1A8FB8' });
	assert.equal(running.props.style['--moony-light'], '#3B82F6');
});

test('Moony lighting visibly reaches ear interiors, role rims, and tails', () => {
	const { MOONY_CSS } = loadClient();
	assert.match(MOONY_CSS, /\.dsa-moony-ear\{[^}]*0 0 \d+px var\(--moony-rim-soft\)/);
	assert.match(MOONY_CSS, /\.dsa-moony-ear::before\{[^}]*background:[^}]*var\(--moony-light-soft\)/);
	assert.match(MOONY_CSS, /\.dsa-moony-tail\{[^}]*drop-shadow\([^)]*var\(--moony-light-soft\)/);
	assert.match(MOONY_CSS, /dsa-agent-running[^}]*border-color:var\(--moony-signal\)/);
});

test('rounded polygon ears use soft halos without tracing their sharp clip edges', () => {
	const { MOONY_CSS, MoonyPet } = loadClient();
	for (const petId of ['pulse', 'echo', 'hush']) {
		const tree = MoonyPet({ petId, agentStatus: 'running', isPlaying: true, ambientColor: '#2A9CCA' });
		assert.equal(tree.props['data-moony-soft-glow'], true);
		assert.equal(findNodes(tree, (node) => node.props?.className === 'dsa-moony-soft-halos').length, 1);
		assert.equal(findNodes(tree, (node) => String(node.props?.className || '').includes('dsa-moony-soft-halo')).length, 3);
	}
	const chorus = MoonyPet({ petId: 'chorus', agentStatus: 'running', isPlaying: true });
	assert.equal(chorus.props['data-moony-soft-glow'], undefined);
	assert.equal(findNodes(chorus, (node) => node.props?.className === 'dsa-moony-soft-halos').length, 0);
	assert.match(MOONY_CSS, /data-moony-soft-glow='true'\] \.dsa-moony-ear\{filter:none\}/);
	assert.match(MOONY_CSS, /\.dsa-moony-soft-halo\{[^}]*background:var\(--moony-light-soft\)[^}]*blur\(/);
});

test('prototype property pet IDs fall back to Classic', () => {
	const { getMoony, resolveMoonyState } = loadClient();
	for (const id of ['constructor', 'toString', '__proto__']) {
		assert.equal(getMoony(id).id, 'classic');
		assert.equal(resolveMoonyState({ petId: id }).pet.id, 'classic');
	}
});

test('prototype property agent statuses fall back to idle', () => {
	const { resolveMoonyState } = loadClient();
	for (const status of ['constructor', 'toString', '__proto__']) {
		assert.equal(resolveMoonyState({ agentStatus: status }).status, 'idle');
	}
});

test('storage keeps valid choices and rejects invalid or unavailable storage', () => {
	const { readStoredMoonyId, writeStoredMoonyId } = loadClient();
	const values = new Map();
	const storage = { getItem(key) { return values.get(key) ?? null; }, setItem(key, value) { values.set(key, value); } };
	assert.equal(readStoredMoonyId(storage), 'classic');
	assert.equal(writeStoredMoonyId(storage, 'drift'), 'drift');
	assert.equal(readStoredMoonyId(storage), 'drift');
	values.set('dsh-moony-singer:pet-id:v1', 'not-a-pet');
	assert.equal(readStoredMoonyId(storage), 'classic');
	values.set('dsh-moony-singer:pet-id:v1', 'solo');
	assert.equal(readStoredMoonyId(storage), 'classic');
	const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
	assert.equal(readStoredMoonyId(blocked), 'classic');
	assert.equal(writeStoredMoonyId(blocked, 'echo'), 'echo');
});

function flattenChildren(value) {
	if (Array.isArray(value)) return value.flatMap(flattenChildren);
	return value === undefined || value === null || value === false ? [] : [value];
}

function findNodes(root, predicate) {
	const found = [];
	(function visit(node) {
		if (!node || typeof node !== 'object') return;
		if (predicate(node)) found.push(node);
		for (const child of flattenChildren(node.props?.children)) visit(child);
	})(root);
	return found;
}

function loadMusicPlayerHarness({ storedId = null, storageUnavailable = false, ambientPixels = null, apiUp = true } = {}) {
	let definition;
	let mountedPlayer;
	let tree;
	let hookIndex = 0;
	let effectIndex = 0;
	let effects = [];
	let activeHooks;
	const musicHooks = [];
	const footerHooks = [];
	const listeners = {};
	const registrations = [];
	const values = new Map(storedId ? [['dsh-moony-singer:pet-id:v1', storedId]] : []);
	const storage = {
		getItem(key) { return values.get(key) ?? null; },
		setItem(key, value) { values.set(key, value); }
	};
	const playerState = {
		agentStatus: 'review',
		musicApiUp: apiUp,
		playing: { isPlaying: true, song: { id: 'song-1', name: 'Paper Moon', artists: 'Ella', albumPic: 'https://img.test/moon.jpg' } }
	};
	const rerender = function () {
		activeHooks = musicHooks;
		hookIndex = 0;
		effectIndex = 0;
		effects = [];
		tree = mountedPlayer.type(mountedPlayer.props);
	};
	const footerToggle = function () {
		const registration = registrations.find(({ descriptor }) => descriptor.id === 'moony-singer-pet-toggle');
		assert.ok(registration, 'Moony footer toggle must be registered');
		activeHooks = footerHooks;
		hookIndex = 0;
		effectIndex = 0;
		let element = registration.component({ wide: true });
		while (element && typeof element.type === 'function') element = element.type(element.props);
		return element;
	};
	const react = {
		createElement(type, props, ...children) {
			return { type, props: { ...(props || {}), children: toChildren(children) } };
		},
		useCallback(fn) { hookIndex++; return fn; },
		useEffect(callback, dependencies) {
			hookIndex++;
			effects.push({ callback, dependencies });
			if (effectIndex++ === 0) callback();
		},
		useRef(value) {
			const index = hookIndex++;
			if (!(index in activeHooks)) activeHooks[index] = { current: value };
			return activeHooks[index];
		},
		useState(value) {
			const index = hookIndex++;
			const hookSet = activeHooks;
			if (!(index in hookSet)) hookSet[index] = hookSet === musicHooks && index === 0 ? playerState : (typeof value === 'function' ? value() : value);
			return [hookSet[index], (next) => {
				hookSet[index] = typeof next === 'function' ? next(hookSet[index]) : next;
				if (hookSet === musicHooks) rerender(); else footerToggle();
			}];
		}
	};
	const document = {
		body: { appendChild() {} },
		head: { appendChild() {} },
		createElement(tag) {
			if (tag === 'canvas') return {
				getContext() {
					return { drawImage() {}, getImageData() { return { data: ambientPixels || new Uint8ClampedArray() }; } };
				}
			};
			return { dataset: {}, parentNode: { removeChild() {} } };
		}
	};
	class TestImage {
		set src(value) {
			this.currentSrc = value;
			Promise.resolve().then(() => this.onload?.());
		}
	}
	const sandbox = {
		clearInterval() {}, clearTimeout() {}, document, Image: TestImage,
		fetch() { throw new Error('effects stay inactive in MusicPlayer integration tests'); },
		setInterval() { return 1; }, setTimeout() { return 1; },
		window: {
			__ModuleLoader__: { load(value) { definition = value; } },
			addEventListener(name, callback) { listeners[name] = callback; },
			removeEventListener(name) { delete listeners[name]; },
			innerHeight: 900, innerWidth: 1440
		}
	};
	if (storageUnavailable) {
		Object.defineProperty(sandbox, 'localStorage', { get() { throw new Error('storage unavailable'); } });
		Object.defineProperty(sandbox.window, 'localStorage', { get() { throw new Error('storage unavailable'); } });
	} else {
		sandbox.localStorage = storage;
		sandbox.window.localStorage = storage;
	}
	vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox);
	const client = definition.factory((name) => {
		if (name === 'react') return react;
		if (name === 'react-dom') return { render(element) { mountedPlayer = element; rerender(); }, unmountComponentAtNode() {} };
		throw new Error(`unexpected client dependency: ${name}`);
	});
	client.apply({
		effect(callback) { callback(); },
		slots: {
			inject(name, callback) { assert.equal(name, 'sidebar.footer.action'); callback(); },
			register(descriptor, component) { registrations.push({ descriptor, component }); }
		}
	});
	const renderPickers = function () {
		const render = function (node) {
			if (Array.isArray(node)) return node.map(render);
			if (!node || typeof node !== 'object') return node;
			if (node.type === client.MoonyPicker) return render(node.type(node.props));
			return { ...node, props: { ...node.props, children: render(node.props?.children) } };
		};
		return render(tree);
	};
	const runAlbumColorEffect = async function () {
		const effect = effects.find(({ dependencies }) => Array.isArray(dependencies) && dependencies[0] === 'https://img.test/moon.jpg' && dependencies[1] === true);
		assert.ok(effect, 'MusicPlayer must react to the active album artwork');
		effect.callback();
		await Promise.resolve();
		await Promise.resolve();
	};
	return { client, footerToggle, listeners, renderPickers, runAlbumColorEffect, storage, tree: () => tree };
}

test('MusicPlayer preserves the selected Moony through the collapsed and expanded player flows', () => {
	const harness = loadMusicPlayerHarness({ storedId: 'drift' });
	let pet = findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPet)[0];
	assert.deepEqual(Array.from(harness.client.inject), ['slots']);
	assert.equal(findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPicker).length, 0);
	assert.deepEqual(
		{ petId: pet.props.petId, agentStatus: pet.props.agentStatus, mediaUrl: pet.props.mediaUrl, isPlaying: pet.props.isPlaying },
		{ petId: 'drift', agentStatus: 'review', mediaUrl: 'https://img.test/moon.jpg', isPlaying: true }
	);

	pet.props.onClick({ stopPropagation() {} });
	assert.equal(findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPicker).length, 0);
	findNodes(harness.tree(), (node) => node.props?.['data-moony-menu-toggle'])[0].props.onClick({ stopPropagation() {} });
	let picker = findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPicker)[0];
	assert.equal(picker.props.selectedId, 'drift');
	const pickerTree = picker.type(picker.props);
	findNodes(pickerTree, (node) => node.props?.['data-moony-choice'] === 'echo')[0].props.onClick();
	assert.equal(harness.storage.getItem('dsh-moony-singer:pet-id:v1'), 'echo');
	pet = findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPet)[0];
	assert.equal(pet.props.petId, 'echo');
	pet.props.onPointerDown({ button: 0, clientX: 10, clientY: 10 });
	harness.listeners.pointermove({ clientX: 20, clientY: 10 });
	pet.props.onClick({ stopPropagation() {} });
	assert.equal(findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPicker).length, 0);
	pet.props.onClick({ stopPropagation() {} });
	findNodes(harness.tree(), (node) => node.props?.['data-moony-menu-toggle'])[0].props.onClick({ stopPropagation() {} });
	picker = findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPicker)[0];
	assert.equal(picker.props.selectedId, 'echo');
});

test('MusicPlayer samples the active album and passes its ambient color to Moony', async () => {
	const harness = loadMusicPlayerHarness({
		storedId: 'echo',
		ambientPixels: new Uint8ClampedArray([54, 180, 120, 255, 54, 180, 120, 255, 220, 80, 30, 255])
	});
	await harness.runAlbumColorEffect();
	const pet = findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPet)[0];
	assert.equal(pet.props.ambientColor, '#36B478');
});

test('transform menu shows ten static previews and selecting one immediately transforms', () => {
	const harness = loadMusicPlayerHarness({ storedId: 'drift' });
	findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPet)[0].props.onClick({ stopPropagation() {} });
	assert.equal(findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPicker).length, 0);

	const toggle = findNodes(harness.tree(), (node) => node.props?.['data-moony-menu-toggle'])[0];
	assert.ok(toggle);
	toggle.props.onClick({ stopPropagation() {} });
	const expandedTree = harness.tree();
	const card = findNodes(expandedTree, (node) => node.props?.className === 'dsa-card')[0];
	assert.equal(
		findNodes(card, (node) => node.type === harness.client.MoonyPicker).length,
		0,
		'the transform menu must render outside the overflow-hidden player card'
	);
	const picker = findNodes(expandedTree, (node) => node.type === harness.client.MoonyPicker)[0];
	assert.ok(picker);
	const menu = picker.type(picker.props);
	assert.equal(findNodes(menu, (node) => node.props?.['data-moony-choice']).length, 10);
	assert.equal(findNodes(menu, (node) => node.props?.className === 'dsa-moony-thumb').length, 10);

	findNodes(menu, (node) => node.props?.['data-moony-choice'] === 'echo')[0].props.onClick();
	assert.equal(harness.storage.getItem('dsh-moony-singer:pet-id:v1'), 'echo');
	const transformed = findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPet)[0];
	assert.equal(transformed.props.petId, 'echo');
	assert.equal(findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPicker).length, 0);
});

test('main transform button collapses with the current Moony without opening the menu', () => {
	const harness = loadMusicPlayerHarness({ storedId: 'chorus' });
	findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPet)[0].props.onClick({ stopPropagation() {} });
	const transform = findNodes(harness.tree(), (node) => node.props?.['data-moony-transform'])[0];
	assert.ok(transform);
	transform.props.onClick({ stopPropagation() {} });
	const pet = findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPet)[0];
	assert.equal(pet.props.petId, 'chorus');
	assert.equal(findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPicker).length, 0);
});

test('MusicPlayer keeps character selection usable when acquiring localStorage throws', () => {
	const harness = loadMusicPlayerHarness({ storageUnavailable: true });
	const pet = findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPet)[0];
	assert.equal(pet.props.petId, 'classic');
	assert.doesNotThrow(() => pet.props.onClick({ stopPropagation() {} }));
	findNodes(harness.tree(), (node) => node.props?.['data-moony-menu-toggle'])[0].props.onClick({ stopPropagation() {} });
	const picker = findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPicker)[0];
	const pickerTree = picker.type(picker.props);
	assert.doesNotThrow(() => findNodes(pickerTree, (node) => node.props?.['data-moony-choice'] === 'hush')[0].props.onClick());
	assert.equal(findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPet)[0].props.petId, 'hush');
});

test('MusicPlayer hides through the footer control and renders the picker only from the transform menu', () => {
	const harness = loadMusicPlayerHarness({ storedId: 'pulse' });
	let footer = harness.footerToggle();
	footer.props.children.props.onClick();
	assert.equal(harness.tree(), null);

	footer = harness.footerToggle();
	footer.props.children.props.onClick();
	let pet = findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPet)[0];
	assert.ok(pet);
	pet.props.onClick({ stopPropagation() {} });
	assert.equal(findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPicker).length, 0);
	findNodes(harness.tree(), (node) => node.props?.['data-moony-menu-toggle'])[0].props.onClick({ stopPropagation() {} });
	const rendered = harness.renderPickers();
	const body = findNodes(rendered, (node) => node.props?.className === 'dsa-body')[0];
	const allPickers = findNodes(rendered, (node) => node.props?.className === 'dsa-moony-menu');
	assert.equal(allPickers.length, 1);
	assert.equal(findNodes(body, (node) => node.props?.className === 'dsa-moony-menu').length, 0);
});

test('expanded player toggles the lightweight lyrics panel and shows an empty hint without lyrics', () => {
	const harness = loadMusicPlayerHarness({ storedId: 'classic' });
	findNodes(harness.tree(), (node) => node.type === harness.client.MoonyPet)[0].props.onClick({ stopPropagation() {} });
	const lyricButtons = () => findNodes(harness.tree(), (node) => node.type === 'button' && String(node.props?.className || '').includes('dsa-lyric'));
	assert.equal(lyricButtons().length, 1, 'a lyrics toggle button must exist in the expanded player');
	assert.equal(lyricButtons()[0].props.disabled, false, 'lyrics button is enabled while a song is playing');
	assert.equal(findNodes(harness.tree(), (node) => node.props?.className === 'dsa-lyrics').length, 0, 'panel is hidden by default');

	lyricButtons()[0].props.onClick();
	const panel = findNodes(harness.tree(), (node) => node.props?.className === 'dsa-lyrics')[0];
	assert.ok(panel, 'clicking the lyrics button opens the panel');
	assert.equal(findNodes(panel, (node) => node.props?.className === 'dsa-lyric-empty').length, 1, 'no lyrics loaded yet shows the empty hint');
	assert.match(lyricButtons()[0].props.className, /active/, 'the toggle reflects the open state');

	lyricButtons()[0].props.onClick();
	assert.equal(findNodes(harness.tree(), (node) => node.props?.className === 'dsa-lyrics').length, 0, 'clicking again closes the panel');
});

test('syncMediaSession publishes song metadata and playback state to the system', () => {
	let metadata = null;
	let playbackState = 'none';
	const mediaSession = {
		set metadata(value) { metadata = value; },
		set playbackState(value) { playbackState = value; }
	};
	const { syncMediaSession } = loadClient({ mediaSession });
	const song = { id: 7, name: 'Moon', artists: 'Luna', album: 'Night', albumPic: 'https://img.test/moon.jpg' };

	syncMediaSession(song, true);
	assert.equal(metadata.title, 'Moon');
	assert.equal(metadata.artist, 'Luna');
	assert.equal(metadata.album, 'Night');
	assert.equal(metadata.artwork.length, 1);
	assert.equal(metadata.artwork[0].src, 'https://img.test/moon.jpg');
	assert.equal(metadata.artwork[0].sizes, '512x512');
	assert.equal(playbackState, 'playing');

	syncMediaSession(song, false);
	assert.equal(metadata.title, 'Moon', 'the same song must not rebuild metadata');
	assert.equal(playbackState, 'paused', 'but the playback state still updates');

	syncMediaSession(null, false);
	assert.equal(metadata, null, 'stopping clears the system metadata');
	assert.equal(playbackState, 'paused');
});

test('picker exposes ten static preview options and selects the clicked character', () => {
	const { MoonyPicker } = loadClient();
	let selected = null;
	const tree = MoonyPicker({ selectedId: 'classic', onSelect(id) { selected = id; } });
	const buttons = findNodes(tree, (node) => node.type === 'button');
	assert.equal(buttons.length, 10);
	assert.equal(buttons[0].props['aria-checked'], true);
	assert.equal(findNodes(tree, (node) => node.props?.className === 'dsa-moony-thumb').length, 10);
	buttons.find((button) => button.props['data-moony-choice'] === 'vinyl').props.onClick();
	assert.equal(selected, 'vinyl');
});

test('moonyForAudio always maps any active audio to a known pet', () => {
	const { moonyForAudio } = loadClient();
	const pets = new Set(['classic', 'pulse', 'echo', 'drift', 'spark', 'chorus', 'hush', 'loop', 'bass', 'vinyl']);
	// 网格采样：任何特征组合都必须映射到合法角色（推荐不追求精确，但必须有结果）
	for (let b = 0; b <= 0.7; b += 0.1) {
		for (let e = 0; e <= 0.7; e += 0.1) {
			for (let v = 0; v <= 0.7; v += 0.1) {
				const r = moonyForAudio({ bass: b, energy: e, vocal: v });
				assert.ok(pets.has(r), `unmapped feature bass=${b} energy=${e} vocal=${v} -> ${r}`);
			}
		}
	}
	assert.equal(moonyForAudio({ bass: 0.1, energy: 0.05, vocal: 0.1 }), 'hush');
	assert.equal(moonyForAudio({ bass: 0.6, energy: 0.5, vocal: 0.2 }), 'bass');
	assert.equal(moonyForAudio({ bass: 0.2, energy: 0.7, vocal: 0.3 }), 'pulse');
	assert.equal(moonyForAudio({ bass: 0.3, energy: 0.4, vocal: 0.6 }), 'chorus');
	assert.equal(moonyForAudio({ bass: 0.3, energy: 0.2, vocal: 0.3 }), 'drift');
	assert.equal(moonyForAudio({ bass: 0.45, energy: 0.35, vocal: 0.3 }), 'echo');
	assert.equal(moonyForAudio({ bass: 0.3, energy: 0.45, vocal: 0.3 }), 'classic');
});

test('petForLyricDensity maps instrumental and dense-lyric songs instantly', () => {
	const { petForLyricDensity } = loadClient();
	// 纯音乐/极稀疏：1 行歌词 ÷ 4 分钟 = 0.25 行/分钟 → drift
	assert.equal(petForLyricDensity(1, 240), 'drift');
	assert.equal(petForLyricDensity(0, 200), null, 'no lyrics at all leaves audio analysis to decide');
	// 歌词密集：40 行 ÷ 4 分钟 = 10 行/分钟 → chorus
	assert.equal(petForLyricDensity(40, 240), 'chorus');
	assert.equal(petForLyricDensity(100, 300), 'chorus');
	// 中间地带（1–9 行/分钟）→ 交给音频分析
	assert.equal(petForLyricDensity(10, 240), null);
	assert.equal(petForLyricDensity(30, 240), null);
	// 无时长 → 无法判定
	assert.equal(petForLyricDensity(10, 0), null);
});

test('idle Classic has a blank face with no image, Emoji, or tail', () => {
	const { MoonyPet } = loadClient();
	const tree = MoonyPet({ petId: 'classic', agentStatus: 'idle', mediaUrl: null, isPlaying: false });
	assert.equal(findNodes(tree, (node) => node.type === 'img').length, 0);
	assert.equal(findNodes(tree, (node) => String(node.props?.className || '').includes('dsa-pet-emoji')).length, 0);
	assert.equal(findNodes(tree, (node) => String(node.props?.className || '').includes('dsa-moony-tail')).length, 0);
	assert.equal(findNodes(tree, (node) => String(node.props?.className || '').includes('dsa-moony-face')).length, 1);
});

test('Echo renders one tail and media only inside the face layer', () => {
	const { MoonyPet } = loadClient();
	const tree = MoonyPet({ petId: 'echo', agentStatus: 'running', mediaUrl: 'https://img.test/singer.jpg', isPlaying: true });
	const images = findNodes(tree, (node) => node.type === 'img');
	assert.equal(images.length, 1);
	assert.equal(images[0].props.src, 'https://img.test/singer.jpg');
	assert.equal(findNodes(tree, (node) => String(node.props?.className || '').includes('dsa-moony-tail')).length, 1);
	const target = { hidden: false };
	images[0].props.onError({ currentTarget: target });
	assert.equal(target.hidden, true);
});

test('a valid media source recovers an image node hidden by an earlier load failure', () => {
	const { MoonyPet } = loadClient();
	const failed = findNodes(
		MoonyPet({ petId: 'echo', mediaUrl: 'https://img.test/broken.jpg' }),
		(node) => node.type === 'img'
	)[0];
	const imageNode = { hidden: false };
	failed.props.onError({ currentTarget: imageNode });
	assert.equal(imageNode.hidden, true);

	const recovered = findNodes(
		MoonyPet({ petId: 'echo', mediaUrl: 'https://img.test/valid.jpg' }),
		(node) => node.type === 'img'
	)[0];
	assert.equal(recovered.props.key, 'https://img.test/valid.jpg');
	recovered.props.onLoad({ currentTarget: imageNode });
	assert.equal(imageNode.hidden, false);
});

test('Moony CSS defines every skin, tail, signal, and reduced-motion fallback', () => {
	const { MOONY_CATALOG, MOONY_CSS, MoonyPet } = loadClient();
	for (const ear of ['classic', 'pulse', 'echo', 'drift', 'spark', 'chorus', 'hush', 'loop', 'bass', 'vinyl']) {
		assert.match(MOONY_CSS, new RegExp(`data-moony-ear=["']${ear}["']`));
	}
	for (const pet of MOONY_CATALOG) {
		const tree = MoonyPet({ petId: pet.id, agentStatus: 'idle', isPlaying: true });
		assert.equal(tree.props['data-moony-motion'], pet.motion);
		assert.match(MOONY_CSS, new RegExp(`data-moony-motion=["']${pet.motion}["']\\]\\.singing \\.dsa-moony-rhythm\\{animation:dsa-moony-dance-${pet.id}-body`));
		assert.match(MOONY_CSS, new RegExp(`dsa-agent-idle\\[data-moony-motion=["']${pet.motion}["']\\][^}]*\\.dsa-moony-ear\\{animation:dsa-moony-idle-${pet.motion}`));
	}
	for (const tail of ['orbit', 'comet', 'curl', 'needle']) {
		assert.match(MOONY_CSS, new RegExp(`data-moony-tail=["']${tail}["']`));
	}
	assert.match(MOONY_CSS, /--moony-signal/);
	assert.match(MOONY_CSS, /prefers-reduced-motion:\s*reduce[^}]*\.dsa-moony-rhythm,.dsa-moony-ear,.dsa-moony-ear::after,.dsa-moony-tail,.dsa-moony-phase-gap\{animation:none!important/);
	assert.match(MOONY_CSS, /dsa-agent-running \.dsa-moony-tail/);
	assert.match(MOONY_CSS, /dsa-agent-failed \.dsa-moony-tail/);
	assert.doesNotMatch(MOONY_CSS, /dsa-agent-running[^}]*background:/);
});

test('playing Moony gives every character its own stable dance choreography', () => {
	const { MOONY_CSS, MoonyPet } = loadClient();
	const dances = [
		['classic', 'float'], ['pulse', 'beat'], ['echo', 'orbit'], ['drift', 'drift'],
		['spark', 'scan'], ['chorus', 'chorus'], ['hush', 'hush'], ['loop', 'loop'],
		['bass', 'bass'], ['vinyl', 'vinyl']
	];
	for (const [petId, motion] of dances) {
		const tree = MoonyPet({ petId, isPlaying: true });
		assert.match(tree.props.className, /\bsinging\b/);
		assert.equal(tree.props['data-moony-motion'], motion);
		assert.match(MOONY_CSS, new RegExp(`@keyframes dsa-moony-dance-${petId}-body`));
		assert.match(MOONY_CSS, new RegExp(`@keyframes dsa-moony-dance-${petId}-ear`));
	}

	assert.match(MOONY_CSS, /data-moony-motion='float'\]\.singing \.dsa-moony-ear\{animation:dsa-moony-dance-classic-ear \.8s/);
	assert.match(MOONY_CSS, /data-moony-motion='beat'\]\.singing \.dsa-moony-ear\.right\{animation-delay:-\.36s\}/);
	assert.match(MOONY_CSS, /data-moony-motion='orbit'\]\.singing \.dsa-moony-ear\.left\{animation-delay:-\.36s\}/);
	assert.match(MOONY_CSS, /data-moony-motion='orbit'\]\.singing \.dsa-moony-ear\.right\{animation-delay:-\.18s\}/);
	assert.match(MOONY_CSS, /data-moony-motion='orbit'\]\.singing \.dsa-moony-tail\{animation:dsa-moony-dance-echo-tail 1\.4s/);
	assert.match(MOONY_CSS, /data-moony-motion='drift'\]\.singing \.dsa-moony-tail\{animation:dsa-moony-dance-drift-tail 3\.8s/);
	assert.match(MOONY_CSS, /data-moony-motion='scan'\]\.singing \.dsa-moony-ear::after\{[^}]*animation:dsa-moony-dance-spark-flash 2\.4s/);
	assert.match(MOONY_CSS, /data-moony-motion='chorus'\]\.singing \.dsa-moony-tail\{animation:dsa-moony-dance-chorus-tail 4\.8s/);
	assert.match(MOONY_CSS, /data-moony-motion='hush'\]\.singing \.dsa-moony-rhythm\{animation:dsa-moony-dance-hush-body 4\.8s/);
	assert.doesNotMatch(MOONY_CSS, /dsa-moony-music-(?:ear|tail)/);
});

test('retained listening-style characters keep their identity outside the blank face', () => {
	const { MOONY_CSS, MoonyPet } = loadClient();
	const vinyl = MoonyPet({ petId: 'vinyl', mediaUrl: null });
	assert.equal(findNodes(vinyl, (node) => node.props?.['data-moony-tail'] === 'needle').length, 1);
	assert.equal(findNodes(vinyl, (node) => node.type === 'img').length, 0);
	assert.match(MOONY_CSS, /data-moony-ear='loop'[^}]*background:transparent/);
	assert.match(MOONY_CSS, /data-moony-ear='bass'[^}]*height:2\dpx/);
	assert.match(MOONY_CSS, /data-moony-tail='needle'/);
	assert.match(MOONY_CSS, /\.dsa-moony-menu\{[^}]*max-height:[^;}]+;[^}]*overflow-y:auto/);
});

test('Echo idle tail sways through a finite arc instead of completing a full orbit', () => {
	const { MOONY_CSS } = loadClient();
	const idleRule = MOONY_CSS.match(/data-moony-motion='orbit'\] \.dsa-moony-tail\{([^}]*)\}/)?.[1];
	const keyframes = MOONY_CSS.match(/@keyframes dsa-moony-idle-tail-orbit\{([^]*?)\}@keyframes dsa-moony-idle-tail-drift/)?.[1];
	assert.ok(idleRule && keyframes);
	assert.match(idleRule, /ease-in-out infinite alternate/);
	assert.doesNotMatch(idleRule, /\blinear\b/);
	assert.doesNotMatch(keyframes, /(?:1turn|360deg)/);

	const angles = Array.from(keyframes.matchAll(/rotate:(-?\d+(?:\.\d+)?)deg/g), (match) => Number(match[1]));
	assert.ok(angles.length >= 2, 'the sway must define both ends of its arc');
	assert.ok(Math.max(...angles) - Math.min(...angles) <= 24, 'the sway arc must stay narrow enough to remain behind the face');
});

test('Drift keeps its drooping ears and comet visible around a media face', () => {
	const { MOONY_CSS } = loadClient();
	const earRule = MOONY_CSS.match(/data-moony-ear='drift'\] \.dsa-moony-ear\{([^}]*)\}/)?.[1];
	const leftRule = MOONY_CSS.match(/data-moony-ear='drift'\] \.left\{([^}]*)\}/)?.[1];
	const cometRule = MOONY_CSS.match(/data-moony-tail='comet'\]\{([^}]*)\}/)?.[1];
	assert.ok(earRule && leftRule && cometRule);

	const px = (rule, property) => Number(rule.match(new RegExp(`${property}:(-?\\d+)px`))?.[1]);
	assert.ok(px(earRule, 'top') <= -16, 'Drift ear tips must remain visibly above the media face');
	assert.ok(px(earRule, 'height') >= 58, 'Drift ears must retain their long drooping silhouette');
	assert.ok(px(leftRule, 'left') <= -7, 'Drift ears must remain visible beside the media face');
	assert.ok(-px(cometRule, 'right') >= 16, 'Drift comet must extend clearly beyond the media face');
	assert.doesNotMatch(cometRule, /transparent/, 'the exposed comet tip must keep visible character color');
});

test('Moony stacks tails behind the face and ears with their signals in front', () => {
	const { MOONY_CSS } = loadClient();
	const rule = (selector) => MOONY_CSS.match(new RegExp(`${selector}\\{([^}]*)\\}`))?.[1];
	const zIndex = (body) => Number(body?.match(/z-index:(-?\d+)/)?.[1]);
	const tailZ = zIndex(rule('\\.dsa-moony-tail'));
	const faceZ = zIndex(rule('\\.dsa-moony-face'));
	const earZ = zIndex(rule('\\.dsa-moony-ear'));
	const signalZ = zIndex(rule('\\.dsa-moony-signal'));

	assert.ok(tailZ < faceZ, 'every tail must stay behind the media face');
	assert.ok(faceZ < earZ, 'every ear must remain visible in front of the media face');
	assert.ok(earZ < signalZ, 'ear-tip signals must be the frontmost identity layer');
});

test('Moony signal states glow at the ear outline without replacing base ear color', () => {
	const { MOONY_CSS } = loadClient();
	for (const state of ['running', 'waiting', 'failed', 'review']) {
		assert.match(MOONY_CSS, new RegExp(`dsa-agent-${state} \\.dsa-moony-ear`));
		assert.doesNotMatch(MOONY_CSS, new RegExp(`dsa-agent-${state}[^}]*background:`));
	}
	assert.match(MOONY_CSS, /border-color:var\(--moony-signal\)/);
	assert.match(MOONY_CSS, /drop-shadow\(0 0 5px var\(--moony-signal\)\)/);
	assert.match(MOONY_CSS, /dsa-agent-failed \.dsa-moony-ear\{[^}]*animation:dsa-moony-failed \.24s linear 3/);
	assert.doesNotMatch(MOONY_CSS, /@keyframes dsa-moony-(?:running|waiting|failed|review)[^{]*\{[^}]*transform:/);
});

test('Hush exposes its complete front-layer signal above the media face', () => {
	const { MOONY_CSS } = loadClient();
	const hushRule = MOONY_CSS.match(/data-moony-ear='hush'\] \.dsa-moony-ear\{([^}]*)\}/)?.[1];
	const earRule = MOONY_CSS.match(/\.dsa-moony-ear\{([^}]*)\}/)?.[1];
	const faceRule = MOONY_CSS.match(/\.dsa-moony-face\{([^}]*)\}/)?.[1];
	const signalRule = MOONY_CSS.match(/\.dsa-moony-signal\{([^}]*)\}/)?.[1];
	assert.ok(hushRule && earRule && faceRule && signalRule);
	const hushTop = Number(hushRule.match(/top:(-\d+)px/)?.[1]);
	const signalTop = Number(signalRule.match(/top:(\d+)px/)?.[1]);
	const signalHeight = Number(signalRule.match(/height:(\d+)px/)?.[1]);
	assert.ok(-hushTop >= signalTop + signalHeight, 'Hush must expose the full ear signal above the face');
	const zIndex = (rule) => Number(rule.match(/z-index:(-?\d+)/)?.[1]);
	assert.ok(zIndex(earRule) > zIndex(faceRule));
	assert.ok(zIndex(signalRule) > zIndex(earRule));
});

test('running reversal only targets the Moony right ear', () => {
	const { MOONY_CSS } = loadClient();
	assert.match(MOONY_CSS, /\.dsa-agent-running \.dsa-moony-ear\.right\{animation-direction:alternate-reverse/);
	assert.doesNotMatch(MOONY_CSS, /\.dsa-agent-running \.right\{/);
});

test('standalone gallery loads the real client entry instead of copying character definitions', () => {
	const html = readFileSync(new URL('../demo/moony-gallery.html', import.meta.url), 'utf8');
	assert.match(html, /<script src="\.\.\/client\.js"><\/script>/);
	assert.match(html, /MOONY_CATALOG/);
	assert.match(html, /MoonyPet/);
	assert.doesNotMatch(html, /id:\s*["']pulse["']/);
});
