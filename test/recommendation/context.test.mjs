import test from 'node:test';
import assert from 'node:assert/strict';

import { buildButtonContext } from '../../lib/recommendation/context.js';
import { normalizeTrack } from '../../lib/recommendation/identity.js';

const emptyProfile = { version: 2, tracks: {}, artists: {}, rules: [], resolverStats: {} };

test('button context is identical in the morning and late at night', () => {
	const morning = buildButtonContext({ now: new Date(2026, 7, 23, 8, 0), profile: emptyProfile });
	const night = buildButtonContext({ now: new Date(2026, 7, 23, 23, 30), profile: emptyProfile });
	assert.deepEqual(morning, night);
	assert.equal(morning.energyHint, 'balanced');
	assert.equal('timeBand' in morning, false);
	assert.equal('hour' in morning, false);
	assert.equal('at' in morning, false);
});

test('explicit activity and playback facts are preserved without reading chat history', () => {
	const currentTrack = normalizeTrack({ name: '晴天', artists: '周杰伦' }, 'player');
	const recent = normalizeTrack({ name: '七里香', artists: '周杰伦' }, 'history');
	const cx = buildButtonContext({
		now: new Date('2026-08-23T15:00:00+08:00'),
		profile: emptyProfile,
		activity: 'focus',
		currentTrack,
		recentTracks: [recent],
		recentRecommendedTrackKeys: [recent.trackKey],
		queue: [currentTrack, recent]
	});
	assert.equal(cx.activity, 'focus');
	assert.equal(cx.currentTrack.trackKey, currentTrack.trackKey);
	assert.deepEqual(cx.recentTrackKeys, [recent.trackKey]);
	assert.deepEqual(cx.recentRecommendedTrackKeys, [recent.trackKey]);
	assert.deepEqual(cx.queueTrackKeys, [currentTrack.trackKey, recent.trackKey]);
	assert.equal('messages' in cx, false);
});
