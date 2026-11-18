import type { LevelDetails } from 'hls.js/light';

const RECORDED_AT_DELAY_MS = 2000;
const DEFAULT_RECORDING_LAG_SEC = 10;

interface Anchor {
  position: number;
  time: number;
}

function project(anchor: Anchor): number {
  return anchor.position + (Date.now() - anchor.time) / 1000;
}

export class Timeline {
  private broadcast: Anchor;
  private recorded: Anchor;

  constructor(recordedAt: number) {
    const start = recordedAt - RECORDED_AT_DELAY_MS;
    this.broadcast = { position: 0, time: start };
    this.recorded = { position: -DEFAULT_RECORDING_LAG_SEC, time: start };
  }

  update(details: LevelDetails): void {
    const last = details.fragments.at(-1);
    if (!last) return;
    this.recorded = { position: last.end, time: Date.now() };
    if (last.programDateTime !== null) {
      this.broadcast = { position: last.end, time: last.programDateTime + last.duration * 1000 };
    }
  }

  broadcastPosition(): number {
    return project(this.broadcast);
  }

  recordedEnd(): number {
    return Math.min(project(this.recorded), this.broadcastPosition());
  }
}
