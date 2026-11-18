import Hls, { Events, type Level } from 'hls.js/light';

const AUTO_QUALITY = -1;
const BACK_BUFFER_SEC = 60;

export interface HlsPlaybackOptions {
  playbackRate: number;
  quality: string | null;
  onStateChange(): void;
  onFatalError(error: Error): void;
}

export abstract class HlsPlayback {
  readonly video = document.createElement('video');
  protected readonly hls = new Hls({ autoStartLoad: false, backBufferLength: BACK_BUFFER_SEC });
  private quality: string | null;
  private mediaStreamOffset: number | null = null;
  private frameRequest: number | undefined;

  constructor(playlistUrl: string, options: HlsPlaybackOptions) {
    this.quality = options.quality;
    this.video.className = 'twr-video';
    this.setPlaybackRate(options.playbackRate);

    this.hls.on(Events.INIT_PTS_FOUND, (_event, data) => {
      this.mediaStreamOffset ??= data.initPTS / data.timescale;
    });
    this.hls.on(Events.ERROR, (_event, data) => {
      if (data.fatal) options.onFatalError(data.error);
    });
    for (const type of ['play', 'pause', 'waiting', 'playing', 'seeking', 'seeked', 'canplay', 'timeupdate']) {
      this.video.addEventListener(type, () => options.onStateChange());
    }

    this.hls.attachMedia(this.video);
    this.hls.loadSource(playlistUrl);
  }

  abstract get position(): number;

  abstract seek(position: number): boolean;

  get paused(): boolean {
    return this.video.paused;
  }

  get buffering(): boolean {
    return this.video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA;
  }

  get streamOffset(): number | null {
    return this.mediaStreamOffset;
  }

  get streamTime(): number | null {
    return this.mediaStreamOffset === null ? null : this.video.currentTime + this.mediaStreamOffset;
  }

  play(): void {
    this.video.play().catch((error: unknown) => console.debug('[twi-replay] play() rejected', error));
  }

  togglePlayback(): void {
    if (this.video.paused) this.play();
    else this.video.pause();
  }

  setPlaybackRate(rate: number): void {
    this.video.defaultPlaybackRate = rate;
    this.video.playbackRate = rate;
  }

  setVolume(volume: number, muted: boolean): void {
    this.video.volume = volume;
    this.video.muted = muted;
  }

  setQuality(quality: string | null): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.applyQuality();
  }

  show(): void {
    this.video.classList.add('twr-video--ready');
  }

  watchFrames(onFrame: (streamTime: number) => boolean): void {
    const check: VideoFrameRequestCallback = (_now, frame) => {
      this.frameRequest = undefined;
      const done = this.mediaStreamOffset !== null && onFrame(frame.mediaTime + this.mediaStreamOffset);
      if (!done) this.frameRequest = this.video.requestVideoFrameCallback(check);
    };
    this.cancelFrameWatch();
    this.frameRequest = this.video.requestVideoFrameCallback(check);
  }

  cancelFrameWatch(): void {
    if (this.frameRequest !== undefined) this.video.cancelVideoFrameCallback(this.frameRequest);
    this.frameRequest = undefined;
  }

  destroy(): void {
    this.cancelFrameWatch();
    this.hls.destroy();
    this.video.remove();
  }

  protected applyQuality(): void {
    if (this.hls.levels.length > 0) this.hls.currentLevel = pickLevel(this.hls.levels, this.quality);
  }
}

function pickLevel(levels: Level[], quality: string | null): number {
  if (!quality || quality === 'auto') return AUTO_QUALITY;
  const exact = levels.findIndex((level) => level.attrs.VIDEO === quality);
  if (exact >= 0) return exact;

  const maxHeight = quality === 'chunked' ? Infinity : Number.parseInt(quality, 10);
  if (Number.isNaN(maxHeight)) return AUTO_QUALITY;
  let best = AUTO_QUALITY;
  levels.forEach((level, index) => {
    if (level.height <= maxHeight && (best === AUTO_QUALITY || level.bitrate > levels[best].bitrate)) best = index;
  });
  return best;
}
