import type { TwitchPlayer } from '../twitch/player';
import { IdleTracker } from './idle-tracker';

export type Mode = 'live' | 'paused' | 'rewind';

export interface ControlsState {
  mode: Mode;
  position: number;
  livePosition: number;
  seekableEnd: number;
  playing: boolean;
  loading: boolean;
}

export interface ControlsActions {
  seek(position: number): void;
  goLive(): void;
  togglePlayback(): void;
}

const PLAY_ICON = 'M8 5v14l11-7z';
const PAUSE_ICON = 'M6 5h4v14H6zm8 0h4v14h-4z';
const SVG_NS = 'http://www.w3.org/2000/svg';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, ...children: Node[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.append(...children);
  return node;
}

function percent(value: number, total: number): string {
  return `${Math.min(Math.max(value / total, 0), 1) * 100}%`;
}

export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

export class RewindControls {
  private readonly currentTime = element('span', 'twr-seekbar__time');
  private readonly liveTime = element('span', 'twr-seekbar__time');
  private readonly seekable = element('div', 'twr-seekbar__seekable');
  private readonly played = element('div', 'twr-seekbar__played');
  private readonly thumb = element('div', 'twr-seekbar__thumb');
  private readonly tooltip = element('div', 'twr-seekbar__tooltip');
  private readonly track = element('div', 'twr-seekbar__track', element('div', 'twr-seekbar__bar', this.seekable, this.played), this.thumb, this.tooltip);
  private readonly seekbar = element('div', 'twr-seekbar', element('div', 'twr-seekbar__labels', this.currentTime, this.liveTime), this.track);
  private readonly playIcon = document.createElementNS(SVG_NS, 'path');
  private readonly playButton = element('button', 'twr-button twr-play');
  private readonly liveButton = element('button', 'twr-button twr-live', element('span', 'twr-live__dot'), document.createTextNode('Live'));
  private readonly spinner = element('div', 'twr-spinner');
  private readonly activity = new IdleTracker(() => this.renderRootState());
  private root: HTMLElement | null = null;
  private state: ControlsState | null = null;
  private dragPosition: number | null = null;

  constructor(private readonly actions: ControlsActions) {
    const icon = document.createElementNS(SVG_NS, 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.append(this.playIcon);
    this.playButton.append(icon);
    this.playButton.addEventListener('click', () => actions.togglePlayback());
    this.liveButton.addEventListener('click', () => actions.goLive());
    for (const button of [this.playButton, this.liveButton]) {
      button.addEventListener('mousedown', (event) => event.preventDefault());
    }
    this.bindSeekbar();
  }

  mount(player: TwitchPlayer): void {
    this.root = player.root;
    this.activity.observe(player.root);
    const controls = player.controls;
    if (controls && this.seekbar.parentElement !== controls) controls.prepend(this.seekbar);
    const leftControls = player.leftControls;
    if (leftControls && this.playButton.parentElement !== leftControls) leftControls.prepend(this.playButton);
    if (leftControls && this.liveButton.parentElement !== leftControls) leftControls.append(this.liveButton);
    const videoArea = player.video.parentElement;
    if (videoArea && this.spinner.parentElement !== videoArea) videoArea.append(this.spinner);
  }

  render(state: ControlsState): void {
    if (state.playing && !this.state?.playing) this.activity.wake();
    this.state = state;
    const position = this.dragPosition ?? state.position;
    const total = this.total();
    this.seekable.style.width = percent(state.seekableEnd, total);
    this.played.style.width = percent(position, total);
    this.thumb.style.left = percent(position, total);
    this.currentTime.textContent = formatTime(position);
    this.liveTime.textContent = formatTime(state.livePosition);

    this.playIcon.setAttribute('d', state.playing ? PAUSE_ICON : PLAY_ICON);
    this.playButton.setAttribute('aria-label', state.playing ? 'Pause (space/k)' : 'Play (space/k)');
    this.liveButton.title = state.mode === 'live' ? 'Watching live' : 'Go to live';
    this.renderRootState();
  }

  destroy(): void {
    this.activity.disconnect();
    this.seekbar.remove();
    this.playButton.remove();
    this.liveButton.remove();
    this.spinner.remove();
    if (this.root) {
      delete this.root.dataset.twrMode;
      this.root.removeAttribute('data-twr-loading');
      this.root.removeAttribute('data-twr-idle');
    }
  }

  private renderRootState(): void {
    const { root, state } = this;
    if (!root || !state) return;
    root.dataset.twrMode = state.mode;
    root.toggleAttribute('data-twr-loading', state.loading);
    root.toggleAttribute('data-twr-idle', state.mode === 'rewind' && state.playing && this.activity.idle);
  }

  private total(): number {
    const state = this.state;
    return state ? Math.max(state.livePosition, state.seekableEnd, state.position, 1) : 1;
  }

  private positionAt(event: PointerEvent): number {
    const rect = this.track.getBoundingClientRect();
    const fraction = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
    return fraction * this.total();
  }

  private bindSeekbar(): void {
    const track = this.track;
    track.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      track.setPointerCapture(event.pointerId);
      this.drag(event);
    });
    track.addEventListener('pointermove', (event) => {
      this.showTooltip(event);
      if (this.dragPosition !== null) this.drag(event);
    });
    track.addEventListener('pointerup', (event) => {
      if (this.dragPosition === null) return;
      event.stopPropagation();
      const position = this.positionAt(event);
      this.dragPosition = null;
      this.actions.seek(position);
    });
    track.addEventListener('pointercancel', () => {
      this.dragPosition = null;
    });
    track.addEventListener('click', (event) => event.stopPropagation());
  }

  private drag(event: PointerEvent): void {
    this.dragPosition = this.positionAt(event);
    if (this.state) this.render(this.state);
  }

  private showTooltip(event: PointerEvent): void {
    const position = this.positionAt(event);
    const beyondSeekable = this.state !== null && position >= this.state.seekableEnd;
    this.tooltip.textContent = beyondSeekable ? 'Live' : formatTime(position);
    this.tooltip.style.left = percent(position, this.total());
  }
}
