# Twi Replay

Pause and rewind live Twitch streams without a subscription. Twi Replay adds a seek bar to the player, lets you resume where you paused, and lets you speed up to catch up or click **Live** to jump back. It uses the stream's public recording (VOD) and stays out of the way when Twitch already offers rewind.

## Install

Download the file for your desktop browser from [GitHub Releases](https://github.com/feytox/twi-replay/releases/latest).

### Firefox 142 or later

1. Download `twi-replay-<version>.xpi`.
2. Open `about:addons`, click the gear icon, and choose **Install Add-on From File**.
3. Select the XPI and confirm the installation.

### Chrome

1. Download `twi-replay-<version>.zip` and extract it to a folder you can keep.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the folder containing `manifest.json`.

Refresh any open Twitch tabs. Updates are manual. Install the new XPI in Firefox, or replace the files in the unpacked folder and click **Reload** in Chrome.

## Build from source

The release build runs on Ubuntu with [Node.js 24](https://nodejs.org/) and its bundled npm.

```fish
npm ci
npm run build
```

The extension is in `dist/`. In Chrome, load that folder unpacked. In Firefox, go to `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, and select `dist/manifest.json`. The temporary install lasts until Firefox restarts.

## Cut a release

1. Set the GitHub Actions secrets `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` with the JWT issuer and secret from [Mozilla's add-on API credentials page](https://addons.mozilla.org/en-US/developers/addon/api/key/).
2. If you're bumping the version, update `manifest.json`, run `npm version <version> --no-git-tag-version`, and commit the bump.
3. Tag the release commit `v<version>` and push the tag.

The workflow submits the extension and its source to Mozilla for unlisted signing, then publishes the ZIP and signed XPI on GitHub. If signing times out after submission, get the approved XPI from the [Mozilla Developer Hub](https://addons.mozilla.org/developers/). Run `npm ci` and `npm run package` at the tagged commit, then attach the ZIP and `twi-replay-<version>.xpi` to a GitHub release for that tag.
