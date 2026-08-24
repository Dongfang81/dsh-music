const WEIGHTS = Object.freeze({ taste: 0.5, context: 0.3, exploration: 0.2 });

function keys(tracks) {
	return [...new Set((tracks ?? []).map((track) => track?.trackKey).filter(Boolean))];
}

function stringKeys(values) {
	return [...new Set((values ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))];
}

export function buildButtonContext(input = {}) {
	return {
		weights: { ...WEIGHTS },
		activity: String(input.activity || 'listen'),
		energyHint: input.energyHint ?? 'balanced',
		currentTrack: input.currentTrack ?? null,
		recentTrackKeys: keys(input.recentTracks),
		recentRecommendedTrackKeys: stringKeys(input.recentRecommendedTrackKeys),
		queueTrackKeys: keys(input.queue),
		profile: input.profile ?? { version: 2, tracks: {}, artists: {}, rules: [], resolverStats: {} }
	};
}
