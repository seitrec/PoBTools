// Tiny static server for out/ (optional; out/index.html also opens directly from disk).
// Usage: node serve.mjs [port]
import { createServer } from "http";
import { readFile } from "fs/promises";
import { join, extname, normalize } from "path";
import { fileURLToPath } from "url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "out");
const port = Number(process.argv[2] ?? 8765);
const types = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".js": "text/javascript", ".css": "text/css" };

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([/\\])+/, "");
  const file = join(root, path || "index.html");
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`http://localhost:${port}/`));
