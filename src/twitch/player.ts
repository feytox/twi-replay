const PLAYER_SELECTOR = '[data-a-target="video-player"]';
const PLAYBACK_TOGGLE_SELECTOR = '[data-a-target="player-play-pause-button"], .player-overlay-background button';
const MAX_FIBER_DEPTH = 60;
const FRAME_AHEAD_OF_POSITION_SEC = 0.2;

interface MediaPlayerInstance {
  getLiveLatency(): number;
  setLiveLowLatencyEnabled?(enabled: boolean): void;
  setMuted?(muted: boolean): void;
  getPath?(): string;
  getStartOffset?(): number;
  getPosition?(): number;
}

interface VodSeekbar {
  state: { vodLength: number };
  setState(state: { vodLength: number }): void;
}

interface Fiber {
  memoizedProps?: { mediaPlayerInstance?: Partial<MediaPlayerInstance> } | null;
  stateNode?: { state?: { vodLength?: unknown } | null; setState?: unknown } | null;
  return: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
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
    if (element.parentElement !== this.video.parentElement) this.video.after(element);
  }

  play(): void {
    if (this.video.paused) this.togglePlayback();
  }

  pause(): void {
    if (!this.video.paused) this.togglePlayback();
  }

  liveLatency(): number | null {
    const latency = this.media()?.getLiveLatency();
    return latency !== undefined && Number.isFinite(latency) && latency >= 0 ? latency : null;
  }

  setLowLatency(enabled: boolean): void {
    this.media()?.setLiveLowLatencyEnabled?.(enabled);
  }

  setMuted(muted: boolean): void {
    this.media()?.setMuted?.(muted);
  }

  sessionPlaylistUrl(): string | null {
    return this.media()?.getPath?.() || null;
  }

  streamElapsed(): number | null {
    const media = this.media();
    const startOffset = media?.getStartOffset?.();
    const position = media?.getPosition?.();
    if (startOffset === undefined || position === undefined || this.video.paused) return null;
    return startOffset + position + FRAME_AHEAD_OF_POSITION_SEC;
  }

  prefersLowLatency(): boolean {
    return localStorage.getItem('lowLatencyModeEnabled') !== 'false';
  }

  extendVodLength(): void {
    const duration = this.video.duration;
    if (!Number.isFinite(duration)) return;
    for (const seekbar of findVodSeekbars(this.root)) {
      if (duration > seekbar.state.vodLength) seekbar.setState({ vodLength: duration });
    }
  }

  qualityPreference(): string | null {
    try {
      const stored = JSON.parse(localStorage.getItem('video-quality') ?? 'null');
      return typeof stored?.default === 'string' ? stored.default : null;
    } catch {
      return null;
    }
  }

  private media(): MediaPlayerInstance | null {
    this.mediaPlayer ??= findMediaPlayer(this.root);
    return this.mediaPlayer;
  }

  private togglePlayback(): void {
    const button = this.root.querySelector<HTMLElement>('[data-a-target="player-play-pause-button"]');
    if (button) button.click();
    else if (this.video.paused) void this.video.play();
    else this.video.pause();
  }
}

function fiberOf(element: HTMLElement): Fiber | undefined {
  const fiberKey = Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
  return fiberKey ? (element as unknown as Record<string, Fiber | undefined>)[fiberKey] : undefined;
}

function findMediaPlayer(root: HTMLElement): MediaPlayerInstance | null {
  let fiber = fiberOf(root);
  for (let depth = 0; fiber && depth < MAX_FIBER_DEPTH; depth++, fiber = fiber.return ?? undefined) {
    const candidate = fiber.memoizedProps?.mediaPlayerInstance;
    if (typeof candidate?.getLiveLatency === 'function') return candidate as MediaPlayerInstance;
  }
  return null;
}

function findVodSeekbars(root: HTMLElement): VodSeekbar[] {
  const seekbars: VodSeekbar[] = [];
  const pending = [fiberOf(root)?.child].filter((fiber) => fiber != null);
  for (let fiber = pending.pop(); fiber; fiber = pending.pop()) {
    if (isVodSeekbar(fiber.stateNode)) seekbars.push(fiber.stateNode);
    if (fiber.sibling) pending.push(fiber.sibling);
    if (fiber.child) pending.push(fiber.child);
  }
  return seekbars;
}

function isVodSeekbar(node: Fiber['stateNode']): node is VodSeekbar {
  return typeof node?.state?.vodLength === 'number' && typeof node.setState === 'function';
}
