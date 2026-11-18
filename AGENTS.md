# AGENTS.md

Browser extension (MV3, one manifest for Chrome and Firefox) that adds rewind and pause-resume to live Twitch streams without a subscription. It plays the stream's in-progress VOD with hls.js in a `<video>` laid over Twitch's paused player. The user mainly uses desktop Firefox (Floorp); mobile is out of scope.

- The content script runs in the page's MAIN world so GQL, usher and CDN requests come from the twitch.tv origin and hls.js behaves the same in both browsers; extension APIs are unavailable there.
- Channels without a VOD the viewer can already watch get no rewind UI: the user decided against workarounds for sub-only or hidden VODs.
- Twitch's own Stream Rewind (subs with ad-free, Turbo) is gated by `DVRVideoIDQuery` returning a per-viewer `vodID`; enabling it would mean faking Turbo or sub state in Apollo, so the extension builds its own UI and steps aside when the native seekbar (`data-a-target="player-seekbar"`) is present.
- The VOD media playlist is an EVENT playlist of 10 s segments whose end trails the broadcaster by 1-11 s. Only some VODs carry `#EXT-X-PROGRAM-DATE-TIME`; without it `Timeline` anchors VOD zero at the archive's `recordedAt` minus 2 s.
- Twitch's live player cannot hold a position: `pause()` unloads the stream, play resumes at the live edge, and `seekTo` and `setPlaybackRate` are ignored. So going back to live means the VOD catching up with the point where Twitch will resume, with Low Latency off to make that point earlier.
- While rewinding, Twitch's player stays paused: it covers the video with an invisible full-size Play button (`.player-overlay-background button`), keeps its controls visible and toggles playback on space keyup. `RewindSession` intercepts clicks and keys in the capture phase, `IdleTracker` hides the overlay.

## Verifying changes

There are no unit tests: run `npm run typecheck` and `npm run lint`, then check on a live channel with a public VOD and on one without (it must show nothing).
- Firefox: puppeteer-core launches `/usr/lib/floorp/floorp` headless and installs `dist/` with `browser.installExtension` over WebDriver BiDi, which allows one session per browser, so drive it from a single process. Twitch's live player does not play in that browser, so pausing live can only be checked by hand.
- Chrome through claude-in-chrome cannot load an unpacked extension: bundle `src/main.ts` with `hls.js/light` mapped to `window.Hls`, load the same hls.js version from jsDelivr into the page, then evaluate the bundle and `src/content.css`.
