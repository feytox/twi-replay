import { Events } from 'hls.js/light';
import { HlsPlayback, type HlsPlaybackOptions } from './hls-playback';

const ELAPSED_TAG = /^#EXT-X-TWITCH-ELAPSED-SECS:([\d.]+)/m;
const LIVE_SEGMENT_TITLE = 'live';
const START_MARGIN_SEC = 1;

export interface LivePlayerOptions extends HlsPlaybackOptions {
  startDate: number;
  vodStreamOffset: number;
}

export class LivePlayer extends HlsPlayback {
  private positioned = false;

  constructor(
    playlistUrl: string,
    private readonly options: LivePlayerOptions,
  ) {
    super(playlistUrl, options);

    this.hls.on(Events.MANIFEST_PARSED, () => {
      this.applyQuality();
      this.hls.startLoad(-1);
    });
    this.hls.on(Events.LEVEL_LOADED, (_event, { details }) => {
      if (this.positioned) return;
      this.positioned = true;
      const fragment = details.fragments.findLast((candidate) => candidate.programDateTime !== null && candidate.programDateTime <= options.startDate);
      const offset = fragment?.programDateTime ? (options.startDate - fragment.programDateTime) / 1000 : 0;
      this.hls.startLoad((fragment ?? details.fragments[0]).start + offset);
    });
  }

  get position(): number {
    return this.toPosition(this.video.currentTime);
  }

  get latency(): number {
    const date = this.hls.playingDate;
    return date ? (Date.now() - date.getTime()) / 1000 : Infinity;
  }

  seek(position: number): boolean {
    const details = this.hls.latestLevelDetails;
    const time = this.toMediaTime(position);
    const first = details?.fragments[0];
    if (!details || !first || time < first.start + START_MARGIN_SEC || time > details.edge) return false;
    this.video.currentTime = time;
    return true;
  }

  canPlayFrom(streamTime: number, bufferAhead: number): boolean {
    if (this.streamOffset === null) return false;
    const time = streamTime - this.streamOffset;
    const { buffered } = this.video;
    for (let index = 0; index < buffered.length; index++) {
      if (buffered.start(index) <= time && buffered.end(index) >= time + bufferAhead) return this.isLiveContent(time);
    }
    return false;
  }

  cue(streamTime: number): Promise<void> {
    if (this.streamOffset === null) return Promise.reject(new Error('Live stream time is unknown'));
    const seeked = new Promise<void>((resolve) => this.video.addEventListener('seeked', () => resolve(), { once: true }));
    this.video.currentTime = streamTime - this.streamOffset;
    return seeked;
  }

  streamTimeAtElapsed(elapsed: number): number | null {
    const details = this.hls.latestLevelDetails;
    const first = details?.fragments[0];
    const firstElapsed = details ? ELAPSED_TAG.exec(details.m3u8)?.[1] : undefined;
    if (!first || firstElapsed === undefined || this.streamOffset === null) return null;
    return this.streamOffset + first.start + elapsed - Number(firstElapsed);
  }

  private isLiveContent(time: number): boolean {
    const fragment = this.hls.latestLevelDetails?.fragments.find((candidate) => candidate.start <= time && time < candidate.end);
    return fragment?.title === LIVE_SEGMENT_TITLE;
  }

  private toPosition(time: number): number {
    return time + (this.streamOffset ?? 0) - this.options.vodStreamOffset;
  }

  private toMediaTime(position: number): number {
    return position + this.options.vodStreamOffset - (this.streamOffset ?? 0);
  }
}
