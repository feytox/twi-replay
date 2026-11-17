import { RewindSession } from './rewind/session';
import { fetchLiveArchive, resolveVodPlaylist } from './twitch/api';
import { TwitchPlayer } from './twitch/player';

const SYNC_INTERVAL_MS = 1000;
const ARCHIVE_CHECK_INTERVAL_MS = 60_000;
const RESERVED_PATHS = new Set([
  'directory',
  'downloads',
  'drops',
  'friends',
  'inventory',
  'jobs',
  'messages',
  'moderator',
  'p',
  'payments',
  'popout',
  'prime',
  'search',
  'settings',
  'subscriptions',
  'turbo',
  'videos',
  'wallet',
]);

function channelFromPath(pathname: string): string | null {
  const match = /^\/([a-z0-9_]+)(?:\/|$)/i.exec(pathname);
  const login = match?.[1].toLowerCase();
  return login && !RESERVED_PATHS.has(login) ? login : null;
}

class App {
  private channel: string | null = null;
  private session: RewindSession | null = null;
  private archiveCheckedAt = 0;
  private checkingArchive = false;

  start(): void {
    window.setInterval(() => this.sync(), SYNC_INTERVAL_MS);
    this.sync();
  }

  private sync(): void {
    const channel = channelFromPath(location.pathname);
    if (channel !== this.channel) {
      this.replaceSession(null);
      this.channel = channel;
      this.archiveCheckedAt = 0;
    }
    if (!channel) return;

    const player = TwitchPlayer.find();
    if (player?.hasNativeSeekbar()) {
      this.replaceSession(null);
      return;
    }
    if (player) this.session?.attach(player);
    if (!this.checkingArchive && Date.now() - this.archiveCheckedAt > ARCHIVE_CHECK_INTERVAL_MS) {
      void this.checkArchive(channel);
    }
  }

  private async checkArchive(channel: string): Promise<void> {
    this.checkingArchive = true;
    this.archiveCheckedAt = Date.now();
    try {
      const archive = await fetchLiveArchive(channel);
      if (channel !== this.channel || archive?.videoId === this.session?.archive.videoId) return;
      if (this.session && !this.session.isLive) return;
      if (archive) await resolveVodPlaylist(archive.videoId);
      if (channel !== this.channel) return;
      this.replaceSession(archive && new RewindSession(archive));
      this.sync();
    } catch (error) {
      console.warn(`[twi-replay] rewind is unavailable for ${channel}`, error);
    } finally {
      this.checkingArchive = false;
    }
  }

  private replaceSession(session: RewindSession | null): void {
    this.session?.destroy();
    this.session = session;
  }
}

new App().start();
