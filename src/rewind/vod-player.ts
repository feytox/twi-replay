import Hls, { Events, type Level, type LevelDetails } from 'hls.js/light';

const AUTO_QUALITY = -1;
const BACK_BUFFER_SEC = 60;

export interface VodPlayerOptions {
  startPosition: number;
  autoplay: boolean;
  quality: string | null;
  onPlaylistUpdate(details: LevelDetails): void;
  onStateChange(): void;
  onFatalError(error: Error): void;
}

export class VodPlayer {
  readonly video = document.createElement('video');
  private readonly hls = new Hls({ autoStartLoad: false, backBufferLength: BACK_BUFFER_SEC });
  private quality: string | null;
  private hasFrame = false;

  constructor(
    playlistUrl: string,
    private readonly options: VodPlayerOptions,
  ) {
    this.quality = options.quality;
    this.video.className = 'twr-video';

    this.hls.on(Events.MANIFEST_PARSED, () => {
      this.applyQuality();
      this.hls.startLoad(options.startPosition);
      if (options.autoplay) this.play();
    });
    this.hls.on(Events.LEVEL_LOADED, (_event, data) => options.onPlaylistUpdate(data.details));
    this.hls.on(Events.ERROR, (_event, data) => {
      if (data.fatal) options.onFatalError(data.error);
    });

    this.video.addEventListener('loadeddata', () => {
      this.hasFrame = true;
      this.video.classList.add('twr-video--ready');
    });
    for (const type of ['play', 'pause', 'waiting', 'playing', 'seeking', 'seeked', 'canplay']) {
      this.video.addEventListener(type, () => options.onStateChange());
    }

    this.hls.attachMedia(this.video);
    this.hls.loadSource(playlistUrl);
  }

  get position(): number {
    return this.hasFrame ? this.video.currentTime : this.options.startPosition;
  }

  get paused(): boolean {
    return this.video.paused;
  }

  get buffering(): boolean {
    return this.video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA;
  }

  play(): void {
    this.video.play().catch((error: unknown) => console.debug('[twi-replay] play() rejected', error));
  }

  togglePlayback(): void {
    if (this.video.paused) this.play();
    else this.video.pause();
  }

  seek(position: number): void {
    this.video.currentTime = position;
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

  destroy(): void {
    this.hls.destroy();
    this.video.remove();
  }

  private applyQuality(): void {
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
