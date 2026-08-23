const VERSION_RULES = [
	['accompaniment', /(?:伴奏|karaoke|instrumental\s*backing)/i],
	['cover', /(?:翻唱|cover\b|翻自)/i],
	['instrumental', /(?:纯音乐|instrumental\b|钢琴版|吉他版|八音盒)/i],
	['live', /(?:\blive\b|现场版?|演唱会版?)/i],
	['medley', /(?:串烧|medley\b|mashup\b)/i],
	['remix', /(?:\bremix\b|混音版?)/i]
];

const NON_ORIGINAL_TAGS = new Set(['accompaniment', 'cover', 'instrumental', 'live', 'medley', 'remix']);

function displayText(value) {
	return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function identityText(value) {
	return displayText(value)
		.normalize('NFKC')
		.toLocaleLowerCase()
		.replace(/[\p{P}\p{S}\s]+/gu, '');
}

function normalizeIsrc(value) {
	const normalized = String(value ?? '').trim().toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
	return normalized || null;
}

function normalizeArtists(value) {
	const input = Array.isArray(value)
		? value
		: typeof value === 'string'
			? value.split(/\s*(?:\/|、|,|，|;|；|&)\s*/)
			: [];
	const seen = new Set();
	const artists = [];
	for (const item of input) {
		const name = displayText(typeof item === 'object' && item !== null ? item.name : item);
		const key = identityText(name);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		artists.push(name);
	}
	return artists;
}

function durationBucket(durationMs) {
	const duration = Number(durationMs) || 0;
	return duration > 0 ? Math.round(duration / 5000) * 5 : 0;
}

function coreTitle(value) {
	return identityText(
		displayText(value)
			.replace(/[（(][^）)]*(?:live|现场|翻唱|cover|伴奏|纯音乐|remix|串烧|medley|原唱)[^）)]*[）)]/gi, '')
			.replace(/\b(?:live|cover|remix|instrumental|medley)\b/gi, '')
	);
}

export function classifyVersion(title) {
	const value = displayText(title);
	return VERSION_RULES.filter(([, rule]) => rule.test(value)).map(([tag]) => tag).sort();
}

export function normalizeTrack(raw, origin = 'unknown') {
	if (!raw || typeof raw !== 'object') return null;
	const title = displayText(raw.name ?? raw.title);
	const artists = normalizeArtists(raw.ar ?? raw.artists);
	if (!identityText(title) || artists.length === 0) return null;
	const durationMs = Math.max(0, Number(raw.dt ?? raw.durationMs ?? raw.duration) || 0);
	const isrc = normalizeIsrc(raw.isrc ?? raw.isrcId);
	const track = {
		title,
		artists,
		album: displayText(raw.al?.name ?? raw.album?.name ?? raw.album),
		durationMs,
		isrc,
		versionTags: classifyVersion(title),
		origins: origin ? [String(origin)] : [],
		raw
	};
	track.trackKey = trackKey(track);
	return track;
}

export function trackKey(track) {
	if (!track || typeof track !== 'object') return '';
	const isrc = normalizeIsrc(track.isrc);
	if (isrc) return `isrc:${isrc}`;
	const title = coreTitle(track.title ?? track.name);
	const artists = normalizeArtists(track.artists ?? track.ar).map(identityText).join('+');
	if (!title || !artists) return '';
	return `meta:${title}:${artists}:${durationBucket(track.durationMs ?? track.dt)}`;
}

function sameIdentity(a, b) {
	if (a.isrc && b.isrc) return a.isrc === b.isrc;
	if (coreTitle(a.title) !== coreTitle(b.title)) return false;
	const aArtists = a.artists.map(identityText);
	const bArtists = b.artists.map(identityText);
	if (aArtists.length !== bArtists.length || aArtists.some((artist, index) => artist !== bArtists[index])) return false;
	if (!a.durationMs || !b.durationMs) return true;
	return Math.abs(a.durationMs - b.durationMs) <= 3000;
}

export function dedupeTracks(tracks) {
	const result = [];
	for (const candidate of tracks ?? []) {
		if (!candidate) continue;
		const existing = result.find((track) => sameIdentity(track, candidate));
		if (!existing) {
			result.push({ ...candidate, origins: [...(candidate.origins ?? [])] });
			continue;
		}
		existing.origins = [...new Set([...(existing.origins ?? []), ...(candidate.origins ?? [])])];
	}
	return result;
}

export function isRequestedVersion(candidate, requested) {
	if (!candidate || !requested) return false;
	if (coreTitle(candidate.title) !== coreTitle(requested.title)) return false;
	const requestedArtists = normalizeArtists(requested.artists).map(identityText);
	const candidateArtists = normalizeArtists(candidate.artists).map(identityText);
	if (requestedArtists.length > 0 && !requestedArtists.every((artist) => candidateArtists.includes(artist))) return false;
	const requestedTags = new Set(classifyVersion(requested.title));
	for (const tag of candidate.versionTags ?? classifyVersion(candidate.title)) {
		if (NON_ORIGINAL_TAGS.has(tag) && !requestedTags.has(tag)) return false;
	}
	return true;
}
