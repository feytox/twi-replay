# AGENTS.md

Browser extension (MV3, one manifest for Chrome and Firefox) that adds rewind and pause-resume to live Twitch streams without a subscription. It plays the stream's in-progress VOD with hls.js in a `<video>` laid over Twitch's paused player. The user mainly uses desktop Firefox (Floorp); mobile is out of scope.

- The content script runs in the page's MAIN world so GQL, usher and CDN requests come from the twitch.tv origin and hls.js behaves the same in both browsers; extension APIs are unavailable there.
- Channels without a VOD the viewer can already watch get no rewind UI: the user decided against workarounds for sub-only or hidden VODs.
- Twitch's own Stream Rewind (subs with ad-free, Turbo) is gated by `DVRVideoIDQuery` returning a per-viewer `vodID`; enabling it would mean faking Turbo or sub state in Apollo, so the extension builds its own UI and steps aside when the native seekbar (`data-a-target="player-seekbar"`) is present.
- The VOD media playlist is an EVENT playlist of 10 s segments whose end trails the broadcaster by 1-11 s. Only some VODs carry `#EXT-X-PROGRAM-DATE-TIME`; without it `Timeline` anchors VOD zero at the archive's `recordedAt` minus 2 s.
- Twitch's live player cannot hold a position: any pause, even of the `<video>` itself, unloads the stream, play resumes at the live edge, and it overrides seeks and playback rate. So catching up runs on our side: within 20 s of the broadcast the VOD hands over to a `LivePlayer` on the playlist of Twitch's own session (`getPath()`, which avoids the preroll a fresh token often gets), and once that is within 8 s, Twitch's player resumes muted underneath and takes over when the frames meet.
- VOD and live segments share raw PTS, so `streamTime` (hls.js initPTS plus `currentTime`) aligns them frame-exactly, PDT or not. Twitch's frame maps to the live playlist through `getStartOffset() + getPosition()` = `#EXT-X-TWITCH-ELAPSED-SECS`, plus ~0.2 s; `getLiveLatency()` is off by up to 1 s.
- On `/videos/<id>` of a stream still recording, Twitch's player keeps loading new segments, but its React seekbar components (two instances) freeze `state.vodLength` at load and end the video there; `extendVodLength` raises it on each `durationchange`.
- While rewinding, Twitch's player stays paused: it covers the video with an invisible full-size Play button (`.player-overlay-background button`), keeps its controls visible and toggles playback on space keyup. `RewindSession` intercepts clicks and keys in the capture phase, `IdleTracker` hides the overlay.

## Verifying changes

There are no unit tests: run `npm run typecheck` and `npm run lint`, then check on a live channel with a public VOD and on one without (it must show nothing).
- Firefox: puppeteer-core launches `/usr/lib/floorp/floorp` headless and installs `dist/` with `browser.installExtension` over WebDriver BiDi, which allows one session per browser, so drive it from a single process.
- Chrome through claude-in-chrome cannot load an unpacked extension: add a `<input type="file" multiple>` to the page whose change handler evaluates the `.js` and injects the `.css`, then upload `dist/content.js` and `dist/content.css` to it with `file_upload`. The window is often throttled to a few frames per second there, so frame-timed switches look less precise than they are.
