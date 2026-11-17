import { resolveVodPlaylist, type LiveArchive } from '../twitch/api';
import type { TwitchPlayer } from '../twitch/player';
import { RewindControls, type Mode } from '../ui/controls';
import { Timeline } from './timeline';
import { VodPlayer } from './vod-player';

const DEFAULT_LIVE_LATENCY_SEC = 4;
const LIVE_SNAP_SEC = 5;
const KEY_SEEK_SEC = 10;
const TICK_MS = 500;
const TOGGLE_KEYS = new Set([' ', 'k', 'K']);

function isTextInput(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select'));
}

export class RewindSession {
  private mode: Mode = 'live';
  private pausedPosition = 0;
  private rewindTarget = 0;
  private rewindRequest = 0;
  private vod: VodPlayer | null = null;
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
    if (this.mode === 'rewind') this.player?.play();
  }

  private bindPlayer(player: TwitchPlayer): void {
    this.playerListeners?.abort();
    this.playerListeners = new AbortController();
    const options = { signal: this.playerListeners.signal };
    player.video.addEventListener('pause', () => this.onTwitchPause(), options);
    player.video.addEventListener('play', () => this.onTwitchPlay(), options);
    player.video.addEventListener('volumechange', () => this.syncVolume(), options);
  }

  private onTwitchPause(): void {
    if (this.mode !== 'live') return;
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

  private onKeyDown(event: KeyboardEvent): void {
    if (event.ctrlKey || event.altKey || event.metaKey || isTextInput(event.target)) return;
    if (!this.player?.root.isConnected || !this.handleKey(event.key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.swallowedKeyUp = event.key;
  }

  private onKeyUp(event: KeyboardEvent): void {
    if (event.key !== this.swallowedKeyUp) return;
    this.swallowedKeyUp = null;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  private handleKey(key: string): boolean {
    if (TOGGLE_KEYS.has(key)) return this.togglePlayback();
    if (key === 'ArrowLeft') {
      this.seek(Math.min(this.position(), this.seekableEnd()) - KEY_SEEK_SEC);
      return true;
    }
    if (key === 'ArrowRight' && this.mode !== 'live') {
      this.seek(this.position() + KEY_SEEK_SEC);
      return true;
    }
    return false;
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
    if (target >= this.seekableEnd()) this.goLive();
    else if (this.mode !== 'rewind') void this.startRewind(target, autoplay);
    else if (this.vod) this.vod.seek(target);
    else this.rewindTarget = target;
  }

  private goLive(): void {
    this.stopVod();
    this.mode = 'live';
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
        quality: this.player?.qualityPreference() ?? null,
        onPlaylistUpdate: (details) => this.timeline.update(details),
        onStateChange: () => this.render(),
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

  private stopVod(): void {
    this.rewindRequest++;
    this.vod?.destroy();
    this.vod = null;
  }

  private syncVolume(): void {
    if (this.vod && this.player) this.vod.setVolume(this.player.video.volume, this.player.video.muted);
  }

  private tick(): void {
    if (this.vod && this.player) this.vod.setQuality(this.player.qualityPreference());
    this.render();
  }

  private livePosition(): number {
    return this.timeline.broadcastPosition() - (this.player?.liveLatency() ?? DEFAULT_LIVE_LATENCY_SEC);
  }

  private seekableEnd(): number {
    return this.timeline.recordedEnd() - LIVE_SNAP_SEC;
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
      seekableEnd: this.seekableEnd(),
      playing: this.vod !== null && !this.vod.paused,
      loading: this.mode === 'rewind' && (this.vod === null || this.vod.buffering),
    });
  }
}
