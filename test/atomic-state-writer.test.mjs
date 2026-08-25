import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createAtomicStateWriter } from '../lib/atomic-state-writer.js';

test('atomic writer coalesces pending snapshots and leaves only the final file', async (t) => {
	const directory = mkdtempSync(join(tmpdir(), 'moony-atomic-writer-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const file = join(directory, 'state.json');
	const writer = createAtomicStateWriter({ file, delayMs: 50 });

	writer.schedule({ revision: 1 });
	writer.schedule({ revision: 2 });
	writer.schedule({ revision: 3 });
	await writer.flush();

	assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { revision: 3 });
	assert.deepEqual(readdirSync(directory), ['state.json']);
});

test('atomic writer serializes an update that arrives during an active write', async () => {
	let releaseFirst;
	const firstWrite = new Promise((resolve) => { releaseFirst = resolve; });
	const writes = [];
	let activeWrites = 0;
	let maxActiveWrites = 0;
	const writer = createAtomicStateWriter({
		file: '/virtual/state.json',
		delayMs: 0,
		fs: {
			mkdir: async () => {},
			writeFile: async (file, text) => {
				activeWrites += 1;
				maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
				writes.push({ file, value: JSON.parse(text) });
				if (writes.length === 1) await firstWrite;
				activeWrites -= 1;
			},
			rename: async () => {},
			unlink: async () => {}
		}
	});

	writer.schedule({ revision: 1 });
	const flushing = writer.flush();
	await Promise.resolve();
	writer.schedule({ revision: 2 });
	writer.schedule({ revision: 3 });
	releaseFirst();
	await flushing;
	await writer.flush();

	assert.equal(maxActiveWrites, 1);
	assert.deepEqual(writes.map((entry) => entry.value.revision), [1, 3]);
	assert.ok(writes.every((entry) => entry.file.includes('.tmp-')));
});

test('dispose flushes the last snapshot and ignores later schedules', async () => {
	const saved = [];
	const writer = createAtomicStateWriter({
		file: '/virtual/state.json',
		delayMs: 100,
		fs: {
			mkdir: async () => {},
			writeFile: async (_file, text) => { saved.push(JSON.parse(text)); },
			rename: async () => {},
			unlink: async () => {}
		}
	});

	writer.schedule({ revision: 1 });
	await writer.dispose();
	writer.schedule({ revision: 2 });
	await writer.flush();

	assert.deepEqual(saved, [{ revision: 1 }]);
});
