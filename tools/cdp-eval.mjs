// Evaluate JavaScript inside the Codex renderer that Code-Codex has injected into.
//
// usage:
//   node cdp-eval.mjs --port 12345 --expr "document.title"
//   node cdp-eval.mjs --port 12345 --shadow ".startupTransition-status"
//   node cdp-eval.mjs --port 12345 --list          # list CDP targets
//   node cdp-eval.mjs --port 12345 --urls          # list video elements anywhere
//
// Code-Codex's own UI is a custom element (<code-codex-v0-4-25>) with a shadow root,
// so document.querySelector() cannot see its panels. --shadow resolves inside it.

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const has = name => argv.includes(name);

const PORT = Number(arg("--port", process.env.CDP_PORT ?? 54152));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function targets() {
  try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); }
  catch (e) { console.error(`cannot reach CDP on 127.0.0.1:${PORT} — is Codex running through Code-Codex?`); process.exit(1); }
}

const list = await targets();
if (has("--list")) {
  console.log(JSON.stringify(list.map(t => ({ type: t.type, title: t.title, url: t.url })), null, 2));
  process.exit(0);
}

const target = list.find(t => t.type === "page" && /^app:/.test(t.url)) ?? list.find(t => t.type === "page");
if (!target) { console.error("no page target"); process.exit(1); }

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
await send("Runtime.enable");

let expression;
if (has("--shadow")) {
  const sel = JSON.stringify(arg("--shadow"));
  expression = `(() => {
    // The host custom element is version-tagged (e.g. code-codex-v0-4-25), so match by prefix.
    const host = [...document.querySelectorAll('*')].find(e => e.tagName.startsWith('CODE-CODEX'));
    if (!host || !host.shadowRoot) return 'no Code-Codex shadow root (UI not mounted yet?)';
    const el = host.shadowRoot.querySelector(${sel});
    if (!el) return 'not found in ' + host.tagName + ': ' + ${sel};
    return JSON.stringify({
      host: host.tagName,
      tag: el.tagName, cls: (el.className||'').toString(),
      text: (el.textContent||'').trim().slice(0, 400),
      pressed: el.getAttribute && el.getAttribute('aria-pressed'),
      html: el.outerHTML ? el.outerHTML.slice(0, 800) : null
    }, null, 1);
  })()`;
} else if (has("--urls")) {
  expression = `(() => {
    const roots = [document];
    for (let i = 0; i < roots.length; i++) for (const e of roots[i].querySelectorAll('*')) if (e.shadowRoot) roots.push(e.shadowRoot);
    const out = [];
    for (const r of roots) for (const v of r.querySelectorAll('video')) {
      const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
      out.push({ w: v.videoWidth, h: v.videoHeight, paused: v.paused, readyState: v.readyState,
                 currentTime: +v.currentTime.toFixed(2), playbackRate: v.playbackRate,
                 buffered: v.buffered.length ? +v.buffered.end(v.buffered.length-1).toFixed(2) : null,
                 total: q?.totalVideoFrames ?? null, dropped: q?.droppedVideoFrames ?? null });
    }
    return JSON.stringify(out, null, 1);
  })()`;
} else if (has("--file")) {
  const fs = await import("node:fs");
  expression = fs.readFileSync(arg("--file"), "utf8");
} else {
  expression = arg("--expr");
  if (!expression) { console.error("need --expr, --file, --shadow <sel>, --list or --urls"); process.exit(2); }
}

const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
if (r?.exceptionDetails) console.error("EXCEPTION:", JSON.stringify(r.exceptionDetails).slice(0, 1500));
console.log(JSON.stringify(r?.result?.value ?? r, null, 2));
ws.close();
