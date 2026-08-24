import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTrack } from '../../lib/recommendation/identity.js';
import { rankCandidates, scoreCandidate } from '../../lib/recommendation/ranker.js';

function track(name, artist, extra = {}) {
	return { ...normalizeTrack({ name, artists: artist, durationMs: 240000 }, 'test'), playable: true, confidence: 0.95, ...extra };
}

const jay = track('晴天', '周杰伦');
const stranger = track('陌生歌曲', '新歌手', { origins: ['exploration'] });
const context = {
	weights: { taste: 0.5, context: 0.3, exploration: 0.2 },
	activity: 'focus',
	energyHint: 'gentle',
	recentTrackKeys: [],
	queueTrackKeys: []
};

test('favorite and completion rank above neutral exploration with visible reasons', () => {
	const profile = {
		tracks: { [jay.trackKey]: { affinity: 8, events: { favorite: 1, 'complete-80': 2 } } },
		artists: {}, rules: []
	};
	const liked = scoreCandidate(jay, context, profile);
	const unknown = scoreCandidate(stranger, context, profile);
	assert.ok(liked.total > unknown.total);
	assert.ok(liked.taste.reasons.some((reason) => reason.code === 'favorite'));
	assert.ok(liked.taste.score <= 50);
	assert.ok(liked.context.score <= 30);
	assert.ok(liked.exploration.score <= 20);
});

test('recent short skips produce a bounded penalty', () => {
	const skipped = track('总跳过', '某歌手');
	const profile = {
		tracks: { [skipped.trackKey]: { affinity: -4, events: { 'skip-short': 9 } } },
		artists: {}, rules: []
	};
	const scored = scoreCandidate(skipped, context, profile);
	assert.ok(scored.penalties.skip < 0);
	assert.ok(scored.penalties.skip >= -60);
});

test('recent recommendation history lowers rank without excluding the track', () => {
	const neutral = scoreCandidate(jay, context, { tracks: {}, artists: {}, rules: [] });
	const recent = scoreCandidate(jay, { ...context, recentRecommendedTrackKeys: [jay.trackKey] }, { tracks: {}, artists: {}, rules: [] });
	assert.equal(recent.excluded, false);
	assert.ok(recent.penalties.recentRecommendation < 0);
	assert.ok(recent.total < neutral.total);
});

test('newer recommendations receive a stronger penalty than older history', () => {
	const older = track('较早推荐', '甲');
	const newest = track('刚刚推荐', '乙');
	const history = [older.trackKey, ...Array.from({ length: 30 }, (_, index) => `middle-${index}`), newest.trackKey];
	const oldScore = scoreCandidate(older, { ...context, recentRecommendedTrackKeys: history }, { tracks: {}, artists: {}, rules: [] });
	const newScore = scoreCandidate(newest, { ...context, recentRecommendedTrackKeys: history }, { tracks: {}, artists: {}, rules: [] });
	assert.ok(newScore.penalties.recentRecommendation < oldScore.penalties.recentRecommendation);
});

test('unplayable and explicitly disliked tracks are filtered before ranking', () => {
	const unplayable = track('无地址', '甲', { playable: false });
	const disliked = track('不想听', '乙');
	const profile = {
		tracks: { [disliked.trackKey]: { affinity: -8, events: { dislike: 1 } } },
		artists: {}, rules: []
	};
	const ranked = rankCandidates({ candidates: [unplayable, disliked, jay], context, profile, rng: () => 0.5 });
	assert.deepEqual(ranked.map((item) => item.track.trackKey), [jay.trackKey]);
});

test('an explicit do-not-recommend artist rule is a hard exclusion', () => {
	const blocked = track('某首歌', '不想听的歌手');
	const profile = {
		tracks: {}, artists: {},
		rules: [{ id: 'rule-1', kind: 'artist', value: '不想听的歌手', weight: -1 }]
	};
	assert.deepEqual(rankCandidates({ candidates: [blocked, jay], context, profile, rng: () => 0.5 })
		.map((item) => item.track.trackKey), [jay.trackKey]);
});
