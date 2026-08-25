function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}

function artistKey(value) {
	return String(value ?? '').trim().normalize('NFKC').toLocaleLowerCase();
}

function matchesRule(track, rule) {
	const value = artistKey(rule?.value);
	if (!value) return false;
	if (rule.kind === 'artist') return (track.artists ?? []).some((artist) => artistKey(artist) === value);
	if (rule.kind === 'track') return artistKey(track.title) === value || track.trackKey === rule.value;
	if (rule.kind === 'language') return artistKey(track.language) === value;
	if (rule.kind === 'style') return (track.styles ?? track.tags ?? []).some((tag) => artistKey(tag) === value);
	if (rule.kind === 'energy') return artistKey(track.energyLabel) === value;
	return false;
}

function targetEnergy(context) {
	if (context?.energyHint === 'gentle') return 0.3;
	if (context?.energyHint === 'energetic') return 0.8;
	return 0.5;
}

export function scoreCandidate(candidate, context = {}, profile = {}) {
	const entry = profile?.tracks?.[candidate?.trackKey] ?? {};
	const events = entry.events ?? {};
	const matchedRules = (profile?.rules ?? []).filter((rule) => matchesRule(candidate, rule));
	const excluded = candidate?.playable === false || Number(events.dislike) > 0 ||
		matchedRules.some((rule) => Number(rule.weight) <= -1);
	const tasteReasons = [];
	let tasteScore = Math.max(0, Number(entry.affinity) || 0) * 4;
	if (Number(events.favorite) > 0) {
		tasteScore += 10;
		tasteReasons.push({ code: 'favorite', value: Number(events.favorite) });
	}
	if (Number(events['complete-80']) > 0) {
		tasteScore += Math.min(8, Number(events['complete-80']) * 2);
		tasteReasons.push({ code: 'completed', value: Number(events['complete-80']) });
	}
	for (const artist of candidate?.artists ?? []) {
		const affinity = Number(profile?.artists?.[artistKey(artist)]?.affinity) || 0;
		if (affinity > 0) {
			tasteScore += affinity;
			tasteReasons.push({ code: 'artist-affinity', artist });
		}
	}
	for (const rule of matchedRules) {
		if (Number(rule.weight) <= 0) continue;
		tasteScore += Number(rule.weight) * 10;
		tasteReasons.push({ code: 'explicit-rule', ruleId: rule.id });
	}
	tasteScore = clamp(tasteScore, 0, 50);

	const contextReasons = [];
	const energy = Number.isFinite(Number(candidate?.energy)) ? clamp(Number(candidate.energy), 0, 1) : null;
	let contextScore = energy === null ? 15 : 30 - Math.abs(energy - targetEnergy(context)) * 30;
	const currentArtist = artistKey(context?.currentTrack?.artists?.[0]);
	if (currentArtist && (candidate?.artists ?? []).some((artist) => artistKey(artist) === currentArtist)) {
		contextScore += 5;
		contextReasons.push({ code: 'current-artist-neighbor' });
	}
	contextScore = clamp(contextScore, 0, 30);

	const known = Boolean(profile?.tracks?.[candidate?.trackKey]);
	const explorationReasons = [];
	let explorationScore = known ? 2 : 15;
	if ((candidate?.origins ?? []).includes('exploration')) {
		explorationScore += 5;
		explorationReasons.push({ code: 'exploration-source' });
	}
	explorationScore = clamp(explorationScore, 0, 20);

	const recentRecommended = context?.recentRecommendedTrackKeys ?? [];
	const recentIndex = recentRecommended.indexOf(candidate?.trackKey);
	const recentDistance = recentIndex < 0 ? -1 : recentRecommended.length - 1 - recentIndex;
	const recentRecommendation = recentDistance < 0 ? 0 : -Math.max(4, 24 - Math.floor(recentDistance / 6));
	const penalties = {
		skip: -Math.min(60, Math.max(0, Number(events['skip-short']) || 0) * 10),
		negativeAffinity: Math.min(0, (Number(entry.affinity) || 0) * 3),
		recent: (context?.recentTrackKeys ?? []).includes(candidate?.trackKey) ? -20 : 0,
		recentRecommendation,
		queued: (context?.queueTrackKeys ?? []).includes(candidate?.trackKey) ? -30 : 0,
		explicitRule: matchedRules.filter((rule) => Number(rule.weight) < 0)
			.reduce((sum, rule) => sum + Number(rule.weight) * 20, 0)
	};
	const penaltyTotal = Object.values(penalties).reduce((sum, value) => sum + value, 0);
	const total = excluded ? Number.NEGATIVE_INFINITY : tasteScore + contextScore + explorationScore + penaltyTotal;
	const explanationCodes = [
		...tasteReasons.map((reason) => reason.code),
		...contextReasons.map((reason) => reason.code),
		...explorationReasons.map((reason) => reason.code),
		...Object.entries(penalties).filter(([, value]) => value < 0).map(([code]) => `penalty-${code}`)
	];
	return {
		track: candidate,
		total,
		excluded,
		taste: { score: tasteScore, reasons: tasteReasons },
		context: { score: contextScore, reasons: contextReasons },
		exploration: { score: explorationScore, reasons: explorationReasons },
		penalties,
		explanationCodes
	};
}

export function rankCandidates({ candidates = [], context = {}, profile = {}, rng = Math.random } = {}) {
	return candidates
		.map((candidate, index) => ({ ...scoreCandidate(candidate, context, profile), index, tie: rng() }))
		.filter((item) => !item.excluded)
		.sort((a, b) => b.total - a.total || a.tie - b.tie || a.index - b.index)
		.map(({ index: _index, tie: _tie, ...item }) => item);
}
