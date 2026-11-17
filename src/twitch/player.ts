const PLAYER_SELECTOR = '[data-a-target="video-player"]';
const PLAYBACK_TOGGLE_SELECTOR = '[data-a-target="player-play-pause-button"], .player-overlay-background button';
const MAX_FIBER_DEPTH = 60;

interface MediaPlayerInstance {
  getLiveLatency(): number;
}

interface Fiber {
  memoizedProps?: { mediaPlayerInstance?: Partial<MediaPlayerInstance> } | null;
  return: Fiber | null;
}

export class TwitchPlayer {
  private mediaPlayer: MediaPlayerInstance | null = null;

  private constructor(
    readonly root: HTMLElement,
    readonly video: HTMLVideoElement,
  ) {}

  static find(): TwitchPlayer | null {
    const root =
      document.querySelector<HTMLElement>(`.persistent-player ${PLAYER_SELECTOR}`) ??
      document.querySelector<HTMLElement>(PLAYER_SELECTOR);
    const video = root?.querySelector<HTMLVideoElement>('video:not(.twr-video)');
    return root && video ? new TwitchPlayer(root, video) : null;
  }

  get controls(): HTMLElement | null {
    return this.root.querySelector('[data-a-target="player-controls"]');
  }

  get leftControls(): HTMLElement | null {
    return this.root.querySelector('.player-controls__left-control-group');
  }

  hasNativeSeekbar(): boolean {
    return this.root.querySelector('[data-a-target="player-seekbar"]') !== null;
  }

  isPlaybackToggle(target: EventTarget | null): boolean {
    return target instanceof Element && this.root.contains(target) && target.closest(PLAYBACK_TOGGLE_SELECTOR) !== null;
  }

  placeOverVideo(element: HTMLElement): void {
    if (element.previousElementSibling !== this.video) this.video.after(element);
  }

  play(): void {
    if (this.video.paused) this.togglePlayback();
  }

  pause(): void {
    if (!this.video.paused) this.togglePlayback();
  }

  liveLatency(): number | null {
    this.mediaPlayer ??= findMediaPlayer(this.root);
    const latency = this.mediaPlayer?.getLiveLatency();
    return latency !== undefined && Number.isFinite(latency) && latency >= 0 ? latency : null;
  }

  qualityPreference(): string | null {
    try {
      const stored = JSON.parse(localStorage.getItem('video-quality') ?? 'null');
      return typeof stored?.default === 'string' ? stored.default : null;
    } catch {
      return null;
    }
  }

  private togglePlayback(): void {
    const button = this.root.querySelector<HTMLElement>('[data-a-target="player-play-pause-button"]');
    if (button) button.click();
    else if (this.video.paused) void this.video.play();
    else this.video.pause();
  }
}

function findMediaPlayer(root: HTMLElement): MediaPlayerInstance | null {
  const fiberKey = Object.keys(root).find((key) => key.startsWith('__reactFiber$'));
  let fiber = fiberKey ? (root as unknown as Record<string, Fiber | undefined>)[fiberKey] : undefined;
  for (let depth = 0; fiber && depth < MAX_FIBER_DEPTH; depth++, fiber = fiber.return ?? undefined) {
    const candidate = fiber.memoizedProps?.mediaPlayerInstance;
    if (typeof candidate?.getLiveLatency === 'function') return candidate as MediaPlayerInstance;
  }
  return null;
}
