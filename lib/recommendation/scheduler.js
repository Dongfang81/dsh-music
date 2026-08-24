function errorMessage(error) {
	return error?.message ?? String(error);
}

export function createRecommendationScheduler(options = {}) {
	if (typeof options.generate !== 'function') throw new Error('recommendation scheduler requires generate');
	const generate = options.generate;
	const debounceMs = Math.max(0, Number(options.debounceMs) || 0);
	const retryDelayMs = Math.max(0, Number(options.retryDelayMs) || 0);
	const setTimer = options.setTimeoutFn ?? setTimeout;
	const clearTimer = options.clearTimeoutFn ?? clearTimeout;
	let timer = null;
	let running = null;
	let rerunRequested = false;
	let disposed = false;
	let lastError = null;
	let lastReasons = [];
	const reasons = new Set();
	const idleWaiters = new Set();

	function isIdle() {
		return !timer && !running && !rerunRequested && reasons.size === 0;
	}

	function settleIdle() {
		if (!isIdle() && !disposed) return;
		for (const resolve of idleWaiters) resolve();
		idleWaiters.clear();
	}

	function launch() {
		if (disposed || running) return;
		if (timer) {
			clearTimer(timer);
			timer = null;
		}
		const batch = [...reasons];
		reasons.clear();
		if (batch.length === 0) {
			settleIdle();
			return;
		}
		lastReasons = batch;
		running = Promise.resolve()
			.then(() => generate({ reasons: batch }))
			.then(() => { lastError = null; })
			.catch((error) => {
				lastError = errorMessage(error);
				if (retryDelayMs > 0 && !disposed && !timer) {
					reasons.add('automatic-retry');
					timer = setTimer(() => {
						timer = null;
						launch();
					}, retryDelayMs);
					timer?.unref?.();
				}
			})
			.finally(() => {
				running = null;
				if (disposed) {
					reasons.clear();
					rerunRequested = false;
					settleIdle();
					return;
				}
				if (rerunRequested) {
					rerunRequested = false;
					if (timer) {
						clearTimer(timer);
						timer = null;
					}
					launch();
					return;
				}
				if (reasons.size > 0 && !timer) {
					launch();
					return;
				}
				settleIdle();
			});
	}

	function schedule(reason) {
		if (disposed) return false;
		if (reason) reasons.add(String(reason));
		if (running) {
			rerunRequested = true;
			return true;
		}
		if (timer) clearTimer(timer);
		timer = setTimer(() => {
			timer = null;
			launch();
		}, debounceMs);
		timer?.unref?.();
		return true;
	}

	function startNow(reason) {
		if (disposed) return false;
		if (reason) reasons.add(String(reason));
		if (timer) {
			clearTimer(timer);
			timer = null;
		}
		if (running) {
			rerunRequested = true;
			return true;
		}
		launch();
		return true;
	}

	function status() {
		return {
			state: disposed ? 'disposed' : running ? 'generating' : timer ? 'scheduled' : 'idle',
			generating: Boolean(running),
			scheduled: Boolean(timer) || rerunRequested,
			lastError,
			lastReasons: [...lastReasons]
		};
	}

	function whenIdle() {
		if (isIdle() || disposed) return Promise.resolve();
		return new Promise((resolve) => idleWaiters.add(resolve));
	}

	function dispose() {
		if (disposed) return false;
		disposed = true;
		if (timer) clearTimer(timer);
		timer = null;
		reasons.clear();
		rerunRequested = false;
		settleIdle();
		return true;
	}

	return { schedule, startNow, status, whenIdle, dispose };
}
