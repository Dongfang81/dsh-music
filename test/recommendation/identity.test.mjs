import test from 'node:test';
import assert from 'node:assert/strict';

import {
	classifyVersion,
	dedupeTracks,
	isRequestedVersion,
	isPlaceholderArtist,
	normalizeTrack,
	trackKey
} from '../../lib/recommendation/identity.js';

test('keeps an original recording separate from a cover', () => {
	const original = normalizeTrack({ name: '晴天', ar: [{ name: '周杰伦' }], dt: 269000 }, 'netease');
	const cover = normalizeTrack({ name: '晴天 (原唱 周杰伦)', ar: [{ name: 'RyaVocal' }], dt: 250000 }, 'netease');

	assert.notEqual(original.trackKey, cover.trackKey);
	assert.equal(isRequestedVersion(cover, { title: '晴天', artists: ['周杰伦'] }), false);
	assert.equal(isRequestedVersion(original, { title: '晴天', artists: ['周杰伦'] }), true);
});

test('deduplicates punctuation variants with the same artist and nearby duration', () => {
	const tracks = [
		normalizeTrack({ name: '七里香', artists: '周杰伦', durationMs: 299000 }, 'history'),
		normalizeTrack({ name: '七里香！', ar: [{ name: '周杰伦' }], dt: 300500 }, 'netease')
	];

	const [merged] = dedupeTracks(tracks);
	assert.equal(dedupeTracks(tracks).length, 1);
	assert.deepEqual(merged.origins, ['history', 'netease']);
});

test('does not deduplicate materially different durations without an ISRC', () => {
	const radio = normalizeTrack({ name: '夜曲', artists: '周杰伦', durationMs: 226000 }, 'local');
	const extended = normalizeTrack({ name: '夜曲', artists: '周杰伦', durationMs: 245000 }, 'online');

	assert.equal(dedupeTracks([radio, extended]).length, 2);
});

test('uses matching ISRC as the strongest identity', () => {
	const a = normalizeTrack({ name: 'Song A', artists: 'Singer', durationMs: 200000, isrc: ' CN-A01-23-00001 ' }, 'a');
	const b = normalizeTrack({ name: 'Song A (Album Version)', artists: 'Singer', durationMs: 204000, isrc: 'cn-a01-23-00001' }, 'b');

	assert.equal(trackKey(a), trackKey(b));
	assert.equal(dedupeTracks([a, b]).length, 1);
});

test('classifies common non-original versions', () => {
	assert.deepEqual(classifyVersion('默 (Live)'), ['live']);
	assert.deepEqual(classifyVersion('晴天（翻唱：周杰伦）'), ['cover']);
	assert.deepEqual(classifyVersion('七里香 伴奏 Remix'), ['accompaniment', 'remix']);
	assert.deepEqual(classifyVersion('歌曲串烧（纯音乐）'), ['instrumental', 'medley']);
});

test('rejects malformed empty tracks instead of creating a shared empty identity', () => {
	assert.equal(normalizeTrack(null, 'bad'), null);
	assert.equal(normalizeTrack({ name: ' ', artists: '' }, 'bad'), null);
});

test('rejects coerced object placeholder artists without banning a real Object artist', () => {
	assert.equal(isPlaceholderArtist('[Object Object]'), true);
	assert.equal(isPlaceholderArtist('Object Object'), true);
	assert.equal(isPlaceholderArtist('Object'), false);
	assert.equal(normalizeTrack({ name: '坏数据', artists: ['[Object Object]'] }, 'bad'), null);
	assert.equal(normalizeTrack({ name: '坏数据', artists: [{}] }, 'bad'), null);
	assert.equal(normalizeTrack({ name: '坏数据', artists: [{ name: { nested: true } }] }, 'bad'), null);
	assert.equal(normalizeTrack({ name: '合法歌曲', artists: ['Object'] }, 'good').artists[0], 'Object');
});
