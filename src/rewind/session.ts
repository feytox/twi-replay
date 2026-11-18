import { resolveVodPlaylist, type LiveArchive } from '../twitch/api';
import type { TwitchPlayer } from '../twitch/player';
import { RewindControls, type Mode } from '../ui/controls';
import { LivePlayer } from './live-player';
import { cycledPlaybackRate, steppedPlaybackRate, storedPlaybackRate, storePlaybackRate } from './playback-rate';
import { Timeline } from './timeline';
import { VodPlayer } from './vod-player';

const DEFAULT_LIVE_LATENCY_SEC = 4;
const RESUMED_LIVE_LATENCY_SEC = 6;
const KEY_SEEK_SEC = 10;
const LIVE_HANDOFF_LEAD_SEC = 1;
const LIVE_OVERLAY_TIMEOUT_MS = 5000;
const LIVE_SWITCH_LATENCY_SEC = 20;
const LIVE_PRELOAD_SEC = 3;
const LIVE_SWITCH_LEAD_SEC = 1;
const LIVE_RESUME_MAX_LATENCY_SEC = 20;
const TWITCH_HANDOFF_LATENCY_SEC = 8;
const TWITCH_HANDOFF_TIMEOUT_MS = 15_000;
const TICK_MS = 500;
const TOGGLE_KEYS = new Set([' ', 'k', 'K']);
const RATE_STEP_KEYS = new Map<string, -1 | 1>([
  ['Comma', -1],
  ['Period', 1],
]);

type Playback = VodPlayer | LivePlayer;

interface TwitchHandoff {
  restoreMuted: boolean;
  timer: number;
  playing: boolean;
}

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
  private playback: Playback | null = null;
  private pendingLive: LivePlayer | null = null;
  private liveSwitchScheduled = false;
  private liveUnavailable = false;
  private twitchHandoff: TwitchHandoff | null = null;
  private liveOverlayTimer: number | undefined;
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
    for (const playback of [this.playback, this.pendingLive]) {
      if (playback) player.placeOverVideo(playback.video);
    }
    this.render();
  }

  destroy(): void {
    window.clearInterval(this.ticker);
    this.listeners.abort();
    this.playerListeners?.abort();
    this.stopPlayback();
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
    this.stopPlayback();
    this.pausedPosition = this.livePosition();
    this.mode = 'paused';
    this.render();
  }

  private onTwitchPlay(): void {
    if (this.mode === 'paused') {
      this.mode = 'live';
      this.render();
    } else if (this.mode === 'rewind' && !this.twitchHandoff) {
      this.player?.pause();
    }
  }

  private onTwitchPlaying(): void {
    if (this.mode === 'live') this.stopPlayback();
    else if (this.twitchHandoff) this.twitchHandoff.playing = true;
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
    this.cancelTwitchHandoff();
    if (this.mode === 'paused') this.seek(this.pausedPosition, true);
    else if (this.playback instanceof LivePlayer && this.playback.paused && this.playback.latency > LIVE_RESUME_MAX_LATENCY_SEC) {
      void this.startRewind(this.position(), true);
    } else this.playback?.togglePlayback();
    this.render();
    return true;
  }

  private seek(position: number, autoplay = this.mode === 'live' || this.playback?.paused === false): void {
    const target = Math.max(0, position);
    this.cancelTwitchHandoff();
    this.cancelLiveSwitch();
    if (target >= this.liveHandoffPosition()) this.goLive();
    else if (this.mode !== 'rewind') void this.startRewind(target, autoplay);
    else if (!this.playback) this.rewindTarget = target;
    else if (!this.playback.seek(target)) void this.startRewind(target, autoplay);
  }

  private setPlaybackRate(rate: number): void {
    this.playbackRate = rate;
    storePlaybackRate(rate);
    for (const playback of [this.playback, this.pendingLive]) playback?.setPlaybackRate(rate);
    if (rate <= 1) this.cancelTwitchHandoff();
    this.render();
  }

  private goLive(): void {
    if (this.mode === 'live') return;
    if (this.twitchHandoff) {
      this.finishTwitchHandoff();
      return;
    }
    this.mode = 'live';
    this.cancelLiveSwitch();
    if (this.playback && this.player?.video.paused) {
      this.liveOverlayTimer = window.setTimeout(() => this.stopPlayback(), LIVE_OVERLAY_TIMEOUT_MS);
    } else {
      this.stopPlayback();
    }
    this.player?.setLowLatency(false);
    this.player?.play();
    this.render();
  }

  private async startRewind(position: number, autoplay: boolean): Promise<void> {
    this.stopPlayback();
    this.mode = 'rewind';
    this.rewindTarget = position;
    this.liveUnavailable = false;
    this.player?.pause();
    this.render();

    const request = this.rewindRequest;
    try {
      const playlistUrl = await resolveVodPlaylist(this.archive.videoId);
      if (request !== this.rewindRequest) return;
      this.playback = new VodPlayer(playlistUrl, {
        startPosition: this.rewindTarget,
        autoplay,
        playbackRate: this.playbackRate,
        quality: this.player?.qualityPreference() ?? null,
        onPlaylistUpdate: (details) => this.timeline.update(details),
        onStateChange: () => this.onPlaybackStateChange(),
        onFatalError: (error) => this.failRewind(error),
      });
      this.syncVolume();
      this.player?.placeOverVideo(this.playback.video);
      this.render();
    } catch (error) {
      if (request === this.rewindRequest) this.failRewind(error);
    }
  }

  private failRewind(error: unknown): void {
    console.error('[twi-replay] rewind failed, returning to live', error);
    this.goLive();
  }

  private onPlaybackStateChange(): void {
    this.followLive();
    this.render();
  }

  private followLive(): void {
    const playback = this.playback;
    if (this.mode !== 'rewind' || !playback) return;
    if (playback.paused) {
      this.cancelLiveSwitch();
    } else if (playback instanceof LivePlayer) {
      this.approachTwitch(playback);
    } else {
      this.approachLiveStream(playback);
      if (!this.liveSwitchScheduled && this.caughtUpWithLive(playback)) this.goLive();
    }
  }

  private caughtUpWithLive(vod: VodPlayer): boolean {
    const behindHandoff = this.liveHandoffPosition() - vod.position;
    return behindHandoff <= (this.playbackRate - 1) * LIVE_HANDOFF_LEAD_SEC || vod.secondsToLiveEdge <= LIVE_HANDOFF_LEAD_SEC;
  }

  private approachLiveStream(vod: VodPlayer): void {
    const latency = this.timeline.broadcastPosition() - vod.position;
    if (this.liveUnavailable || this.liveSwitchScheduled || latency > LIVE_SWITCH_LATENCY_SEC) return;
    const vodStreamOffset = vod.streamOffset;
    const vodStreamTime = vod.streamTime;
    if (vodStreamOffset === null || vodStreamTime === null) return;
    if (!this.pendingLive) {
      this.pendingLive = this.createLivePlayer(Date.now() - (latency + LIVE_PRELOAD_SEC) * 1000, vodStreamOffset);
      return;
    }
    const live = this.pendingLive;
    const atRecordingEdge = vod.secondsToLiveEdge <= LIVE_HANDOFF_LEAD_SEC;
    const switchAt = atRecordingEdge ? vodStreamTime : vodStreamTime + LIVE_SWITCH_LEAD_SEC * this.playbackRate;
    if (!live.canPlayFrom(switchAt, LIVE_SWITCH_LEAD_SEC)) return;
    this.liveSwitchScheduled = true;
    const cued = live.cue(switchAt);
    if (atRecordingEdge) {
      void cued.then(() => {
        if (this.pendingLive === live) this.switchToLiveStream(live);
      });
    } else {
      vod.watchFrames((streamTime) => {
        if (streamTime < switchAt) return false;
        this.switchToLiveStream(live);
        return true;
      });
    }
  }

  private createLivePlayer(startDate: number, vodStreamOffset: number): LivePlayer | null {
    const playlistUrl = this.player?.sessionPlaylistUrl();
    if (!playlistUrl) {
      this.liveUnavailable = true;
      return null;
    }
    const live: LivePlayer = new LivePlayer(playlistUrl, {
      startDate,
      vodStreamOffset,
      playbackRate: this.playbackRate,
      quality: this.player?.qualityPreference() ?? null,
      onStateChange: () => this.onPlaybackStateChange(),
      onFatalError: (error) => this.failLiveStream(live, error),
    });
    this.player?.placeOverVideo(live.video);
    return live;
  }

  private switchToLiveStream(live: LivePlayer): void {
    this.liveSwitchScheduled = false;
    this.pendingLive = null;
    this.playback?.destroy();
    this.playback = live;
    this.syncVolume();
    live.show();
    live.play();
    this.render();
  }

  private failLiveStream(live: LivePlayer, error: Error): void {
    if (live === this.playback) {
      this.failRewind(error);
      return;
    }
    console.warn('[twi-replay] live stream is unavailable, staying on the recording', error);
    this.cancelLiveSwitch();
    this.liveUnavailable = true;
  }

  private cancelLiveSwitch(): void {
    if (this.liveSwitchScheduled && this.playback) this.playback.cancelFrameWatch();
    this.liveSwitchScheduled = false;
    this.pendingLive?.destroy();
    this.pendingLive = null;
  }

  private approachTwitch(live: LivePlayer): void {
    const player = this.player;
    if (!player || this.twitchHandoff || this.playbackRate <= 1 || live.latency > TWITCH_HANDOFF_LATENCY_SEC) return;
    this.twitchHandoff = {
      restoreMuted: player.video.muted,
      timer: window.setTimeout(() => this.finishTwitchHandoff(), TWITCH_HANDOFF_TIMEOUT_MS),
      playing: false,
    };
    player.setMuted(true);
    player.setLowLatency(false);
    player.play();
    live.watchFrames((streamTime) => {
      if (!this.caughtUpWithTwitch(live, streamTime)) return false;
      this.finishTwitchHandoff();
      return true;
    });
  }

  private caughtUpWithTwitch(live: LivePlayer, streamTime: number): boolean {
    const elapsed = this.twitchHandoff?.playing ? this.player?.streamElapsed() : null;
    const twitchStreamTime = elapsed == null ? null : live.streamTimeAtElapsed(elapsed);
    return twitchStreamTime !== null && streamTime >= twitchStreamTime;
  }

  private finishTwitchHandoff(): void {
    const handoff = this.twitchHandoff;
    this.twitchHandoff = null;
    if (handoff) {
      window.clearTimeout(handoff.timer);
      this.player?.setMuted(handoff.restoreMuted);
    }
    this.mode = 'live';
    this.stopPlayback();
    this.render();
  }

  private cancelTwitchHandoff(): void {
    const handoff = this.twitchHandoff;
    if (!handoff) return;
    this.twitchHandoff = null;
    window.clearTimeout(handoff.timer);
    this.playback?.cancelFrameWatch();
    this.player?.pause();
    this.player?.setMuted(handoff.restoreMuted);
  }

  private stopPlayback(): void {
    window.clearTimeout(this.liveOverlayTimer);
    this.cancelTwitchHandoff();
    this.cancelLiveSwitch();
    this.rewindRequest++;
    this.playback?.destroy();
    this.playback = null;
  }

  private syncVolume(): void {
    if (!this.player || this.twitchHandoff) return;
    for (const playback of [this.playback, this.pendingLive]) playback?.setVolume(this.player.video.volume, this.player.video.muted);
  }

  private tick(): void {
    const quality = this.player?.qualityPreference() ?? null;
    for (const playback of [this.playback, this.pendingLive]) playback?.setQuality(quality);
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
    if (this.mode === 'rewind') return this.playback?.position ?? this.rewindTarget;
    return this.livePosition();
  }

  private render(): void {
    this.controls.render({
      mode: this.mode,
      position: this.position(),
      livePosition: this.livePosition(),
      recordedEnd: Math.max(this.timeline.recordedEnd(), this.playback instanceof LivePlayer ? this.playback.position : 0),
      liveFrom: this.liveHandoffPosition(),
      playbackRate: this.playbackRate,
      playing: this.playback !== null && !this.playback.paused,
      loading: this.mode === 'rewind' && (this.playback === null || this.playback.buffering),
    });
  }
}
