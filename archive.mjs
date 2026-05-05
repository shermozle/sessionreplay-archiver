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

async function listAllReplays() {
  const replays = [];
  let pageToken = null;
  let page = 0;

  while (true) {
    const params = new URLSearchParams({ page_size: "200", sort_order: "asc" });
    if (pageToken) params.set("page_token", pageToken);

    const url = `${BASE_URL}?${params}`;
    console.log(`  Fetching replay list page ${++page}...`);
    const data = await apiFetch(url);

    if (data.session_replays) {
      replays.push(...data.session_replays);
      console.log(
        `  Got ${data.session_replays.length} replays (total: ${replays.length})`
      );
    }

    if (!data.next_page_token) break;
    pageToken = data.next_page_token;
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
  const safeId = replay.replay_id.replace(/\//g, "_");
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

  await mkdir(OUTPUT_DIR, { recursive: true });

  let manifest = [];
  if (existsSync(MANIFEST_PATH)) {
    try {
      const raw = await readFile(MANIFEST_PATH, "utf8");
      if (raw.trim()) {
        manifest = JSON.parse(raw);
        console.log(`Found existing manifest with ${manifest.length} entries\n`);
      }
    } catch { /* corrupt manifest, start fresh */ }
  }

  console.log("Step 1: Listing all session replays...");
  const replays = await listAllReplays();
  console.log(`\nFound ${replays.length} total replays\n`);

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

    await writeFile(MANIFEST_PATH, JSON.stringify(results, null, 2));
  }

  const successful = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);
  console.log(`\nDone! Archived ${successful.length} replays.`);
  if (failed.length) console.log(`${failed.length} replays had errors.`);
  console.log(`Output: ${OUTPUT_DIR}/`);
  console.log(`Manifest: ${MANIFEST_PATH}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
