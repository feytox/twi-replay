import type { LevelDetails } from 'hls.js/light';

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
    this.broadcast = { position: 0, time: recordedAt };
    this.recorded = { position: -DEFAULT_RECORDING_LAG_SEC, time: recordedAt };
  }

  update(details: LevelDetails): void {
    const last = details.fragments.at(-1);
    if (!last || last.programDateTime === null) return;
    this.broadcast = { position: last.end, time: last.programDateTime + last.duration * 1000 };
    this.recorded = { position: last.end, time: Date.now() };
  }

  broadcastPosition(): number {
    return project(this.broadcast);
  }

  recordedEnd(): number {
    return Math.min(project(this.recorded), this.broadcastPosition());
  }
}
