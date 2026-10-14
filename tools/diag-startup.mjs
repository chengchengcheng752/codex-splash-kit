// Measure Codex startup jank: rAF frame gaps, main-thread long tasks, and video drop stats.
//
// usage: node diag-startup.mjs --port <n> [--seconds 90] [--label myrun] [--out diag.json]
//
// WHY addScriptToEvaluateOnNewDocument:
//   The renderer NAVIGATES during startup (observed: 2 navigations). A sampler installed
//   with a plain Runtime.evaluate dies with the document. We register it as a new-document
//   script and accumulate counters in sessionStorage, which survives navigations in the tab.
//
// Interpreting the output:
//   gapMax / g200        -> visible hitches (a 200ms+ stall at 60Hz is ~12 dropped frames)
//   ltMax / ltTop        -> main-thread blocking (bundle parse/execute, React mount, …)
//   vq.dropped + rate=1  -> if playbackRate stays 1 and buffered == full duration but frames
//                           drop, the media pipeline is being starved, not throttled by config.

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };

const PORT = Number(arg("--port", process.env.CDP_PORT));
if (!PORT) { console.error("usage: node diag-startup.mjs --port <n> [--seconds 90] [--label name]"); process.exit(2); }
const SECONDS = Number(arg("--seconds", 90));
const LABEL = arg("--label", "run");
const OUT = arg("--out", `diag-${LABEL}.json`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SAMPLER = `(() => {
  if (window.__startupDiag) return 'already';
  const KEY = '__startupDiagAgg';
  const load = () => { try { return JSON.parse(sessionStorage.getItem(KEY)); } catch (e) { return null; } };
  const save = a => { try { sessionStorage.setItem(KEY, JSON.stringify(a)); } catch (e) {} };
  const agg = load() || { navs: 0, flushes: 0, gapsN: 0, gapMax: 0, g50: 0, g100: 0, g200: 0,
                          ltN: 0, ltMax: 0, ltTotal: 0, ltTop: [], vqFirst: null, vqLast: null, url: location.href };
  agg.navs++; save(agg);

  const local = { gapsN: 0, gapMax: 0, g50: 0, g100: 0, g200: 0, ltN: 0, ltMax: 0, ltTotal: 0, ltTop: [], vqFirst: null, vqLast: null };
  let last = performance.now();
  const loop = now => {
    const g = now - last; last = now;
    local.gapsN++; if (g > local.gapMax) local.gapMax = g;
    if (g > 50) local.g50++; if (g > 100) local.g100++; if (g > 200) local.g200++;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  try {
    new PerformanceObserver(l => {
      for (const e of l.getEntries()) { local.ltN++; local.ltTotal += e.duration; if (e.duration > local.ltMax) local.ltMax = e.duration; local.ltTop.push(Math.round(e.duration)); }
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) {}

  const findVideo = () => {
    const host = [...document.querySelectorAll('*')].find(e => e.tagName.startsWith('CODE-CODEX'));
    const inShadow = host && host.shadowRoot ? host.shadowRoot.querySelector('video') : null;
    if (inShadow && inShadow.videoWidth > 0) return inShadow;
    const roots = [document];
    for (let i = 0; i < roots.length; i++) for (const e of roots[i].querySelectorAll('*')) if (e.shadowRoot) roots.push(e.shadowRoot);
    for (const r of roots) { const v = r.querySelector && r.querySelector('video'); if (v && v.videoWidth > 0) return v; }
    return null;
  };
  setInterval(() => {
    const v = findVideo();
    if (v && v.getVideoPlaybackQuality) {
      const q = v.getVideoPlaybackQuality();
      const s = { t: Math.round(performance.now()), total: q.totalVideoFrames, dropped: q.droppedVideoFrames,
                  ct: +v.currentTime.toFixed(2), rate: v.playbackRate, rs: v.readyState,
                  buf: v.buffered.length ? +v.buffered.end(v.buffered.length - 1).toFixed(2) : null,
                  inOverlay: !!(v.closest && v.closest('.codex-startup')) };
      if (!local.vqFirst) local.vqFirst = s; local.vqLast = s;
    }
  }, 1000);

  setInterval(() => {
    const a = load(); if (!a) return;
    a.gapsN += local.gapsN; if (local.gapMax > a.gapMax) a.gapMax = local.gapMax;
    a.g50 += local.g50; a.g100 += local.g100; a.g200 += local.g200;
    a.ltN += local.ltN; a.ltTotal += local.ltTotal; if (local.ltMax > a.ltMax) a.ltMax = local.ltMax;
    a.ltTop = a.ltTop.concat(local.ltTop).sort((x, y) => y - x).slice(0, 8);
    if (local.vqFirst) { if (!a.vqFirst) a.vqFirst = local.vqFirst; a.vqLast = local.vqLast; }
    a.flushes++;
    save(a);
    local.gapsN = 0; local.gapMax = 0; local.g50 = 0; local.g100 = 0; local.g200 = 0;
    local.ltN = 0; local.ltMax = 0; local.ltTotal = 0; local.ltTop = [];
  }, 1000);

  window.__startupDiag = true;
  return 'installed';
})()`;

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
console.log(JSON.stringify({ label: LABEL, attachAfterMs: Date.now() - t0 }));

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener("message", ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
ws.addEventListener("close", () => { for (const [, r] of pending) r({ __closed: true }); pending.clear(); });
await new Promise(r => ws.addEventListener("open", r));
function send(method, params = {}, timeoutMs = 6000) {
  const myId = ++id;
  return new Promise(res => {
    const t = setTimeout(() => { pending.delete(myId); res({ __timeout: true }); }, timeoutMs);
    pending.set(myId, m => { clearTimeout(t); res(m.error ? { __error: m.error } : m.result); });
    try { ws.send(JSON.stringify({ id: myId, method, params })); } catch { clearTimeout(t); res({ __closed: true }); }
  });
}
await send("Page.enable");
await send("Runtime.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: SAMPLER });
await send("Runtime.evaluate", { expression: SAMPLER, returnByValue: true });

const rows = [];
const deadline = Date.now() + SECONDS * 1000;
while (Date.now() < deadline) {
  await sleep(4000);
  const r = await send("Runtime.evaluate", { expression: `sessionStorage.getItem('__startupDiagAgg')`, returnByValue: true }, 5000);
  const v = r?.result?.value;
  if (!v) { console.log(JSON.stringify({ t: Math.round((Date.now() - t0) / 1000), note: "no data (renderer navigating?)" })); continue; }
  const p = JSON.parse(v);
  rows.push(p);
  console.log(JSON.stringify({
    t: Math.round((Date.now() - t0) / 1000), navs: p.navs,
    frames: p.gapsN, gapMax: Math.round(p.gapMax), g50: p.g50, g100: p.g100, g200: p.g200,
    longTasks: p.ltN, ltMax: Math.round(p.ltMax), ltTop: p.ltTop.slice(0, 5),
    video: p.vqLast
  }));
}

const fs = await import("node:fs");
fs.writeFileSync(OUT, JSON.stringify(rows, null, 2));
console.log(`\nwritten: ${OUT}`);
ws.close();
process.exit(0);
