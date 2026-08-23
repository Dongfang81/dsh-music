import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeTrack } from '../../lib/recommendation/identity.js';
import { createTasteProfile } from '../../lib/recommendation/profile.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-23T12:00:00+08:00').getTime();
const jay = normalizeTrack({ name: '晴天', artists: '周杰伦', durationMs: 269000 }, 'test');

test('favorite outweighs one accidental short skip', async () => {
	const profile = createTasteProfile({ file: null, now: () => NOW });
	await profile.record({ type: 'favorite', track: jay, at: NOW });
	await profile.record({ type: 'skip-short', track: jay, at: NOW + 1000 });

	const entry = (await profile.snapshot()).tracks[jay.trackKey];
	assert.equal(entry.events.favorite, 1);
	assert.equal(entry.events['skip-short'], 1);
	assert.ok(entry.affinity > 0);
});

test('old positive affinity decays without becoming negative', async () => {
	let clock = NOW;
	const profile = createTasteProfile({ file: null, now: () => clock });
	await profile.record({ type: 'favorite', track: jay, at: clock });
	const initial = (await profile.snapshot()).tracks[jay.trackKey].affinity;

	clock += 90 * DAY;
	const decayed = (await profile.snapshot()).tracks[jay.trackKey].affinity;
	assert.ok(decayed > 0);
	assert.ok(decayed < initial / 2);
});

test('migrates legacy facts without inventing negative feedback', async () => {
	const profile = createTasteProfile({ file: null, now: () => NOW });
	await profile.migrateLegacy({
		songs: [{ id: 1, name: '七里香', artists: '周杰伦', album: '七里香', plays: 4, seconds: 800, completed: 2, lastAt: NOW - DAY }],
		byHour: new Array(24).fill(0)
	});

	const snapshot = await profile.snapshot();
	const [entry] = Object.values(snapshot.tracks);
	assert.equal(entry.title, '七里香');
	assert.ok(entry.affinity > 0);
	assert.equal(entry.events['skip-short'] ?? 0, 0);
	assert.equal(entry.events.dislike ?? 0, 0);
});

test('remember validates explicit rules and forget removes only the selected rule', async () => {
	const profile = createTasteProfile({ file: null, now: () => NOW });
	await assert.rejects(() => profile.remember({ kind: 'artist', value: ' ' }), /value/);
	const first = await profile.remember({ kind: 'artist', value: '周杰伦', weight: 1 });
	await profile.remember({ kind: 'language', value: 'zh', weight: 0.5 });
	await profile.forget(first.id);

	const snapshot = await profile.snapshot();
	assert.deepEqual(snapshot.rules.map((rule) => rule.value), ['zh']);
});

test('persists version 2 atomically and reloads it', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'moony-profile-'));
	const file = join(dir, 'profile.json');
	const profile = createTasteProfile({ file, now: () => NOW });
	await profile.record({ type: 'search-play', track: jay, at: NOW });
	await profile.flush();

	const disk = JSON.parse(await readFile(file, 'utf8'));
	assert.equal(disk.version, 2);
	const reloaded = createTasteProfile({ file, now: () => NOW });
	assert.equal((await reloaded.snapshot()).tracks[jay.trackKey].events['search-play'], 1);
});

test('clear removes tracks, rules, and resolver history from memory and disk', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'moony-profile-clear-'));
	const file = join(dir, 'profile.json');
	const profile = createTasteProfile({ file, now: () => NOW });
	await profile.record({ type: 'favorite', track: jay, at: NOW });
	await profile.remember({ kind: 'artist', value: '周杰伦', weight: 1 });
	await profile.reportSource({ sourceKey: 'kuwo', ok: true });
	await profile.clear();

	const snapshot = await profile.snapshot();
	assert.equal(snapshot.version, 2);
	assert.deepEqual(snapshot.tracks, {});
	assert.deepEqual(snapshot.rules, []);
	assert.deepEqual(snapshot.resolverStats, {});
	const disk = JSON.parse(await readFile(file, 'utf8'));
	assert.deepEqual(disk.tracks, {});
});
