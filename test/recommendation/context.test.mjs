import test from 'node:test';
import assert from 'node:assert/strict';

import { buildButtonContext } from '../../lib/recommendation/context.js';
import { normalizeTrack } from '../../lib/recommendation/identity.js';

const emptyProfile = { version: 2, tracks: {}, artists: {}, rules: [], resolverStats: {} };

test('night is an energy hint, not an automatic sleep request', () => {
	const cx = buildButtonContext({
		// Recommendation context follows the DSH host's local clock. Construct a
		// host-local time so this assertion is stable in UTC CI and on user Macs.
		now: new Date(2026, 7, 23, 23, 30),
		profile: emptyProfile
	});
	assert.equal(cx.weights.taste, 0.5);
	assert.equal(cx.weights.context, 0.3);
	assert.equal(cx.weights.exploration, 0.2);
	assert.equal(cx.timeBand, 'late-night');
	assert.notEqual(cx.activity, 'sleep');
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
		queue: [currentTrack, recent]
	});
	assert.equal(cx.activity, 'focus');
	assert.equal(cx.currentTrack.trackKey, currentTrack.trackKey);
	assert.deepEqual(cx.recentTrackKeys, [recent.trackKey]);
	assert.deepEqual(cx.queueTrackKeys, [currentTrack.trackKey, recent.trackKey]);
	assert.equal('messages' in cx, false);
});
