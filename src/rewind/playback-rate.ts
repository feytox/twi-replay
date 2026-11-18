const PLAYBACK_RATES = [1, 1.25, 1.5, 2];
const STORAGE_KEY = 'twi-replay-playback-rate';

export function storedPlaybackRate(): number {
  const stored = Number(sessionStorage.getItem(STORAGE_KEY));
  return PLAYBACK_RATES.includes(stored) ? stored : PLAYBACK_RATES[0];
}

export function storePlaybackRate(rate: number): void {
  sessionStorage.setItem(STORAGE_KEY, String(rate));
}

export function cycledPlaybackRate(rate: number): number {
  return PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(rate) + 1) % PLAYBACK_RATES.length];
}

export function steppedPlaybackRate(rate: number, step: -1 | 1): number {
  const index = PLAYBACK_RATES.indexOf(rate) + step;
  return PLAYBACK_RATES[Math.min(Math.max(index, 0), PLAYBACK_RATES.length - 1)];
}
