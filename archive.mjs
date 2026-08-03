#!/usr/bin/env node

import { mkdir, writeFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import { gunzipSync } from "zlib";
import path from "path";

// Load .env if present
if (existsSync(".env")) {
  const env = await readFile(".env", "utf8");
  for (const line of env.split("\n")) {
    const [key, ...rest] = line.split("=");
    if (key && rest.length) process.env[key.trim()] = rest.join("=").trim();
  }
}

const ORDERS = ["oldest", "newest", "random"];

const USAGE = `Usage: node archive.mjs [options]

Options:
  -n, --limit <n>   Stop after downloading <n> replays that aren't already
                    archived. Cached replays don't count towards the limit.
      --order <o>   Which replays to take first (default: oldest):
                      oldest  oldest sessions first
                      newest  newest sessions first
                      random  uniform random sample across the project
      --oldest      Shorthand for --order oldest
      --newest      Shorthand for --order newest
      --random      Shorthand for --order random
      --exact       Make --random exactly uniform by scanning every replay
                    first. Slow on a large project; costs one request per
                    200 replays.
  -h, --help        Show this message

oldest and newest stop requesting list pages as soon as they have enough, so a
small --limit costs one or two requests.

random seeks to random points in time instead of paging through the project,
which costs about one request per replay sampled. It derives its window from
the retention_in_days the API reports, stepping back that many days from today.
Because start_time is an inclusive lower bound, a draw landing in a quiet
stretch returns the next replay after it, so replays that follow long gaps are
over-represented — it samples the whole window but is not statistically
uniform. Add --exact when that matters.`;

function parseCount(flag, raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(
      `${flag} expects a positive integer, got: ${raw ?? "(nothing)"}`
    );
    process.exit(1);
  }
  return value;
}

function parseArgs(argv) {
  let limit = null;
  let exact = false;
  let order = null;
  let orderArg = null;

  const setOrder = (value, arg) => {
    if (order && order !== value) {
      console.error(`Conflicting order options: ${orderArg} and ${arg}`);
      process.exit(1);
    }
    order = value;
    orderArg = arg;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    }

    const shorthand = /^--(oldest|newest|random)$/.exec(arg);
    if (shorthand) {
      setOrder(shorthand[1], arg);
      continue;
    }

    const orderOpt = /^--order(?:=(.*))?$/.exec(arg);
    if (orderOpt) {
      const raw = orderOpt[1] ?? argv[++i];
      if (!ORDERS.includes(raw)) {
        console.error(
          `--order expects one of ${ORDERS.join(", ")}, got: ${raw ?? "(nothing)"}`
        );
        process.exit(1);
      }
      setOrder(raw, arg);
      continue;
    }

    const limitOpt = /^(?:-n|--limit)(?:=(.*))?$/.exec(arg);
    if (limitOpt) {
      limit = parseCount("--limit", limitOpt[1] ?? argv[++i]);
      continue;
    }

    if (arg === "--exact") {
      exact = true;
      continue;
    }

    console.error(`Unknown argument: ${arg}\n\n${USAGE}`);
    process.exit(1);
  }

  if (exact && order && order !== "random") {
    console.error(`--exact only applies to --random, not --${order}`);
    process.exit(1);
  }

  return { limit, exact, order: order ?? "oldest" };
}

// Parse args before validating credentials so --help works without a .env
const {
  limit: LIMIT,
  exact: EXACT,
  order: ORDER,
} = parseArgs(process.argv.slice(2));

const API_KEY = process.env.AMPLITUDE_API_KEY;
const SECRET_KEY = process.env.AMPLITUDE_SECRET_KEY;
if (!API_KEY || !SECRET_KEY) {
  console.error("Missing AMPLITUDE_API_KEY or AMPLITUDE_SECRET_KEY. Copy .env.example to .env and fill in your credentials.");
  process.exit(1);
}

const BASE_URL = "https://amplitude.com/api/1/session-replays";
const OUTPUT_DIR = "./replays";
const MANIFEST_PATH = path.join(OUTPUT_DIR, "manifest.json");

const auth =
  "Basic " + Buffer.from(`${API_KEY}:${SECRET_KEY}`).toString("base64");

async function apiFetch(url) {
  const res = await fetch(url, { headers: { Authorization: auth } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json();
}

function replayDirName(replay) {
  return replay.replay_id.replace(/\//g, "_");
}

function isArchived(replay) {
  return existsSync(path.join(OUTPUT_DIR, replayDirName(replay), "events.json"));
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// One request buys both the retention window and a sanity check that the
// project has any replays at all.
async function fetchRetentionDays() {
  const params = new URLSearchParams({ page_size: "1", sort_order: "desc" });
  const data = await apiFetch(`${BASE_URL}?${params}`);
  const newest = data.session_replays?.[0];
  if (!newest) return { days: null, empty: true };
  return { days: newest.retention_in_days ?? null, empty: false };
}

// Sample by seeking to random instants rather than paging the whole project.
// Costs roughly one request per replay kept, instead of one per 200 scanned.
async function sampleByTime(limit) {
  const { days, empty } = await fetchRetentionDays();
  if (empty) return [];

  const retention = days ?? 90;
  if (days === null) {
    console.log("  API did not report retention_in_days, assuming 90");
  }

  const until = Date.now();
  const since = until - retention * DAY_MS;
  console.log(
    `  Sampling ${new Date(since).toISOString().slice(0, 10)} → ` +
      `${new Date(until).toISOString().slice(0, 10)} (${retention}d retention)`
  );

  const chosen = new Map();
  // Draws can collide or land on something already archived, so allow retries
  // while still guaranteeing the run terminates.
  const maxDraws = limit * 10 + 50;
  let draws = 0;
  let collisions = 0;
  let cached = 0;

  while (chosen.size < limit && draws < maxDraws) {
    draws++;
    // toISOString() is UTC and the API honours the Z. Note its *responses*
    // carry no timezone designator, so anything comparing a returned
    // start_time against a bound has to append Z or it lands hours out.
    const at = new Date(since + Math.random() * (until - since));
    const params = new URLSearchParams({
      page_size: "1",
      sort_order: "asc",
      start_time: at.toISOString(),
    });

    const data = await apiFetch(`${BASE_URL}?${params}`);
    const replay = data.session_replays?.[0];
    if (!replay) continue;

    const dir = replayDirName(replay);
    if (chosen.has(dir)) {
      collisions++;
      continue;
    }
    if (isArchived(replay)) {
      cached++;
      continue;
    }

    chosen.set(dir, replay);
    if (chosen.size % 5 === 0 || chosen.size === limit) {
      console.log(`  Sampled ${chosen.size}/${limit} (${draws} draws)`);
    }
  }

  console.log(
    `  ${draws} draws → ${chosen.size} replays` +
      `${collisions ? `, ${collisions} repeat draws skipped` : ""}` +
      `${cached ? `, ${cached} already archived` : ""}`
  );
  if (chosen.size < limit) {
    console.log(
      `  Could not reach ${limit} after ${maxDraws} draws — the window may be` +
        ` mostly archived already. Use --exact for a full sweep.`
    );
  }

  return [...chosen.values()];
}

async function listReplays({ limit, order }) {
  const random = order === "random";
  // The API rejects a page_token whose sort_order differs from the first page
  const sortOrder = order === "newest" ? "desc" : "asc";

  const replays = [];
  let scanned = 0;
  let candidates = 0;
  let pageToken = null;
  let page = 0;
  let reachedLimit = false;

  while (!reachedLimit) {
    const params = new URLSearchParams({
      page_size: "200",
      sort_order: sortOrder,
    });
    if (pageToken) params.set("page_token", pageToken);

    const url = `${BASE_URL}?${params}`;
    console.log(`  Fetching replay list page ${++page}...`);
    const data = await apiFetch(url);

    const batch = data.session_replays ?? [];

    for (const replay of batch) {
      scanned++;

      const fresh = !isArchived(replay);

      if (random) {
        // Reservoir sample, so a fair pick never holds the whole project
        // in memory and cached replays can't crowd out the sample.
        if (!fresh) continue;
        candidates++;
        if (!limit || replays.length < limit) {
          replays.push(replay);
        } else {
          const j = Math.floor(Math.random() * candidates);
          if (j < limit) replays[j] = replay;
        }
        continue;
      }

      // Only replays we'd actually download count towards --limit
      if (limit && fresh) {
        if (candidates === limit) {
          reachedLimit = true;
          break;
        }
        candidates++;
      }
      replays.push(replay);
    }

    console.log(
      random
        ? `  Scanned ${scanned} replays, ${candidates} not yet archived, holding ${replays.length}`
        : `  Got ${batch.length} replays (selected: ${replays.length})`
    );

    if (!data.next_page_token) break;
    pageToken = data.next_page_token;
  }

  if (reachedLimit) console.log(`  Reached --limit of ${limit}, stopping`);

  // Without a limit the reservoir is the whole candidate pool, still in
  // list order, so shuffle it to make --random mean something.
  if (random && !limit) shuffle(replays);

  if (random) {
    console.log(
      `  Sampled ${replays.length} of ${candidates} un-archived replays` +
        ` across all ${scanned} scanned`
    );
  }

  return replays;
}

async function getReplayFiles(replayId) {
  const allFiles = [];
  let pageToken = null;

  while (true) {
    const params = new URLSearchParams({
      replay_id: replayId,
      version: "3",
      page_size: "1000",
    });
    if (pageToken) params.set("page_token", pageToken);

    const url = `${BASE_URL}/files?${params}`;
    const data = await apiFetch(url);

    if (data.files) allFiles.push(...data.files);
    if (!data.next_page_token) break;
    pageToken = data.next_page_token;
  }

  return allFiles;
}

async function downloadAndDecompress(fileUrl) {
  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());

  try {
    const decompressed = gunzipSync(buffer);
    return JSON.parse(decompressed.toString("utf8"));
  } catch {
    return JSON.parse(buffer.toString("utf8"));
  }
}

async function archiveReplay(replay, index, total) {
  const safeId = replayDirName(replay);
  const replayDir = path.join(OUTPUT_DIR, safeId);

  const eventsPath = path.join(replayDir, "events.json");
  if (existsSync(eventsPath)) {
    console.log(
      `[${index}/${total}] Skipping ${replay.replay_id} (already archived)`
    );
    return { ...replay, dir: safeId, eventCount: "cached" };
  }

  console.log(
    `[${index}/${total}] Archiving ${replay.replay_id} (${replay.start_time} → ${replay.end_time})`
  );

  await mkdir(replayDir, { recursive: true });

  await writeFile(
    path.join(replayDir, "metadata.json"),
    JSON.stringify(replay, null, 2)
  );

  let fileUrls;
  try {
    fileUrls = await getReplayFiles(replay.replay_id);
  } catch (err) {
    console.error(`  Failed to get files: ${err.message}`);
    return { ...replay, dir: safeId, error: err.message };
  }

  if (!fileUrls.length) {
    console.log(`  No replay files found`);
    await writeFile(eventsPath, "[]");
    return { ...replay, dir: safeId, eventCount: 0, fileCount: 0 };
  }

  console.log(`  Downloading ${fileUrls.length} file(s)...`);
  const allEvents = [];

  for (const url of fileUrls) {
    try {
      const events = await downloadAndDecompress(url);
      if (Array.isArray(events)) {
        allEvents.push(...events);
      }
    } catch (err) {
      console.error(`  Failed to download a file chunk: ${err.message}`);
    }
  }

  allEvents.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  await writeFile(eventsPath, JSON.stringify(allEvents));
  console.log(`  Saved ${allEvents.length} events`);

  return {
    ...replay,
    dir: safeId,
    eventCount: allEvents.length,
    fileCount: fileUrls.length,
  };
}

async function main() {
  console.log("Session Replay Archiver");
  console.log("=======================\n");
  // Sampling by time needs a target size to aim at; without one there is
  // nothing to sample towards, so fall back to the full sweep.
  const timeSeek = ORDER === "random" && !EXACT && LIMIT !== null;

  if (LIMIT) console.log(`Downloading at most ${LIMIT} new replay(s)`);
  console.log(`Order: ${ORDER}`);
  if (ORDER === "random") {
    if (timeSeek) {
      console.log("(seeking random points in time, roughly 1 request each)");
    } else if (EXACT) {
      console.log("(--exact: scanning every replay for a uniform sample)");
    } else {
      console.log("(no --limit, so scanning every replay)");
    }
  }
  console.log();

  await mkdir(OUTPUT_DIR, { recursive: true });

  // Keyed by dir so a limited run tops the manifest up instead of replacing it
  const manifest = new Map();
  if (existsSync(MANIFEST_PATH)) {
    try {
      const raw = await readFile(MANIFEST_PATH, "utf8");
      if (raw.trim()) {
        const entries = JSON.parse(raw);
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            if (entry?.dir) manifest.set(entry.dir, entry);
          }
        }
        console.log(`Found existing manifest with ${manifest.size} entries\n`);
      }
    } catch { /* corrupt manifest, start fresh */ }
  }

  console.log(
    timeSeek
      ? "Step 1: Sampling session replays by time..."
      : LIMIT || ORDER === "random"
        ? "Step 1: Listing session replays..."
        : "Step 1: Listing all session replays..."
  );
  const replays = timeSeek
    ? await sampleByTime(LIMIT)
    : await listReplays({ limit: LIMIT, order: ORDER });
  console.log(`\nSelected ${replays.length} replays\n`);

  if (!replays.length) {
    console.log("No replays found. Done.");
    return;
  }

  console.log("Step 2: Downloading replay data...\n");
  const results = [];
  const CONCURRENCY = 5;

  for (let i = 0; i < replays.length; i += CONCURRENCY) {
    const batch = replays.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((r, j) => archiveReplay(r, i + j + 1, replays.length))
    );
    results.push(...batchResults);

    for (const r of batchResults) manifest.set(r.dir, r);
    await writeFile(
      MANIFEST_PATH,
      JSON.stringify([...manifest.values()], null, 2)
    );
  }

  const failed = results.filter((r) => r.error);
  const cached = results.filter((r) => r.eventCount === "cached");
  const downloaded = results.length - failed.length - cached.length;
  console.log(`\nDone! Downloaded ${downloaded} replays.`);
  if (cached.length) console.log(`${cached.length} were already archived.`);
  if (failed.length) console.log(`${failed.length} replays had errors.`);
  console.log(`Output: ${OUTPUT_DIR}/`);
  console.log(`Manifest: ${MANIFEST_PATH} (${manifest.size} entries)`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
