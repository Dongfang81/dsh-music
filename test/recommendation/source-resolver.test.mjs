import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTrack } from '../../lib/recommendation/identity.js';
import { createSourceResolver } from '../../lib/recommendation/source-resolver.js';
import { safeCrossSourceDuration } from '../../lib/source-match.js';
import * as sourceMatch from '../../lib/source-match.js';

const jay = normalizeTrack({ id: 1, name: '晴天', artists: '周杰伦', durationMs: 269000 }, 'test');
const requested = { title: '晴天', artists: ['周杰伦'] };

function hit(kind, calls) {
	return async () => {
		calls.push(kind);
		return { url: `${kind}://song`, sourceKey: kind, confidence: 1, expiresAt: Date.now() + 60_000 };
	};
}

test('prefers local, then direct, then exact cross-source', async () => {
	const calls = [];
	const resolver = createSourceResolver({
		local: hit('local', calls),
		direct: hit('direct', calls),
		cross: hit('cross', calls)
	});
	assert.equal((await resolver.resolve(jay)).kind, 'local');
	assert.deepEqual(calls, ['local']);
});

test('does not use a cover duration to validate a requested original', async () => {
	let receivedDuration = -1;
	const cover = normalizeTrack({ name: '晴天（翻唱）', artists: 'A-Lin', durationMs: 300000 }, 'catalog');
	const resolver = createSourceResolver({
		cross: async (_track, options) => {
			receivedDuration = options.durationMs;
			return { url: 'cross://original', sourceKey: 'kuwo', confidence: 0.95, matchedIdentity: requested };
		}
	});
	assert.equal((await resolver.resolve(cover, requested)).kind, 'cross-source');
	assert.equal(receivedDuration, 0);
});

test('duration is trusted only for exact title and exact artist tokens', () => {
	assert.equal(safeCrossSourceDuration(jay, requested), 269000);
	assert.equal(safeCrossSourceDuration({ ...jay, artists: ['周杰伦-'] }, requested), 0);
	assert.equal(safeCrossSourceDuration({ ...jay, artists: ['小周杰伦'] }, requested), 0);
	assert.equal(safeCrossSourceDuration({ ...jay, title: '晴天 Live' }, requested), 0);
});

test('strict cross-source audio accepts only adequate bitrate and matching calculated duration', () => {
	assert.equal(typeof sourceMatch.qualifyMatchedAudio, 'function');
	const song = { name: '大梦 (Live)', ar: [{ name: '瓦依那' }, { name: '任素汐' }], dt: 475000 };
	const exactBytes = Math.round(192000 * 475 / 8);
	assert.equal(sourceMatch.qualifyMatchedAudio({
		url: 'https://audio.test/exact.mp3', source: 'migu', br: 192000, size: exactBytes
	}, song)?.url, 'https://audio.test/exact.mp3');
	assert.equal(sourceMatch.qualifyMatchedAudio({
		url: 'https://audio.test/low.mp3', source: 'migu', br: 64000, size: Math.round(64000 * 475 / 8)
	}, song), null);
	assert.equal(sourceMatch.qualifyMatchedAudio({
		url: 'https://audio.test/wrong-version.mp3', source: 'migu', br: 192000, size: Math.round(192000 * 360 / 8)
	}, song), null);
	assert.equal(sourceMatch.qualifyMatchedAudio({
		url: 'https://audio.test/unverifiable.mp3', source: 'migu', br: null, size: 0
	}, song), null);
});

test('explicit original rejects low-confidence or cover cross-source identities', async () => {
	const low = createSourceResolver({
		cross: async () => ({ url: 'cross://maybe', sourceKey: 'x', confidence: 0.89, matchedIdentity: requested })
	});
	assert.equal(await low.resolve(jay, requested), null);
	const cover = createSourceResolver({
		cross: async () => ({
			url: 'cross://cover',
			sourceKey: 'x',
			confidence: 0.99,
			matchedIdentity: { title: '晴天（翻唱）', artists: ['A-Lin'] }
		})
	});
	assert.equal(await cover.resolve(jay, requested), null);
});

test('cached URLs expire and source failures invalidate matching cache entries', async () => {
	let clock = 1000;
	let calls = 0;
	const resolver = createSourceResolver({
		now: () => clock,
		direct: async () => ({ url: `direct://${++calls}`, sourceKey: 'netease', confidence: 1, expiresAt: clock + 100 })
	});
	assert.equal((await resolver.resolve(jay)).url, 'direct://1');
	assert.equal((await resolver.resolve(jay)).url, 'direct://1');
	await resolver.reportFailure('netease');
	assert.equal((await resolver.resolve(jay)).url, 'direct://2');
	clock += 101;
	assert.equal((await resolver.resolve(jay)).url, 'direct://3');
});
