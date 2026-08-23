const WEIGHTS = Object.freeze({ taste: 0.5, context: 0.3, exploration: 0.2 });

function asDate(value) {
	const date = value instanceof Date ? value : new Date(value ?? Date.now());
	return Number.isNaN(date.getTime()) ? new Date() : date;
}

function timeBand(hour) {
	if (hour >= 23 || hour < 5) return 'late-night';
	if (hour < 9) return 'morning';
	if (hour < 12) return 'daytime';
	if (hour < 14) return 'midday';
	if (hour < 18) return 'afternoon';
	if (hour < 23) return 'evening';
	return 'daytime';
}

function keys(tracks) {
	return [...new Set((tracks ?? []).map((track) => track?.trackKey).filter(Boolean))];
}

export function buildButtonContext(input = {}) {
	const now = asDate(input.now);
	const band = timeBand(now.getHours());
	return {
		weights: { ...WEIGHTS },
		at: now.getTime(),
		hour: now.getHours(),
		timeBand: band,
		activity: String(input.activity || 'listen'),
		energyHint: input.energyHint ?? (band === 'late-night' ? 'gentle' : 'balanced'),
		currentTrack: input.currentTrack ?? null,
		recentTrackKeys: keys(input.recentTracks),
		queueTrackKeys: keys(input.queue),
		profile: input.profile ?? { version: 2, tracks: {}, artists: {}, rules: [], resolverStats: {} }
	};
}
