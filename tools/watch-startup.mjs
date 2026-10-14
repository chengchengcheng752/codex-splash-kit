// Watch the Codex startup overlay and capture screenshots — visual proof that the
// splash actually appeared (and what it showed).
//
// usage: node watch-startup.mjs --port <n> [--out shots] [--seconds 60] [--max-shots 26]
//
// The overlay lives inside a shadow root, so the probe walks document + every shadow root
// looking for `.codex-startup`. Screenshots are taken unconditionally for the first
// `--seconds` seconds, because the overlay is usually up for the entire app boot.

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };

const PORT = Number(arg("--port", process.env.CDP_PORT));
if (!PORT) { console.error("usage: node watch-startup.mjs --port <n> [--out shots] [--seconds 60]"); process.exit(2); }
const OUT = arg("--out", "shots");
const SECONDS = Number(arg("--seconds", 60));
const MAX_SHOTS = Number(arg("--max-shots", 26));

const fs = await import("node:fs");
const path = await import("node:path");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let target = null;
const t0 = Date.now();
while (Date.now() - t0 < 90000) {
  let l = [];
  try { l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { l = []; }
  target = l.find(t => t.type === "page" && /^app:/.test(t.url)) ?? l.find(t => t.type === "page");
  if (target) break;
  await sleep(120);
}
if (!target) { console.error("no page target"); process.exit(1); }
console.log(JSON.stringify({ targetAfterMs: Date.now() - t0 }));

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener("message", ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
ws.addEventListener("close", () => { for (const [, r] of pending) r({ __closed: true }); pending.clear(); });
await new Promise(r => ws.addEventListener("open", r));
function send(method, params = {}, timeoutMs = 8000) {
  const myId = ++id;
  return new Promise(res => {
    const t = setTimeout(() => { pending.delete(myId); res({ __timeout: true }); }, timeoutMs);
    pending.set(myId, m => { clearTimeout(t); res(m.error ? { __error: m.error } : m.result); });
    try { ws.send(JSON.stringify({ id: myId, method, params })); } catch { clearTimeout(t); res({ __closed: true }); }
  });
}
await send("Page.enable");
await send("Runtime.enable");

const PROBE = `(() => {
  const roots = [document];
  for (let i = 0; i < roots.length; i++) for (const e of roots[i].querySelectorAll('*')) if (e.shadowRoot) roots.push(e.shadowRoot);
  let overlay = null; const videos = [];
  for (const r of roots) {
    const o = r.querySelector && r.querySelector('.codex-startup');
    if (o && !overlay) overlay = o;
    for (const v of (r.querySelectorAll ? r.querySelectorAll('video') : [])) {
      if (v.videoWidth > 0 || v.readyState >= 2) {
        videos.push({ w: v.videoWidth, h: v.videoHeight, t: +v.currentTime.toFixed(2), readyState: v.readyState });
      }
    }
  }
  return JSON.stringify({ roots: roots.length, hasOverlay: !!overlay, overlayClass: overlay ? overlay.className : null, videos });
})()`;

const log = []; let shots = 0; let sawOverlay = false;
const deadline = Date.now() + SECONDS * 1000;
while (Date.now() < deadline) {
  const elapsed = Date.now() - t0;
  let probe = null;
  try {
    const r = await send("Runtime.evaluate", { expression: PROBE, returnByValue: true });
    probe = r?.result?.value ? JSON.parse(r.result.value) : null;
  } catch { }
  if (probe) { log.push({ ms: Date.now() - t0, ...probe }); if (probe.hasOverlay) sawOverlay = true; }

  if (probe?.hasOverlay && shots < MAX_SHOTS) {
    try {
      const s = await send("Page.captureScreenshot", { format: "jpeg", quality: 65 });
      const file = path.join(OUT, `splash-${String(shots).padStart(2, "0")}.jpg`);
      fs.writeFileSync(file, Buffer.from(s.data, "base64"));
      shots++;
    } catch { }
  }
  await sleep(500);
}

const first = log.find(e => e.hasOverlay);
const last = [...log].reverse().find(e => e.hasOverlay);
console.log(JSON.stringify({
  overlaySeen: sawOverlay,
  firstOverlayMs: first?.ms ?? null,
  lastOverlayMs: last?.ms ?? null,
  overlayClass: first?.overlayClass ?? null,
  videos: first?.videos ?? null,
  shots,
  outDir: OUT
}, null, 2));
if (!sawOverlay) {
  console.log('\nNo overlay detected. Usual causes:');
  console.log('  * Codex was already running, so Code-Codex refused to inject (CC-START-STATE-001)');
  console.log('  * startupTransitionEnabled is false, or the plugin is not enabled in localStorage');
  console.log('  * the launch happened before this watcher attached (raise --seconds / attach earlier)');
}
ws.close();
process.exit(0);
