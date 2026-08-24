import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createPlayer } from '../lib/player.js';
import { normalizeTrack } from '../lib/recommendation/identity.js';

const song = (id, name) => ({ id, name, ar: [{ name: `歌手${id}` }] });

test('recommendations insert after current without replacing manual songs', () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([song(1, '当前'), song(2, '手动加入')]);
	player.insertRecommendationAfterCurrent([song(3, '推荐一'), song(4, '推荐二')], 'session-1');
	assert.deepEqual(player.state.queue.map((item) => item.name), ['当前', '推荐一', '推荐二', '手动加入']);
	assert.equal(player.current().name, '当前');
	assert.deepEqual(player.state.queue.map((item) => item.moonyOrigin), ['manual', 'recommendation', 'recommendation', 'manual']);
});

test('same-session replan replaces only its unplayed recommendation entries', () => {
	const player = createPlayer({ file: null });
	player.replaceAndPlay([song(1, '当前'), song(2, '手动加入')]);
	player.insertRecommendationAfterCurrent([song(3, '旧推荐一'), song(4, '旧推荐二')], 'session-1');
	player.insertRecommendationAfterCurrent([song(5, '新推荐')], 'session-1');
	assert.deepEqual(player.state.queue.map((item) => item.name), ['当前', '新推荐', '手动加入']);
	assert.equal(player.state.queue[1].recommendationSessionId, 'session-1');
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

test('recommendation starts its first verified track when nothing is active', () => {
	const player = createPlayer({ file: null });
	player.insertRecommendationAfterCurrent([song(7, '第一首推荐'), song(8, '第二首推荐')], 'session-empty');
	assert.equal(player.current().name, '第一首推荐');
	assert.equal(player.state.playing, true);
});

test('legacy favorites load into an immutable virtual all collection', (t) => {
	const directory = mkdtempSync(join(tmpdir(), 'moony-player-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const file = join(directory, 'state.json');
	writeFileSync(file, JSON.stringify({ favorites: [song(1, '晴天'), song(2, '夜曲')] }));

	const player = createPlayer({ file });
	assert.deepEqual(player.listFavoriteCollections(), [{
		id: 'all', name: '全部收藏', songIds: [1, 2], count: 2, system: true
	}]);
	assert.deepEqual(player.favoriteCollection('all').songs.map((item) => item.id), [1, 2]);
	assert.throws(() => player.renameFavoriteCollection('all', '别的名字'), /不能重命名/);
	assert.throws(() => player.deleteFavoriteCollection('all'), /不能删除/);
});

test('custom collections support multiple memberships without changing global favorite semantics', () => {
	const ids = ['focus', 'night'];
	const player = createPlayer({ file: null, createCollectionId: () => ids.shift() });
	player.replaceAndPlay([song(1, '晴天'), song(2, '夜曲')]);
	player.toggleFavorite();
	player.jump(1);
	player.toggleFavorite();

	const focus = player.createFavoriteCollection('工作');
	const night = player.createFavoriteCollection('夜晚');
	assert.equal(focus.id, 'focus');
	assert.equal(night.id, 'night');
	player.setFavoriteMemberships(1, ['focus', 'night']);
	player.setFavoriteMemberships(2, ['night']);
	assert.deepEqual(player.favoriteCollection('focus').songs.map((item) => item.id), [1]);
	assert.deepEqual(player.favoriteCollection('night').songs.map((item) => item.id), [1, 2]);

	player.renameFavoriteCollection('focus', '专注');
	assert.equal(player.favoriteCollection('focus').name, '专注');
	assert.throws(() => player.createFavoriteCollection(' 专注 '), /已存在/);
	player.deleteFavoriteCollection('focus');
	assert.deepEqual(player.state.favorites.map((item) => item.id), [1, 2]);

	player.jump(0);
	const unfavorited = player.toggleFavorite();
	assert.equal(unfavorited.favorite, false);
	assert.deepEqual(player.favoriteCollection('all').songs.map((item) => item.id), [2]);
	assert.deepEqual(player.favoriteCollection('night').songs.map((item) => item.id), [2]);
});
