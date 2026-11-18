import { resolveVodPlaylist, type LiveArchive } from '../twitch/api';
import type { TwitchPlayer } from '../twitch/player';
import { RewindControls, type Mode } from '../ui/controls';
import { cycledPlaybackRate, steppedPlaybackRate, storedPlaybackRate, storePlaybackRate } from './playback-rate';
import { Timeline } from './timeline';
import { VodPlayer } from './vod-player';

const DEFAULT_LIVE_LATENCY_SEC = 4;
const RESUMED_LIVE_LATENCY_SEC = 6;
const KEY_SEEK_SEC = 10;
const LIVE_HANDOFF_LEAD_SEC = 1;
const LIVE_HANDOFF_TIMEOUT_MS = 5000;
const TICK_MS = 500;
const TOGGLE_KEYS = new Set([' ', 'k', 'K']);
const RATE_STEP_KEYS = new Map<string, -1 | 1>([
  ['Comma', -1],
  ['Period', 1],
]);

function isTextInput(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select'));
}

export class RewindSession {
  private mode: Mode = 'live';
  private pausedPosition = 0;
  private rewindTarget = 0;
  private rewindRequest = 0;
  private liveLatency = DEFAULT_LIVE_LATENCY_SEC;
  private playbackRate = storedPlaybackRate();
  private vod: VodPlayer | null = null;
  private handoffTimer: number | undefined;
  private player: TwitchPlayer | null = null;
  private playerListeners: AbortController | null = null;
  private swallowedKeyUp: string | null = null;
  private readonly listeners = new AbortController();
  private readonly timeline: Timeline;
  private readonly controls: RewindControls;
  private readonly ticker: number;

  constructor(readonly archive: LiveArchive) {
    this.timeline = new Timeline(archive.recordedAt);
    this.controls = new RewindControls({
      seek: (position) => this.seek(position),
      goLive: () => this.goLive(),
      togglePlayback: () => this.togglePlayback(),
      cyclePlaybackRate: () => this.setPlaybackRate(cycledPlaybackRate(this.playbackRate)),
    });
    const options = { capture: true, signal: this.listeners.signal };
    window.addEventListener('keydown', (event) => this.onKeyDown(event), options);
    window.addEventListener('keyup', (event) => this.onKeyUp(event), options);
    window.addEventListener('click', (event) => this.onClick(event), options);
    this.ticker = window.setInterval(() => this.tick(), TICK_MS);
  }

  get isLive(): boolean {
    return this.mode === 'live';
  }

  attach(player: TwitchPlayer): void {
    if (player.video !== this.player?.video) this.bindPlayer(player);
    this.player = player;
    this.controls.mount(player);
    if (this.vod) player.placeOverVideo(this.vod.video);
    this.render();
  }

  destroy(): void {
    window.clearInterval(this.ticker);
    this.listeners.abort();
    this.playerListeners?.abort();
    this.stopVod();
    this.controls.destroy();
    this.player?.setLowLatency(this.player.prefersLowLatency());
    if (this.mode === 'rewind') this.player?.play();
  }

  private bindPlayer(player: TwitchPlayer): void {
    this.playerListeners?.abort();
    this.playerListeners = new AbortController();
    const options = { signal: this.playerListeners.signal };
    player.video.addEventListener('pause', () => this.onTwitchPause(), options);
    player.video.addEventListener('play', () => this.onTwitchPlay(), options);
    player.video.addEventListener('playing', () => this.onTwitchPlaying(), options);
    player.video.addEventListener('volumechange', () => this.syncVolume(), options);
  }

  private onTwitchPause(): void {
    if (this.mode !== 'live') return;
    this.stopVod();
    this.pausedPosition = this.livePosition();
    this.mode = 'paused';
    this.render();
  }

  private onTwitchPlay(): void {
    if (this.mode === 'paused') {
      this.mode = 'live';
      this.render();
    } else if (this.mode === 'rewind') {
      this.player?.pause();
    }
  }

  private onTwitchPlaying(): void {
    if (this.mode === 'live') this.stopVod();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.ctrlKey || event.altKey || event.metaKey || isTextInput(event.target)) return;
    if (!this.player?.root.isConnected || !this.handleKey(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.swallowedKeyUp = event.code;
  }

  private onKeyUp(event: KeyboardEvent): void {
    if (event.code !== this.swallowedKeyUp) return;
    this.swallowedKeyUp = null;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  private handleKey(event: KeyboardEvent): boolean {
    if (TOGGLE_KEYS.has(event.key)) return this.togglePlayback();
    if (event.key === 'ArrowLeft') {
      this.seek(this.position() - KEY_SEEK_SEC);
      return true;
    }
    if (this.mode === 'live') return false;
    if (event.key === 'ArrowRight') {
      this.seek(this.position() + KEY_SEEK_SEC);
      return true;
    }
    const rateStep = event.shiftKey ? RATE_STEP_KEYS.get(event.code) : undefined;
    if (rateStep === undefined) return false;
    this.setPlaybackRate(steppedPlaybackRate(this.playbackRate, rateStep));
    return true;
  }

  private onClick(event: MouseEvent): void {
    if (!event.isTrusted || !this.player?.isPlaybackToggle(event.target) || !this.togglePlayback()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  private togglePlayback(): boolean {
    if (this.mode === 'live') return false;
    if (this.mode === 'paused') this.seek(this.pausedPosition, true);
    else this.vod?.togglePlayback();
    this.render();
    return true;
  }

  private seek(position: number, autoplay = this.mode === 'live'): void {
    const target = Math.max(0, position);
    if (target >= this.liveHandoffPosition()) this.goLive();
    else if (this.mode !== 'rewind') void this.startRewind(target, autoplay);
    else if (this.vod) this.vod.seek(target);
    else this.rewindTarget = target;
  }

  private setPlaybackRate(rate: number): void {
    this.playbackRate = rate;
    storePlaybackRate(rate);
    this.vod?.setPlaybackRate(rate);
    this.render();
  }

  private goLive(): void {
    if (this.mode === 'live') return;
    this.mode = 'live';
    if (this.vod && this.player?.video.paused) {
      this.handoffTimer = window.setTimeout(() => this.stopVod(), LIVE_HANDOFF_TIMEOUT_MS);
    } else {
      this.stopVod();
    }
    this.player?.setLowLatency(false);
    this.player?.play();
    this.render();
  }

  private async startRewind(position: number, autoplay: boolean): Promise<void> {
    this.stopVod();
    this.mode = 'rewind';
    this.rewindTarget = position;
    this.player?.pause();
    this.render();

    const request = this.rewindRequest;
    try {
      const playlistUrl = await resolveVodPlaylist(this.archive.videoId);
      if (request !== this.rewindRequest) return;
      this.vod = new VodPlayer(playlistUrl, {
        startPosition: this.rewindTarget,
        autoplay,
        playbackRate: this.playbackRate,
        quality: this.player?.qualityPreference() ?? null,
        onPlaylistUpdate: (details) => this.timeline.update(details),
        onStateChange: () => this.onVodStateChange(),
        onFatalError: (error) => this.failRewind(error),
      });
      this.syncVolume();
      this.player?.placeOverVideo(this.vod.video);
      this.render();
    } catch (error) {
      if (request === this.rewindRequest) this.failRewind(error);
    }
  }

  private failRewind(error: unknown): void {
    console.error('[twi-replay] rewind failed, returning to live', error);
    this.goLive();
  }

  private onVodStateChange(): void {
    this.followLive();
    this.render();
  }

  private followLive(): void {
    if (this.mode === 'rewind' && this.vod && !this.vod.paused && this.caughtUpWithLive(this.vod)) this.goLive();
  }

  private caughtUpWithLive(vod: VodPlayer): boolean {
    const behindHandoff = this.liveHandoffPosition() - vod.position;
    return behindHandoff <= (this.playbackRate - 1) * LIVE_HANDOFF_LEAD_SEC || vod.secondsToLiveEdge <= LIVE_HANDOFF_LEAD_SEC;
  }

  private stopVod(): void {
    window.clearTimeout(this.handoffTimer);
    this.rewindRequest++;
    this.vod?.destroy();
    this.vod = null;
  }

  private syncVolume(): void {
    if (this.vod && this.player) this.vod.setVolume(this.player.video.volume, this.player.video.muted);
  }

  private tick(): void {
    if (this.vod && this.player) this.vod.setQuality(this.player.qualityPreference());
    if (this.mode === 'live' && this.player && !this.player.video.paused) this.updateLiveLatency();
    this.followLive();
    this.render();
  }

  private updateLiveLatency(): void {
    this.liveLatency = this.player?.liveLatency() ?? this.liveLatency;
  }

  private livePosition(): number {
    return this.timeline.broadcastPosition() - this.liveLatency;
  }

  private liveHandoffPosition(): number {
    return this.timeline.broadcastPosition() - Math.max(this.liveLatency, RESUMED_LIVE_LATENCY_SEC);
  }

  private position(): number {
    if (this.mode === 'paused') return this.pausedPosition;
    if (this.mode === 'rewind') return this.vod?.position ?? this.rewindTarget;
    return this.livePosition();
  }

  private render(): void {
    this.controls.render({
      mode: this.mode,
      position: this.position(),
      livePosition: this.livePosition(),
      recordedEnd: this.timeline.recordedEnd(),
      liveFrom: this.liveHandoffPosition(),
      playbackRate: this.playbackRate,
      playing: this.vod !== null && !this.vod.paused,
      loading: this.mode === 'rewind' && (this.vod === null || this.vod.buffering),
    });
  }
}
