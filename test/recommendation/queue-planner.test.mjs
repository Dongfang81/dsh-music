import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTrack } from '../../lib/recommendation/identity.js';
import { planQueue } from '../../lib/recommendation/queue-planner.js';

function ranked(name, artist, total, confidence = 0.95, energy = 0.5, source = 'test') {
	const value = normalizeTrack({ name, artists: artist, durationMs: 240000 }, source);
	return { track: { ...value, playable: true, confidence, energy }, total };
}

const currentTrack = normalizeTrack({ name: '正在播放', artists: '当前歌手', durationMs: 200000 }, 'player');

test('keeps current song, avoids adjacent artists, and caps each artist at two', () => {
	const rankedTracks = [
		ranked('A1', '甲', 100), ranked('A2', '甲', 99), ranked('A3', '甲', 98),
		ranked('B1', '乙', 97), ranked('C1', '丙', 96), ranked('B2', '乙', 95),
		ranked('D1', '丁', 94), ranked('E1', '戊', 93)
	];
	const plan = planQueue({ ranked: rankedTracks, targetSize: 7, rng: () => 0.5, currentTrack, existingQueue: [currentTrack] });
	assert.equal(plan.insertAfterTrackKey, currentTrack.trackKey);
	assert.ok(plan.tracks.every((track) => track.trackKey !== currentTrack.trackKey));
	for (let index = 1; index < plan.tracks.length; index += 1) {
		assert.notEqual(plan.tracks[index - 1].artists[0], plan.tracks[index].artists[0]);
	}
	const counts = plan.tracks.reduce((all, item) => ({ ...all, [item.artists[0]]: (all[item.artists[0]] || 0) + 1 }), {});
	assert.ok(Object.values(counts).every((count) => count <= 2));
});

test('relaxes the artist cap only when needed to fill the requested pool', () => {
	const plan = planQueue({
		ranked: [
			ranked('A1', '甲', 100), ranked('B1', '乙', 99),
			ranked('A2', '甲', 98), ranked('B2', '乙', 97),
			ranked('A3', '甲', 96), ranked('B3', '乙', 95)
		],
		targetSize: 6,
		rng: () => 0.5,
		currentTrack,
		existingQueue: []
	});

	assert.equal(plan.tracks.length, 6);
	for (let index = 1; index < plan.tracks.length; index += 1) {
		assert.notEqual(plan.tracks[index - 1].artists[0], plan.tracks[index].artists[0]);
	}
});

test('allows one fourth song from an artist only to close the final pool shortfall', () => {
	const diverse = Array.from({ length: 56 }, (_, index) => ranked(`独立${index + 1}`, `歌手${index + 1}`, 100 - index));
	const plan = planQueue({
		ranked: diverse.concat([
			ranked('A1', '甲', 40), ranked('A2', '甲', 39),
			ranked('A3', '甲', 38), ranked('A4', '甲', 37)
		]),
		targetSize: 60,
		rng: () => 0.5,
		currentTrack,
		existingQueue: []
	});

	assert.equal(plan.tracks.length, 60);
	assert.equal(plan.tracks.filter((track) => track.artists[0] === '甲').length, 4);
	for (let index = 1; index < plan.tracks.length; index += 1) {
		assert.notEqual(plan.tracks[index - 1].artists[0], plan.tracks[index].artists[0]);
	}
});

test('puts three high-confidence choices first and returns an honest short queue', () => {
	const rankedTracks = [
		ranked('低1', '甲', 100, 0.7), ranked('高1', '乙', 99, 0.96),
		ranked('高2', '丙', 98, 0.94), ranked('低2', '丁', 97, 0.8), ranked('高3', '戊', 96, 0.91)
	];
	const plan = planQueue({ ranked: rankedTracks, targetSize: 15, rng: () => 0.5, currentTrack, existingQueue: [] });
	assert.equal(plan.tracks.length, 5);
	assert.ok(plan.tracks.slice(0, 3).every((track) => track.confidence >= 0.9));
	assert.equal(plan.shortfall, 10);
});

test('keeps only one version of the same song identity', () => {
	const plan = planQueue({
		ranked: [ranked('晴天', '周杰伦', 100), ranked('晴天 Live', '周杰伦', 99), ranked('七里香', '周杰伦', 98)],
		targetSize: 3,
		rng: () => 0.5,
		currentTrack,
		existingQueue: []
	});
	assert.equal(plan.tracks.filter((track) => track.title.startsWith('晴天')).length, 1);
});

test('caps pure exploration tracks at twenty percent without penalizing mixed-origin tracks', () => {
	const exploration = Array.from({ length: 60 }, (_, index) => ranked(`探索${index}`, `探索歌手${index}`, 200 - index, 0.95, 0.5, 'exploration'));
	const reliable = Array.from({ length: 59 }, (_, index) => ranked(`可靠${index}`, `可靠歌手${index}`, 100 - index, 0.95, 0.5, 'artists'));
	const mixed = ranked('混合来源', '混合歌手', 199, 0.95, 0.5, 'exploration');
	mixed.track.origins.push('liked-neighbors');
	const plan = planQueue({
		ranked: [exploration[0], mixed, ...exploration.slice(1), ...reliable],
		targetSize: 60,
		maxExplorationRatio: 0.2,
		rng: () => 0.5,
		currentTrack,
		existingQueue: []
	});
	const pureExploration = plan.tracks.filter((track) => track.origins.length === 1 && track.origins[0] === 'exploration');
	assert.equal(plan.tracks.length, 60);
	assert.ok(plan.tracks.some((track) => track.trackKey === mixed.track.trackKey));
	assert.ok(pureExploration.length <= 12);
});
