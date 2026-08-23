import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { createHabits } from '../lib/habits.js';

const song = (id, name = 'Song' + id, artists = 'Artist') => ({ id, name, artists, album: 'Album' });

/** 可控时钟的纯内存记忆实例。 */
function makeHabits(baseTime) {
	let t = baseTime;
	const habits = createHabits({ file: null, now: () => t });
	return { habits, setTime: (v) => { t = v; } };
}

test('recordPlayback accumulates listening seconds and counts plays on song switch', async () => {
	const base = new Date(2026, 7, 21, 10, 0, 0).getTime(); // 上午 10 点（非深夜）
	const { habits } = makeHabits(base);
	await habits.recordPlayback({ song: song(1), position: 0, duration: 200, playing: true });
	await habits.recordPlayback({ song: song(1), position: 10, duration: 200, playing: true });
	await habits.recordPlayback({ song: song(1), position: 30, duration: 200, playing: true });
	await habits.recordPlayback({ song: song(2), position: 0, duration: 180, playing: true }); // 切歌
	await habits.recordPlayback({ song: song(2), position: 20, duration: 180, playing: true });
	const s = await habits.summary();
	assert.equal(s.totalPlays, 2);
	assert.equal(s.totalSeconds, 50);
	assert.equal(s.topSongs[0].name, 'Song1', 'top song is the one with most seconds');
	assert.equal(s.topSongs[0].seconds, 30);
	assert.equal(s.topSongs[1].seconds, 20);
});

test('guards: pause, backward jumps, and big seek jumps are not counted', async () => {
	const base = new Date(2026, 7, 21, 10, 0, 0).getTime();
	const { habits } = makeHabits(base);
	await habits.recordPlayback({ song: song(1), position: 0, duration: 300, playing: true });
	await habits.recordPlayback({ song: song(1), position: 30, duration: 300, playing: true }); // +30
	await habits.recordPlayback({ song: song(1), position: 40, duration: 300, playing: false }); // 暂停：不计
	await habits.recordPlayback({ song: song(1), position: 20, duration: 300, playing: true }); // 倒跳：不计
	await habits.recordPlayback({ song: song(1), position: 120, duration: 300, playing: true }); // 前进 100s：视为 seek 不计
	await habits.recordPlayback({ song: song(1), position: 130, duration: 300, playing: true }); // +10 计入
	const s = await habits.summary();
	assert.equal(s.topSongs[0].seconds, 40);
});

test('a song heard past 90% counts as completed when the next song starts', async () => {
	const base = new Date(2026, 7, 21, 10, 0, 0).getTime();
	const { habits } = makeHabits(base);
	await habits.recordPlayback({ song: song(1), position: 0, duration: 200, playing: true });
	await habits.recordPlayback({ song: song(1), position: 190, duration: 200, playing: true }); // 95%
	await habits.recordPlayback({ song: song(2), position: 0, duration: 200, playing: true }); // 切歌收尾
	const s = await habits.summary();
	assert.equal(s.topSongs.find((x) => x.name === 'Song1').completed, 1);
	assert.equal(s.topSongs.find((x) => x.name === 'Song2').completed, 0);
});

test('prune caps the song table at 300 keeping the most-heard ones', async () => {
	const base = new Date(2026, 7, 21, 10, 0, 0).getTime();
	const { habits } = makeHabits(base);
	for (let i = 1; i <= 305; i++) {
		await habits.recordPlayback({ song: song(i, 'S' + i), position: 0, duration: 300, playing: true });
		await habits.recordPlayback({ song: song(i, 'S' + i), position: 10, duration: 300, playing: true });
	}
	const s = await habits.summary();
	assert.equal(s.totalSongs, 300);
});

test('summary aggregates top songs, artists, today, and night activity', async () => {
	const base = new Date(2026, 7, 20, 23, 0, 0).getTime(); // 深夜 23:00
	const { habits } = makeHabits(base);
	await habits.recordPlayback({ song: song(1, 'A', 'ArtistX'), position: 0, duration: 300, playing: true });
	await habits.recordPlayback({ song: song(1, 'A', 'ArtistX'), position: 60, duration: 300, playing: true });
	await habits.recordPlayback({ song: song(2, 'B', 'ArtistY'), position: 0, duration: 300, playing: true });
	await habits.recordPlayback({ song: song(2, 'B', 'ArtistY'), position: 30, duration: 300, playing: true });
	await habits.recordPlayback({ song: song(3, 'C', 'ArtistX'), position: 0, duration: 300, playing: true });
	await habits.recordPlayback({ song: song(3, 'C', 'ArtistX'), position: 10, duration: 300, playing: true });
	const s = await habits.summary();
	assert.equal(s.totalPlays, 3);
	assert.equal(s.totalSeconds, 100);
	assert.equal(s.topSongs[0].name, 'A');
	assert.equal(s.todaySeconds, 100);
	assert.equal(s.nightActive, true, '3 night plays in the last 7 days');
	assert.equal(s.nightPlays7d, 3);
	assert.equal(s.topArtists[0].name, 'ArtistX');
	assert.equal(s.topArtists[0].seconds, 70);
});

test('exportLegacy returns factual song and hourly data without inferred preferences', async () => {
	const base = new Date(2026, 7, 21, 10, 0, 0).getTime();
	const { habits } = makeHabits(base);
	await habits.recordPlayback({ song: song(1, '晴天', '周杰伦'), position: 0, duration: 200, playing: true });
	await habits.recordPlayback({ song: song(1, '晴天', '周杰伦'), position: 30, duration: 200, playing: true });

	const legacy = await habits.exportLegacy();
	assert.deepEqual(legacy.songs, [{
		id: 1,
		name: '晴天',
		artists: '周杰伦',
		album: 'Album',
		plays: 1,
		seconds: 30,
		completed: 0,
		lastAt: base
	}]);
	assert.equal(legacy.byHour[10], 30);
	assert.equal('dislikes' in legacy, false);
});

test('nightCheck reminds once after 2h of night listening, then only again after 24h', async () => {
	const base = new Date(2026, 7, 20, 23, 0, 0).getTime();
	const { habits, setTime } = makeHabits(base);
	// 深夜累计 2 小时（120 次上报 × 60s，每次前进 2s）
	let t = base;
	let pos = 0;
	for (let i = 0; i < 121; i++) {
		t += 2000;
		setTime(t);
		pos += 60;
		await habits.recordPlayback({ song: song(1), position: pos, duration: 3 * 3600, playing: true });
	}
	let r = await habits.nightCheck();
	assert.equal(r.remind, true, '2h of night listening triggers the reminder');
	assert.equal(r.nightSeconds, 7200);
	r = await habits.nightCheck();
	assert.equal(r.remind, false, 'no repeat within 24h');
	// 白天不提醒
	setTime(new Date(2026, 7, 21, 12, 0, 0).getTime());
	r = await habits.nightCheck();
	assert.equal(r.remind, false, 'daytime never reminds');
	// 24h 后深夜再听满 2h → 可再次提醒
	t = new Date(2026, 7, 21, 23, 30, 0).getTime();
	setTime(t);
	pos = 0;
	for (let i = 0; i < 121; i++) {
		t += 2000;
		setTime(t);
		pos += 60;
		await habits.recordPlayback({ song: song(2), position: pos, duration: 3 * 3600, playing: true });
	}
	r = await habits.nightCheck();
	assert.equal(r.remind, true, '24h later another night session can remind again');
});

test('songCheck flags songs played at least 3 times within 30 days as frequent', async () => {
	const base = new Date(2026, 7, 21, 10, 0, 0).getTime();
	const { habits } = makeHabits(base);
	await habits.recordPlayback({ song: song(1), position: 0, duration: 300, playing: true });
	await habits.recordPlayback({ song: song(2), position: 0, duration: 300, playing: true });
	let r = await habits.songCheck(1);
	assert.equal(r.frequent, false, 'one play is not frequent yet');
	await habits.recordPlayback({ song: song(1), position: 0, duration: 300, playing: true });
	await habits.recordPlayback({ song: song(3), position: 0, duration: 300, playing: true });
	await habits.recordPlayback({ song: song(1), position: 0, duration: 300, playing: true }); // 第 3 次
	r = await habits.songCheck(1);
	assert.equal(r.frequent, true);
	assert.equal(r.plays, 3);
});

test('clear wipes all memory', async () => {
	const base = new Date(2026, 7, 21, 10, 0, 0).getTime();
	const { habits } = makeHabits(base);
	await habits.recordPlayback({ song: song(1), position: 0, duration: 300, playing: true });
	await habits.recordPlayback({ song: song(1), position: 30, duration: 300, playing: true });
	assert.equal((await habits.summary()).totalSongs, 1);
	await habits.clear();
	const s = await habits.summary();
	assert.equal(s.totalSongs, 0);
	assert.equal(s.totalSeconds, 0);
	assert.equal(s.totalPlays, 0);
});

test('habits persist to disk and reload', async () => {
	const file = join(tmpdir(), 'moony-habits-test-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
	const base = new Date(2026, 7, 21, 10, 0, 0).getTime();
	const h1 = createHabits({ file, now: () => base });
	await h1.recordPlayback({ song: song(1), position: 0, duration: 300, playing: true });
	await h1.recordPlayback({ song: song(1), position: 45, duration: 300, playing: true });
	await h1.flush();
	const h2 = createHabits({ file, now: () => base });
	const s = await h2.summary();
	assert.equal(s.totalSongs, 1);
	assert.equal(s.totalSeconds, 45);
	assert.equal(s.topSongs[0].name, 'Song1');
	await unlink(file).catch(() => {});
});
