import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { createLocalLibrary } from '../../lib/recommendation/local-library.js';

async function fixture() {
	const base = await mkdtemp(join(tmpdir(), 'moony-local-'));
	const root = join(base, 'music');
	await mkdir(root);
	await writeFile(join(root, '晴天.mp3'), 'fake');
	await writeFile(join(root, 'notes.txt'), 'ignore');
	const outside = join(base, 'outside.flac');
	await writeFile(outside, 'outside');
	await symlink(outside, join(root, 'escape.flac'));
	return { root, outside };
}

function fakeTags(file) {
	if (basename(file) === 'outside.flac') throw new Error('outside symlink must never be parsed');
	return Promise.resolve({
		common: { title: '晴天', artist: '周杰伦', album: '叶惠美', isrc: ['CN-A23-03-00001'] },
		format: { duration: 269 }
	});
}

test('indexes supported files only inside configured absolute roots', async () => {
	const { root } = await fixture();
	const library = createLocalLibrary({ roots: [root], parseFile: fakeTags });
	const report = await library.scan();
	assert.equal(report.indexed, 1);
	assert.equal(report.rejected, 1);
	assert.deepEqual((await library.search('晴天')).map((track) => track.title), ['晴天']);
	assert.equal(await library.resolve('../outside.mp3'), null);
});

test('local identity includes artist, duration, and an allowlisted real path', async () => {
	const { root } = await fixture();
	const library = createLocalLibrary({ roots: [root], parseFile: fakeTags });
	await library.scan();
	const [track] = await library.candidates();
	assert.deepEqual(track.artists, ['周杰伦']);
	assert.equal(track.durationMs, 269000);
	assert.equal(track.localPath, await realpath(join(root, '晴天.mp3')));
	assert.equal((await library.resolve(track.trackKey)).trackKey, track.trackKey);
	await library.clear();
	assert.deepEqual(await library.candidates(), []);
});

test('relative roots are rejected instead of being resolved implicitly', () => {
	assert.throws(() => createLocalLibrary({ roots: ['./Music'], parseFile: fakeTags }), /absolute/);
});
