#!/usr/bin/env node

import { createServer } from "http";
import { readFile } from "fs/promises";
import { extname, join } from "path";

const PORT = 8080;
const ROOT = process.cwd();

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

createServer(async (req, res) => {
  let filePath = join(ROOT, decodeURIComponent(req.url === "/" ? "/player.html" : req.url));

  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}).listen(PORT, () => {
  console.log(`Player running at http://localhost:${PORT}`);
});
