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

To download only a few — handy for a first smoke test, or for working through a large backlog in chunks:

```bash
node archive.mjs --limit 10
```

Replays already on disk don't count towards the limit, so `--limit 10` fetches 10 *new* sessions no matter how many you've already archived. The archiver also stops requesting listing pages once it has enough, so a small limit stays fast on a large project. `-n 10` and `--limit=10` work too, and `--help` lists the options.

Each run merges its results into `replays/manifest.json` rather than replacing it, so a limited run tops up the index instead of hiding previously archived replays from the player.

### Choosing which replays

By default the archiver works oldest-first. `--order` changes that:

```bash
node archive.mjs --limit 20 --newest          # most recent sessions first
node archive.mjs --limit 20 --random          # random sample across the project
node archive.mjs --limit 20 --order oldest    # the default
```

`--newest` and `--oldest` map onto the API's `sort_order`, and both stop requesting pages as soon as they have enough — so a small `--limit` costs one or two requests either way.

`--random` works differently, because the API gives no way to jump to an arbitrary position. Pagination is a *keyset* cursor — the token decodes to `{"cursor":{"start_time":…,"partition_key":…}}`, meaning "records after this value" — and there is no `offset`-style parameter, so page N's cursor only ever comes from page N-1. Reaching position N costs N/200 requests regardless, and no total count is ever returned.

What the API *does* support is seeking by time via `start_time`. So `--random` picks random instants inside the retention window and takes the replay at each one, costing roughly **one request per replay sampled** instead of one per 200 scanned. Sampling 20 replays takes about five seconds on a 100k+ replay project, and the sample spreads across the whole window.

The window comes from the `retention_in_days` the API reports on each replay (90 here), stepping back that many days from today. That also sidesteps the corrupt timestamps in the data — the replays dated 1970 or 2120 fall outside the window, so they aren't sampled. Reach those with `--oldest`, `--newest`, or `--exact`.

The trade-off: `start_time` is an inclusive *lower* bound, so a draw landing in a quiet stretch returns the next replay after it. Each replay's chance is therefore proportional to the idle time before it, and sessions following long gaps are over-represented — measurably so here, where the median draw lands 12 minutes from a replay and the 90th percentile 4.5 hours. It covers the whole window but is not statistically uniform.

When uniformity matters more than speed, `--exact` restores the full sweep with [reservoir sampling](https://en.wikipedia.org/wiki/Reservoir_sampling) — every replay equally likely, flat memory, one request per 200 replays:

```bash
node archive.mjs --limit 20 --random --exact
```

`--random` without a `--limit` also falls back to the full sweep, since there's no target size to sample towards.

Already-archived replays are excluded either way, so repeated `--random` runs keep finding sessions you don't have yet.

One trap if you extend this: the API accepts `start_time` as UTC but returns timestamps with **no timezone designator** (`"2026-07-15T12:00:01.162"`). `Date.parse` reads those as local time, so any comparison against a UTC bound is silently off by the host's offset — ten hours, on an AEST machine.

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
- Minimum-duration slider (0–60s) to hide very short sessions
- Duration, event count, and file count per session
- Clicking a session starts playing it straight away
- rrweb-player controls: play/pause, 1×/2×/4×/8× speed, skip inactive, and a click-to-seek scrub bar
- Dark UI

Switching replays destroys the previous player via `$destroy()` before clearing the container. Emptying the container only removes the DOM — the Svelte component's replay loop keeps running — so without this, every switch would leave another session playing in the background, racing ahead at many times real time because `skipInactive` is on.

The duration slider tops out at 60s because that already covers the whole useful range — the median session here is about 3 seconds and the 90th percentile is 67s. Search and the slider apply together. Sessions whose `start_time`/`end_time` are corrupt (some record 1970 or year-2120 dates) can't be measured, so they're treated as unknown length and always shown rather than being hidden as if they were short.

`rrweb-player` is pinned to an exact version in both the `<link>` and `<script>` tags. It must stay that way: the `2.x` tags publish no `dist/` bundle, so `@latest` resolved the script and the stylesheet to different builds. Svelte scopes its CSS with per-build hashed class names, so none of the stylesheet's rules matched the rendered DOM — which silently collapsed the seek bar to `height: 0` and left the whole controller unstyled. Bump both tags together and check the scrub bar still renders.

Replays with fewer than two events are hidden from the list, and the footer says how many. rrweb's `Replayer` throws on anything shorter, and because it throws part-way through mounting, one bad replay would leave the player unable to render *any* replay picked afterwards until a page reload. The player also re-checks the event count after fetching `events.json`, which catches replays the archiver skipped (recorded as `"cached"` in the manifest, so their real length isn't known until load).

`index.html` is a byte-identical copy of `player.html` so the GitHub Pages root URL works — keep the two in sync when editing either.

---

## Notes

- Presigned S3 URLs from the Amplitude API expire after 15 minutes — the archiver downloads and saves the raw events so they're preserved indefinitely.
- The Amplitude API returns replays with a 90-day retention window. Archive before they expire.
- Re-running `archive.mjs` picks up any new replays since the last run.
