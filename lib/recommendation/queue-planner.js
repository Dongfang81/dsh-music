function identityText(value) {
	return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
		.replace(/[（(][^）)]*(?:live|现场|翻唱|cover|伴奏|纯音乐|remix|串烧|medley|原唱)[^）)]*[）)]/gi, '')
		.replace(/\b(?:live|cover|remix|instrumental|medley)\b/gi, '')
		.replace(/[\p{P}\p{S}\s]+/gu, '');
}

function versionIdentity(track) {
	return `${identityText(track?.title)}:${identityText(track?.artists?.[0])}`;
}

function artistIdentity(track) {
	return identityText(track?.artists?.[0] ?? 'unknown');
}

function confidence(entry) {
	return Number(entry?.track?.confidence ?? entry?.confidence) || 0;
}

export function planQueue({ ranked = [], targetSize = 15, rng = Math.random, currentTrack = null, existingQueue = [] } = {}) {
	const target = Math.max(0, Math.floor(Number(targetSize) || 0));
	const blockedKeys = new Set([currentTrack?.trackKey, ...existingQueue.map((track) => track?.trackKey)].filter(Boolean));
	const pool = ranked
		.map((entry, index) => entry?.track ? { ...entry, index, tie: rng() } : { track: entry, total: 0, index, tie: rng() })
		.filter((entry) => entry.track?.trackKey && !blockedKeys.has(entry.track.trackKey));
	const selected = [];
	const artistCounts = new Map();
	const identities = new Set();

	function eligible(entry) {
		const artist = artistIdentity(entry.track);
		if ((artistCounts.get(artist) || 0) >= 2) return false;
		if (selected.length > 0 && artistIdentity(selected.at(-1).track) === artist) return false;
		if (identities.has(versionIdentity(entry.track))) return false;
		return true;
	}

	function take(entry) {
		selected.push(entry);
		const artist = artistIdentity(entry.track);
		artistCounts.set(artist, (artistCounts.get(artist) || 0) + 1);
		identities.add(versionIdentity(entry.track));
		pool.splice(pool.indexOf(entry), 1);
	}

	while (selected.length < Math.min(3, target)) {
		const next = pool.find((entry) => confidence(entry) >= 0.9 && eligible(entry));
		if (!next) break;
		take(next);
	}

	while (selected.length < target) {
		const eligibleEntries = pool.filter(eligible);
		if (eligibleEntries.length === 0) break;
		const previousEnergy = Number(selected.at(-1)?.track?.energy);
		const shortlist = eligibleEntries.slice(0, 5);
		shortlist.sort((a, b) => {
			if (!Number.isFinite(previousEnergy)) return a.index - b.index || a.tie - b.tie;
			const aEnergy = Number(a.track.energy);
			const bEnergy = Number(b.track.energy);
			const aGap = Number.isFinite(aEnergy) ? Math.abs(aEnergy - previousEnergy) : 1;
			const bGap = Number.isFinite(bEnergy) ? Math.abs(bEnergy - previousEnergy) : 1;
			return aGap - bGap || a.index - b.index || a.tie - b.tie;
		});
		take(shortlist[0]);
	}

	return {
		insertAfterTrackKey: currentTrack?.trackKey ?? null,
		tracks: selected.map((entry) => entry.track),
		entries: selected.map(({ index: _index, tie: _tie, ...entry }) => entry),
		targetSize: target,
		shortfall: Math.max(0, target - selected.length)
	};
}
