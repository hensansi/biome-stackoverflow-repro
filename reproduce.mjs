import { spawn, execSync } from "node:child_process";
import { rmSync, readdirSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.REPRO_ROOT ?? dirname(fileURLToPath(import.meta.url));
const BIN = process.env.BIOME_BIN ?? `${ROOT}/node_modules/.bin/biome`;
const LOG_DIR = `${ROOT}/.repro-logs`;

function killDaemons() {
  for (const pat of ["biome __run_server", "biome lsp-proxy"]) {
    try { execSync(`pkill -f '${pat}'`); } catch {}
  }
}

function cleanState() {
  killDaemons();
  try { rmSync(LOG_DIR, { recursive: true, force: true }); } catch {}
  mkdirSync(LOG_DIR, { recursive: true });
}

function send(proc, obj) {
  const body = JSON.stringify(obj);
  proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function attachReader(proc) {
  let buf = Buffer.alloc(0);
  proc.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = buf.subarray(0, headerEnd).toString();
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) { buf = buf.subarray(headerEnd + 4); continue; }
      const len = Number(m[1]);
      const start = headerEnd + 4;
      if (buf.length < start + len) return;
      const body = buf.subarray(start, start + len).toString();
      buf = buf.subarray(start + len);
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      if (msg.method && msg.id !== undefined) handleServerRequest(proc, msg);
    }
  });
}

function handleServerRequest(proc, msg) {
  send(proc, { jsonrpc: "2.0", id: msg.id, result: null });
}

function sendInitSequence(proc) {
  send(proc, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      workspaceFolders: [{ uri: `file://${ROOT}`, name: "repro" }],
      capabilities: {},
    },
  });
  send(proc, { jsonrpc: "2.0", method: "initialized", params: {} });
}

function reportCrashFile() {
  let files;
  try {
    files = readdirSync(LOG_DIR)
      .filter((f) => f.startsWith("server.log"))
      .map((f) => join(LOG_DIR, f));
  } catch { return; }
  if (files.length === 0) return;
  files.sort();
  const latest = files[files.length - 1];
  const paths = [];
  for (const line of readFileSync(latest, "utf8").split("\n")) {
    const mg = line.match(/update_module_graph_internal\{path=BiomePath \{ path: "([^"]+)"/);
    if (mg) { paths.push(mg[1]); continue; }
    const sf = line.match(/scan_folder\{folder="([^"]+)"\}/);
    if (sf) paths.push(sf[1]);
  }
  const tail = paths.slice(-20);
  console.error("\n=== Last scan paths before crash ===");
  for (const p of tail) console.error("  ", p);
  if (paths.length > 0) {
    console.error(`\nLast path reached: ${paths[paths.length - 1]}`);
  }
}

const crashed = await new Promise((resolve) => {
  cleanState();
  const proc = spawn(
    BIN,
    ["lsp-proxy", "--log-level=debug", `--log-path=${LOG_DIR}`],
    { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] },
  );

  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    try { proc.kill("SIGKILL"); } catch {}
    resolve(result);
  };

  attachReader(proc);

  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    if (text.includes("stack overflow") || text.includes("overflowed its stack")) {
      console.error("*** CRASH DETECTED ***");
      finish(true);
    }
  });

  const timeout = setTimeout(() => {
    console.log("no crash in 10s");
    finish(false);
  }, 10000);

  sendInitSequence(proc);
  setTimeout(() => {
    send(proc, {
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: { uri: `file://${ROOT}/x.ts`, languageId: "typescript", version: 1, text: "" },
      },
    });
  }, 100);
});

if (crashed) {
  reportCrashFile();
  killDaemons();
  process.exit(1);
}
killDaemons();
process.exit(0);
