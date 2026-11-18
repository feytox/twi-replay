import Hls, { Events, type Level, type LevelDetails, type LevelLoadedData } from 'hls.js/light';

const AUTO_QUALITY = -1;
const BACK_BUFFER_SEC = 60;
const START_TOLERANCE_SEC = 0.5;
const EDGE_POLL_MS = 500;

export interface VodPlayerOptions {
  startPosition: number;
  autoplay: boolean;
  playbackRate: number;
  quality: string | null;
  onPlaylistUpdate(details: LevelDetails): void;
  onStateChange(): void;
  onFatalError(error: Error): void;
}

export class VodPlayer {
  readonly video = document.createElement('video');
  private readonly hls = new Hls({ autoStartLoad: false, backBufferLength: BACK_BUFFER_SEC });
  private readonly edgePoller: number;
  private quality: string | null;
  private started = false;
  private nextSegmentDue = Number.NaN;

  constructor(
    playlistUrl: string,
    private readonly options: VodPlayerOptions,
  ) {
    this.quality = options.quality;
    this.video.className = 'twr-video';
    this.setPlaybackRate(options.playbackRate);

    this.hls.on(Events.MANIFEST_PARSED, () => {
      this.applyQuality();
      this.hls.startLoad(options.startPosition);
      if (options.autoplay) this.play();
    });
    this.hls.on(Events.LEVEL_LOADED, (_event, data) => {
      this.nextSegmentDue = lastModified(data.networkDetails) + data.details.targetduration * 1000;
      options.onPlaylistUpdate(data.details);
    });
    this.hls.on(Events.ERROR, (_event, data) => {
      if (data.fatal) options.onFatalError(data.error);
    });

    for (const type of ['loadeddata', 'seeked', 'canplay']) {
      this.video.addEventListener(type, () => this.startAtPosition());
    }
    for (const type of ['play', 'pause', 'waiting', 'playing', 'seeking', 'seeked', 'canplay', 'timeupdate']) {
      this.video.addEventListener(type, () => options.onStateChange());
    }

    this.hls.attachMedia(this.video);
    this.hls.loadSource(playlistUrl);
    this.edgePoller = window.setInterval(() => this.pollLiveEdge(), EDGE_POLL_MS);
  }

  get position(): number {
    return this.started ? this.video.currentTime : this.options.startPosition;
  }

  get paused(): boolean {
    return this.video.paused;
  }

  get buffering(): boolean {
    return this.video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA;
  }

  get secondsToLiveEdge(): number {
    const details = this.hls.latestLevelDetails;
    return this.started && details?.live ? (details.edge - this.video.currentTime) / this.video.playbackRate : Infinity;
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

  destroy(): void {
    window.clearInterval(this.edgePoller);
    this.hls.destroy();
    this.video.remove();
  }

  private startAtPosition(): void {
    if (this.started || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    if (this.video.currentTime < this.options.startPosition - START_TOLERANCE_SEC) {
      this.video.currentTime = this.options.startPosition;
      return;
    }
    this.started = true;
    this.video.classList.add('twr-video--ready');
  }

  private pollLiveEdge(): void {
    const details = this.hls.latestLevelDetails;
    if (!details?.live || Date.now() < this.nextSegmentDue) return;
    if (details.edge - this.position > details.targetduration) return;
    details.requestScheduled = -1;
    this.hls.startLoad(this.position, true);
  }

  private applyQuality(): void {
    if (this.hls.levels.length > 0) this.hls.currentLevel = pickLevel(this.hls.levels, this.quality);
  }
}

function lastModified(response: LevelLoadedData['networkDetails']): number {
  const header = response instanceof Response ? response.headers.get('last-modified') : response?.getResponseHeader('last-modified');
  return header ? Date.parse(header) : Number.NaN;
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
