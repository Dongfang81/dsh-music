import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createPlayer } from '../lib/player.js';
import { normalizeTrack } from '../lib/recommendation/identity.js';

const song = (id, name) => ({ id, name, ar: [{ name: `歌手${id}` }] });
const radioSong = (id, name) => ({ ...song(id, name), trackKey: `track-${id}` });

test('recommendation radio replaces the whole queue and preserves favorites', () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([song(1, '手动一'), song(2, '手动二')]);
	player.toggleFavorite();

	const result = player.startRecommendationRadio(
		[radioSong(30, '推荐一'), radioSong(31, '推荐二')],
		'radio-1'
	);

	assert.deepEqual(player.state.queue.map((item) => item.name), ['推荐一', '推荐二']);
	assert.equal(player.current().name, '推荐一');
	assert.equal(player.state.playing, true);
	assert.deepEqual(player.state.favorites.map((item) => item.id), [1]);
	assert.equal(result.sessionId, 'radio-1');
	assert.equal(result.batchNumber, 1);
	assert.equal(result.count, 2);
	assert.deepEqual(player.radioStatus().seenTrackKeys, ['track-30', 'track-31']);
});

test('recommendation radio replaces a completed batch and remembers every delivered track', () => {
	const player = createPlayer({ file: null });
	player.startRecommendationRadio([radioSong(30, '第一批一'), radioSong(31, '第一批二')], 'radio-1');
	player.jump(1);
	assert.equal(player.isRecommendationRadioBoundary(), true);

	const result = player.replaceRecommendationRadioBatch([radioSong(40, '第二批一'), radioSong(41, '第二批二')]);

	assert.deepEqual(player.state.queue.map((item) => item.name), ['第二批一', '第二批二']);
	assert.equal(player.current().name, '第二批一');
	assert.equal(result.batchNumber, 2);
	assert.deepEqual(player.radioStatus().seenTrackKeys, ['track-30', 'track-31', 'track-40', 'track-41']);
});

test('recommendation radio survives restart with its batch cursor and waiting state', async (t) => {
	const directory = mkdtempSync(join(tmpdir(), 'moony-radio-player-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const file = join(directory, 'state.json');
	const player = createPlayer({ file, saveDelayMs: 60000 });
	player.startRecommendationRadio([radioSong(30, '推荐一'), radioSong(31, '推荐二')], 'radio-restart');
	player.jump(1);
	player.setRecommendationRadioWaiting(true);
	await player.dispose();

	const restored = createPlayer({ file });
	assert.deepEqual(restored.state.queue.map((item) => item.name), ['推荐一', '推荐二']);
	assert.equal(restored.state.index, 1);
	assert.deepEqual(restored.radioStatus(), {
		active: true,
		sessionId: 'radio-restart',
		batchNumber: 1,
		seenTrackKeys: ['track-30', 'track-31'],
		waitingForNextBatch: true
	});
});

test('manual queue takeover exits recommendation radio while passive controls keep it active', () => {
	const player = createPlayer({ file: null });
	player.startRecommendationRadio([radioSong(30, '推荐一'), radioSong(31, '推荐二')], 'radio-takeover');
	player.toggleFavorite();
	player.jump(1);
	assert.equal(player.radioStatus()?.active, true);

	player.append([song(9, '手动加入')]);
	assert.equal(player.radioStatus(), null);
	assert.deepEqual(player.state.queue.map((item) => item.name), ['推荐一', '推荐二', '手动加入']);
});

test('every manual queue replacement path exits recommendation radio', () => {
	const scenarios = [
		['replaceAndPlay', (player) => player.replaceAndPlay([song(9, '手动')])],
		['playSong', (player) => player.playSong(song(9, '手动'))],
		['append', (player) => player.append([song(9, '手动')])],
		['insertNext', (player) => player.insertNext([song(9, '手动')])],
		['clearQueue', (player) => player.clearQueue()],
		['playFavorites', (player) => {
			player.toggleFavorite();
			player.playFavorites();
		}],
		['togglePlayMode', (player) => player.togglePlayMode()]
	];
	for (const [name, takeOver] of scenarios) {
		const player = createPlayer({ file: null });
		player.startRecommendationRadio([radioSong(30, '推荐一'), radioSong(31, '推荐二')], `radio-${name}`);
		takeOver(player);
		assert.equal(player.radioStatus(), null, name);
	}
});

test('batch-local controls do not exit recommendation radio', () => {
	const player = createPlayer({ file: null });
	player.startRecommendationRadio([radioSong(30, '推荐一'), radioSong(31, '推荐二')], 'radio-passive');
	player.toggleFavorite();
	player.jump(1);
	player.togglePlay();
	player.togglePlay();
	player.removeQueueAt(0);
	assert.equal(player.radioStatus()?.active, true);
});

test('recommendations insert after current without replacing manual songs', () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([song(1, '当前'), song(2, '手动加入')]);
	player.insertRecommendationAfterCurrent([song(3, '推荐一'), song(4, '推荐二')], 'session-1');
	assert.deepEqual(player.state.queue.map((item) => item.name), ['当前', '推荐一', '推荐二', '手动加入']);
	assert.equal(player.current().name, '当前');
	assert.deepEqual(player.state.queue.map((item) => item.moonyOrigin), ['manual', 'recommendation', 'recommendation', 'manual']);
});

test('button recommendation starts its first song while preserving manual queue entries', () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([song(1, '当前'), song(2, '手动加入')]);
	player.insertRecommendationAfterCurrent(
		[song(3, '推荐一'), song(4, '推荐二')],
		'button-recommendation',
		{ playFirst: true }
	);
	assert.deepEqual(player.state.queue.map((item) => item.name), ['当前', '推荐一', '推荐二', '手动加入']);
	assert.equal(player.current().name, '推荐一');
	assert.equal(player.state.index, 1);
	assert.equal(player.state.playing, true);
});

test('same-session replan replaces only its unplayed recommendation entries', () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([song(1, '当前'), song(2, '手动加入')]);
	player.insertRecommendationAfterCurrent([song(3, '旧推荐一'), song(4, '旧推荐二')], 'session-1');
	player.insertRecommendationAfterCurrent([song(5, '新推荐')], 'session-1');
	assert.deepEqual(player.state.queue.map((item) => item.name), ['当前', '新推荐', '手动加入']);
	assert.equal(player.state.queue[1].recommendationSessionId, 'session-1');
});

test('a second button batch replaces unplayed recommendations and preserves manual songs', () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([song(1, '当前'), song(2, '手动加入')]);
	player.insertRecommendationAfterCurrent([song(3, '旧推荐一'), song(4, '旧推荐二')], 'button-recommendation');
	player.insertRecommendationAfterCurrent([song(5, '新推荐一'), song(6, '新推荐二')], 'button-recommendation');
	assert.deepEqual(player.state.queue.map((item) => item.name), ['当前', '新推荐一', '新推荐二', '手动加入']);
	assert.equal(player.current().name, '当前');
});

test('canonical recommendation tracks are converted back to player song shape', () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([song(1, '当前')]);
	const canonical = {
		...normalizeTrack({ id: 9, name: '晴天', ar: [{ name: '周杰伦' }], al: { name: '叶惠美' }, dt: 269000 }, 'search'),
		url: 'https://audio.example/song'
	};
	player.insertRecommendationAfterCurrent([canonical], 'session-2');
	const queued = player.state.queue[1];
	assert.equal(queued.name, '晴天');
	assert.equal(queued.ar[0].name, '周杰伦');
	assert.equal(queued.resolvedUrl, 'https://audio.example/song');
	assert.equal(queued.trackKey, canonical.trackKey);
});

test('player snapshots normalize string and object artist entries at the client boundary', () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([{ id: 9, name: '一生所爱', artists: ['卢冠廷', { name: 'AGA' }] }]);
	assert.equal(player.queueView().items[0].artists, '卢冠廷 / AGA');
	assert.equal(player.snapshot().playing.artists, '卢冠廷 / AGA');
	assert.deepEqual(player.snapshot().playing.artistList, [
		{ id: null, name: '卢冠廷' },
		{ id: undefined, name: 'AGA' }
	]);
});

test('recommendation starts its first verified track when nothing is active', () => {
	const player = createPlayer({ file: null });
	player.insertRecommendationAfterCurrent([song(7, '第一首推荐'), song(8, '第二首推荐')], 'session-empty');
	assert.equal(player.current().name, '第一首推荐');
	assert.equal(player.state.playing, true);
});

test('favorites stay as one flat list when loading state written by the collection experiment', (t) => {
	const directory = mkdtempSync(join(tmpdir(), 'moony-player-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const file = join(directory, 'state.json');
	writeFileSync(file, JSON.stringify({
		favorites: [song(1, '晴天'), song(2, '夜曲')],
		favoriteCollections: [{ id: 'focus', name: '工作', songIds: [1] }]
	}));

	const player = createPlayer({ file });
	assert.deepEqual(player.state.favorites.map((item) => item.id), [1, 2]);
	assert.equal(player.state.favoriteCollections, undefined);
	assert.equal(player.snapshot().favoriteCollections, undefined);
	assert.equal(player.playFavorites().count, 2);
});

test('player flush atomically persists the latest debounced state before shutdown', async (t) => {
	const directory = mkdtempSync(join(tmpdir(), 'moony-player-flush-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const file = join(directory, 'state.json');
	const player = createPlayer({ file, saveDelayMs: 60000 });

	player.replaceAndPlay([song(1, '晴天')]);
	player.toggleFavorite();
	player.volumeDown();
	assert.equal(existsSync(file), false, 'the long debounce keeps disk I/O off the mutation path');
	await player.dispose();

	const saved = JSON.parse(readFileSync(file, 'utf8'));
	assert.deepEqual(saved.queue.map((item) => item.id), [1]);
	assert.deepEqual(saved.favorites.map((item) => item.id), [1]);
	assert.equal(saved.volume, 0.7);
	assert.equal(typeof saved.at, 'number');
	assert.equal(typeof player.flush, 'function');
});

test('playing favorites from one row keeps the full favorite list as playback context', () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([song(1, '晴天'), song(2, '夜曲'), song(3, '七里香')]);
	for (let index = 0; index < 3; index += 1) {
		player.jump(index);
		player.toggleFavorite();
	}
	const result = player.playFavorites(1);
	assert.equal(result.song.id, 2);
	assert.equal(result.count, 3);
	assert.deepEqual(player.state.queue.map((item) => item.id), [1, 2, 3]);
	assert.equal(player.state.index, 1);
});

test('removing a favorite by id preserves the current song and playback queue', () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([song(1, '晴天'), song(2, '夜曲'), song(3, '七里香')]);
	player.toggleFavorite();
	player.jump(1);
	player.toggleFavorite();
	const queueBefore = player.state.queue.map((item) => item.id);
	const currentBefore = player.current().id;

	const result = player.removeFavorite(1);

	assert.equal(result.removed.id, 1);
	assert.deepEqual(result.favoriteIds, [2]);
	assert.equal(result.count, 1);
	assert.deepEqual(player.state.queue.map((item) => item.id), queueBefore);
	assert.equal(player.current().id, currentBefore);
});

test('removing a non-current queue item preserves the active song and undo restores order', () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([song(1, '一'), song(2, '二'), song(3, '三'), song(4, '四')]);
	player.jump(2);

	const removed = player.removeQueueAt(0);
	assert.equal(removed.removed.id, 1);
	assert.equal(removed.currentChanged, false);
	assert.equal(player.current().id, 3);
	assert.equal(player.state.index, 1);
	assert.deepEqual(player.state.queue.map((item) => item.id), [2, 3, 4]);

	const restored = player.undoQueueRemoval(removed.token);
	assert.equal(restored.restored.id, 1);
	assert.equal(player.current().id, 3);
	assert.equal(player.state.index, 2);
	assert.deepEqual(player.state.queue.map((item) => item.id), [1, 2, 3, 4]);

	const after = player.removeQueueAt(3);
	assert.equal(after.currentChanged, false);
	assert.equal(player.current().id, 3);
});

test('removing the current queue item advances to next, falls back to previous, then stops when empty', () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([song(1, '一'), song(2, '二'), song(3, '三')]);
	player.jump(1);
	player.toggleFavorite();

	const middle = player.removeQueueAt(1);
	assert.equal(middle.currentChanged, true);
	assert.equal(player.current().id, 3);
	assert.equal(player.state.index, 1);
	assert.equal(player.state.playing, true);
	assert.deepEqual(player.state.favorites.map((item) => item.id), [2]);

	player.undoQueueRemoval(middle.token);
	assert.deepEqual(player.state.queue.map((item) => item.id), [1, 2, 3]);
	assert.equal(player.current().id, 3, 'undo restores the row without interrupting the song that took over');
	assert.equal(player.state.index, 2);

	const last = player.removeQueueAt(2);
	assert.equal(last.currentChanged, true);
	assert.equal(player.current().id, 2);
	assert.equal(player.state.index, 1);

	player.removeQueueAt(1);
	const only = player.removeQueueAt(0);
	assert.equal(only.currentChanged, true);
	assert.equal(player.current(), null);
	assert.equal(player.state.index, -1);
	assert.equal(player.state.playing, false);
	assert.equal(player.state.currentUrl, null);
});

test('queue removal validates indices and only the latest removal can be undone', () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([song(1, '一'), song(2, '二'), song(3, '三')]);
	assert.throws(() => player.removeQueueAt(-1), /下标/);
	assert.throws(() => player.removeQueueAt(3), /下标/);
	const first = player.removeQueueAt(2);
	const second = player.removeQueueAt(1);
	assert.throws(() => player.undoQueueRemoval(first.token), /已失效/);
	assert.equal(player.undoQueueRemoval(second.token).restored.id, 2);
});

test('player revisions change only for material state and collection mutations', () => {
	const player = createPlayer({ file: null });
	const initial = player.revisions();
	assert.deepEqual(initial, { stateRevision: 1, queueRevision: 1, favoritesRevision: 1 });
	player.reportPlayback({ position: 0, duration: 0, ready: false });
	player.append([]);
	assert.deepEqual(player.revisions(), initial, 'unchanged reports and empty appends do not invalidate state');

	player.append([song(1, '一')]);
	assert.deepEqual(player.revisions(), { stateRevision: 2, queueRevision: 2, favoritesRevision: 1 });
	player.jump(0);
	const beforeFavorite = player.revisions();
	player.toggleFavorite();
	assert.deepEqual(player.revisions(), {
		stateRevision: beforeFavorite.stateRevision + 1,
		queueRevision: beforeFavorite.queueRevision,
		favoritesRevision: beforeFavorite.favoritesRevision + 1
	});
});

test('compact snapshots omit collection rows while queueView provides revisioned rows', () => {
	const player = createPlayer({ file: null, instanceId: 'boot-a' });
	player.replaceAndPlay([song(1, '一'), song(2, '二')]);
	player.toggleFavorite();

	const legacy = player.snapshot();
	assert.equal(legacy.queue.items.length, 2);
	assert.deepEqual(legacy.favoriteIds, [1]);

	const compact = player.snapshot({ includeQueue: false, includeFavoriteIds: false });
	assert.equal(compact.instanceId, 'boot-a');
	assert.deepEqual(compact.queue, {
		count: 2,
		index: 0,
		revision: player.revisions().queueRevision
	});
	assert.deepEqual(compact.favorites, {
		count: 1,
		revision: player.revisions().favoritesRevision
	});
	assert.equal('favoriteIds' in compact, false);
	assert.equal(compact.stateRevision, player.revisions().stateRevision);
	assert.deepEqual(player.queueView(), {
		instanceId: 'boot-a',
		revision: player.revisions().queueRevision,
		count: 2,
		index: 0,
		items: [
			{ id: 1, name: '一', artists: '歌手1' },
			{ id: 2, name: '二', artists: '歌手2' }
		]
	});
});

test('each player boot identifies collection snapshots independently from numeric revisions', () => {
	const first = createPlayer({ file: null, instanceId: 'boot-a' });
	const restarted = createPlayer({ file: null, instanceId: 'boot-b' });
	assert.deepEqual(first.revisions(), restarted.revisions());
	assert.notEqual(first.snapshot().instanceId, restarted.snapshot().instanceId);
	assert.equal(first.queueView().instanceId, 'boot-a');
	assert.equal(restarted.queueView().instanceId, 'boot-b');
});
