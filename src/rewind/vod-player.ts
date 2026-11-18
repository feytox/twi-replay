import { Events, type LevelDetails, type LevelLoadedData } from 'hls.js/light';
import { HlsPlayback, type HlsPlaybackOptions } from './hls-playback';

const START_TOLERANCE_SEC = 0.5;
const EDGE_POLL_MS = 500;

export interface VodPlayerOptions extends HlsPlaybackOptions {
  startPosition: number;
  autoplay: boolean;
  onPlaylistUpdate(details: LevelDetails): void;
}

export class VodPlayer extends HlsPlayback {
  private readonly edgePoller: number;
  private started = false;
  private nextSegmentDue = Number.NaN;

  constructor(
    playlistUrl: string,
    private readonly options: VodPlayerOptions,
  ) {
    super(playlistUrl, options);

    this.hls.on(Events.MANIFEST_PARSED, () => {
      this.applyQuality();
      this.hls.startLoad(options.startPosition);
      if (options.autoplay) this.play();
    });
    this.hls.on(Events.LEVEL_LOADED, (_event, data) => {
      this.nextSegmentDue = lastModified(data.networkDetails) + data.details.targetduration * 1000;
      options.onPlaylistUpdate(data.details);
    });
    for (const type of ['loadeddata', 'seeked', 'canplay']) {
      this.video.addEventListener(type, () => this.startAtPosition());
    }
    this.edgePoller = window.setInterval(() => this.pollLiveEdge(), EDGE_POLL_MS);
  }

  get position(): number {
    return this.started ? this.video.currentTime : this.options.startPosition;
  }

  get secondsToLiveEdge(): number {
    const details = this.hls.latestLevelDetails;
    return this.started && details?.live ? (details.edge - this.video.currentTime) / this.video.playbackRate : Infinity;
  }

  get edgeStreamTime(): number {
    const edge = this.hls.latestLevelDetails?.edge;
    return edge === undefined || this.streamOffset === null ? -Infinity : edge + this.streamOffset;
  }

  seek(position: number): boolean {
    this.video.currentTime = position;
    return true;
  }

  destroy(): void {
    window.clearInterval(this.edgePoller);
    super.destroy();
  }

  private startAtPosition(): void {
    if (this.started || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    if (this.video.currentTime < this.options.startPosition - START_TOLERANCE_SEC) {
      this.video.currentTime = this.options.startPosition;
      return;
    }
    this.started = true;
    this.show();
  }

  private pollLiveEdge(): void {
    const details = this.hls.latestLevelDetails;
    if (!details?.live || Date.now() < this.nextSegmentDue) return;
    if (details.edge - this.position > details.targetduration) return;
    details.requestScheduled = -1;
    this.hls.startLoad(this.position, true);
  }
}

function lastModified(response: LevelLoadedData['networkDetails']): number {
  const header = response instanceof Response ? response.headers.get('last-modified') : response?.getResponseHeader('last-modified');
  return header ? Date.parse(header) : Number.NaN;
}
