# Session Replay Archiver

Archive Amplitude Session Replays to static files and play them back in a browser.

**[Live player →](https://shermozle.github.io/sessionreplay-archiver/)**

This repo contains 248 archived replays from the Budget Direct Amplitude project (recorded 5 May 2026), playable entirely from static files with no backend required.

---

## How it works

`archive.mjs` calls the [Amplitude Session Replay API](https://amplitude.com/docs/apis/analytics/session-replay) to list all replays, fetches the rrweb event files for each one, decompresses them, and writes them to `replays/<id>/events.json`. A `manifest.json` index is kept up to date after each batch.

`player.html` reads the manifest and renders a searchable sidebar. Clicking a replay loads its events into [rrweb-player](https://github.com/rrweb-io/rrweb/tree/master/packages/rrweb-player) — no server needed, just static files.

```
replays/
  manifest.json                        ← index of all replays
  <device_id>_<session_id>/
    metadata.json                      ← start/end time, amplitude_id, etc.
    events.json                        ← rrweb event array
```

---

## Setup

```bash
git clone https://github.com/shermozle/sessionreplay-archiver
cd sessionreplay-archiver
cp .env.example .env
# edit .env and add your Amplitude API key and secret
```

`.env`:
```
AMPLITUDE_API_KEY=your_api_key_here
AMPLITUDE_SECRET_KEY=your_secret_key_here
```

---

## Usage

### Archive replays

```bash
node archive.mjs
```

Downloads all replays from your Amplitude project into `./replays/`. Already-downloaded replays are skipped, so re-running is safe and only fetches new sessions.

### Play replays locally

```bash
node serve.mjs
# open http://localhost:8080
```

### Deploy to GitHub Pages

Push the `replays/` directory and `index.html` to any branch with Pages enabled — no build step required.

```bash
git add replays/ index.html
git commit -m "Update replays"
git push
```

---

## Player features

- Searchable sidebar (by replay ID, date, device ID, or user ID)
- Duration, event count, and file count per session
- rrweb-player controls: play/pause, 1×/2×/4×/8× speed, skip inactive, timeline scrub
- Dark UI

---

## Notes

- Presigned S3 URLs from the Amplitude API expire after 15 minutes — the archiver downloads and saves the raw events so they're preserved indefinitely.
- The Amplitude API returns replays with a 90-day retention window. Archive before they expire.
- Re-running `archive.mjs` picks up any new replays since the last run.
