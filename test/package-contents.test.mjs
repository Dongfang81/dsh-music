import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('browser module registers with the published package name', () => {
	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
	const source = readFileSync(join(root, 'client.js'), 'utf8');
	let registeredId;
	const windowStub = {
		__ModuleLoader__: {
			load(spec) {
				registeredId = spec.id;
			}
		}
	};

	new Function('window', source)(windowStub);

	assert.equal(registeredId, pkg.name);
});

test('npm package contains every local asset linked from the published README', () => {
	const cache = mkdtempSync(join(tmpdir(), 'moony-npm-cache-'));
	try {
		const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
			cwd: root,
			encoding: 'utf8',
			env: { ...process.env, npm_config_cache: cache }
		});
		const packedFiles = new Set(JSON.parse(output)[0].files.map((file) => file.path));
		for (const requiredPath of [
			'README.md', 'docs/IP.md', 'docs/moony-series.png',
			'lib/recommendation/identity.js', 'lib/recommendation/profile.js',
			'lib/recommendation/coordinator.js', 'lib/recommendation/local-library.js',
			'lib/recommendation/pool.js', 'lib/recommendation/generator.js',
			'lib/recommendation/scheduler.js'
		]) {
			assert.ok(packedFiles.has(requiredPath), `${requiredPath} must be included in the npm tarball`);
		}
	} finally {
		rmSync(cache, { recursive: true, force: true });
	}
});

test('recommendation docs explain both mechanisms and local privacy controls', () => {
	const readme = readFileSync(join(root, 'README.md'), 'utf8');
	for (const phrase of [
		'快速推荐', '对话情绪价值', '60 首', '每次取出 30 首', '120 首',
		'准备中', 'localMusicPaths', 'recommendationLearning',
		'moony-singer-recommendation-pool.json', '不读取 DSH 对话'
	]) {
		assert.ok(readme.includes(phrase), `README must document: ${phrase}`);
	}
	for (const file of [
		'identity.js', 'profile.js', 'coordinator.js', 'local-library.js',
		'pool.js', 'generator.js', 'scheduler.js'
	]) {
		assert.ok(existsSync(join(root, 'lib/recommendation', file)), `${file} must ship`);
	}
});
