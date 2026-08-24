import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRecommendationPool } from '../../lib/recommendation/pool.js';

function tracks(count, offset = 0) {
	return Array.from({ length: count }, (_, index) => ({
		trackKey: `track-${offset + index + 1}`,
		title: `歌曲${offset + index + 1}`,
		artists: [`歌手${offset + index + 1}`],
		raw: { id: offset + index + 1 },
		resolvedUrl: `https://expired.example/${offset + index + 1}`,
		expiresAt: Date.now() + 1000
	}));
}

async function fixture(options = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'moony-pool-'));
	const file = join(dir, 'pool.json');
	return { file, pool: createRecommendationPool({ file, ...options }) };
}

test('consumes 30 tracks from 60 and commits bounded recent history', async () => {
	const { pool } = await fixture();
	assert.equal((await pool.replace(tracks(60), { generationId: 'g1' })).ok, true);
	const result = await pool.consume(30);
	assert.equal(result.ok, true);
	assert.equal(result.tracks.length, 30);
	assert.equal(result.remaining, 30);
	assert.equal(result.ready, true);
	assert.equal(result.tracks[0].resolvedUrl, undefined);
	await pool.commit(result.transaction);
	const state = await pool.snapshot();
	assert.equal(state.items.length, 30);
	assert.equal(state.recentRecommendedTrackKeys.length, 30);
	assert.equal(state.pending, null);
	assert.equal(pool.needsRefill(), true);
});

test('restores a consumed batch when queue insertion fails', async () => {
	const { pool } = await fixture();
	await pool.replace(tracks(60), { generationId: 'g1' });
	const result = await pool.consume(30);
	await pool.restore(result.transaction);
	const state = await pool.snapshot();
	assert.equal(state.items.length, 60);
	assert.deepEqual(state.items.slice(0, 30).map((item) => item.trackKey), result.tracks.map((item) => item.trackKey));
	assert.deepEqual(state.recentRecommendedTrackKeys, []);
	assert.equal(state.pending, null);
});

test('requests a background top-up whenever the pool is below its 60-track target', async () => {
	const { pool } = await fixture();
	await pool.replace(tracks(58), { generationId: 'short-cold-start' });
	assert.equal((await pool.snapshot()).ready, true);
	assert.equal(pool.needsRefill(), true);
	await pool.replace(tracks(60, 100), { generationId: 'complete' });
	assert.equal(pool.needsRefill(), false);
});

test('recovers an uncommitted consumption after process restart', async () => {
	const { file, pool } = await fixture();
	await pool.replace(tracks(60), { generationId: 'g1' });
	await pool.consume(30);
	const restarted = createRecommendationPool({ file });
	await restarted.load();
	const state = await restarted.snapshot();
	assert.equal(state.items.length, 60);
	assert.equal(state.pending, null);
});

test('keeps only 120 recent track keys while allowing old keys back into the pool', async () => {
	const { pool } = await fixture();
	for (let batch = 0; batch < 5; batch += 1) {
		await pool.replace(tracks(60, batch * 60), { generationId: `g${batch}` });
		const result = await pool.consume(30);
		await pool.commit(result.transaction);
	}
	const state = await pool.snapshot();
	assert.equal(state.recentRecommendedTrackKeys.length, 120);
	assert.equal(state.recentRecommendedTrackKeys[0], 'track-61');
	assert.equal(state.recentRecommendedTrackKeys.at(-1), 'track-270');
	assert.equal((await pool.replace(tracks(60), { generationId: 'repeat' })).ok, true);
});

test('rejects duplicates and does not replace a complete pool with a short generation', async () => {
	const { pool } = await fixture();
	await assert.rejects(() => pool.replace([...tracks(59), tracks(1)[0]], { generationId: 'dupes' }), /duplicate/i);
	await pool.replace(tracks(60), { generationId: 'complete' });
	const result = await pool.replace(tracks(30, 100), { generationId: 'short' });
	assert.equal(result.ok, false);
	assert.equal((await pool.snapshot()).generationId, 'complete');
});

test('loads a corrupt file as an empty cold-start pool instead of throwing', async () => {
	const { file } = await fixture();
	await writeFile(file, '{broken', 'utf8');
	const pool = createRecommendationPool({ file });
	await pool.load();
	assert.equal((await pool.snapshot()).items.length, 0);
	assert.equal((await pool.snapshot()).ready, false);
	await pool.replace(tracks(30), { generationId: 'cold-start' });
	const persisted = JSON.parse(await readFile(file, 'utf8'));
	assert.equal(persisted.items.length, 30);
});
