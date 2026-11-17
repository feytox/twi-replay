const IDLE_DELAY_MS = 3000;

export class IdleTracker {
  idle = false;
  private target: HTMLElement | null = null;
  private listeners: AbortController | null = null;
  private timer: number | undefined;

  constructor(private readonly onChange: () => void) {}

  observe(target: HTMLElement): void {
    if (target === this.target) return;
    this.listeners?.abort();
    this.listeners = new AbortController();
    this.target = target;
    const options = { signal: this.listeners.signal };
    target.addEventListener('pointermove', () => this.wake(), options);
    target.addEventListener('pointerdown', () => this.wake(), options);
    target.addEventListener('pointerleave', () => this.sleep(), options);
  }

  wake(): void {
    this.setIdle(false);
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.setIdle(true), IDLE_DELAY_MS);
  }

  disconnect(): void {
    this.listeners?.abort();
    window.clearTimeout(this.timer);
  }

  private sleep(): void {
    window.clearTimeout(this.timer);
    this.setIdle(true);
  }

  private setIdle(idle: boolean): void {
    if (idle === this.idle) return;
    this.idle = idle;
    this.onChange();
  }
}
