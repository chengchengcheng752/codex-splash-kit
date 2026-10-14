// Import a video as the Codex startup animation, through the app's own import flow.
//
// The Code-Codex UI lives inside a custom element with a shadow root, so the file
// input is invisible to document-level queries. We resolve it via CDP's flattened
// document (pierce: true) and feed it with DOM.setFileInputFiles — exactly what
// happens when a human clicks "choose video" in the settings panel.
//
// usage: node import-startup-video.mjs --video <abs path> [--port <n>]
//
// Notes:
//   * Pass the video path as an argv value that is ASCII-safe. Windows console code
//     pages can mangle non-ASCII arguments passed to node; stage the file at an ASCII
//     path if your source path contains non-ASCII characters.
//   * Every CDP call is bounded: the renderer reloads during import, so an unbounded
//     await can hang forever.

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const VIDEO = arg("--video");
const PORT = Number(arg("--port", process.env.CDP_PORT ?? 54152));
if (!VIDEO) { console.error("usage: node import-startup-video.mjs --video <path> [--port <n>]"); process.exit(2); }

const fs = await import("node:fs");
if (!fs.existsSync(VIDEO)) { console.error("video not found:", VIDEO); process.exit(2); }
console.log("staged file :", VIDEO, fs.statSync(VIDEO).size, "bytes");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SELECTOR = "input.startupTransition-file";

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = targets.find(t => t.type === "page" && /^app:/.test(t.url)) ?? targets.find(t => t.type === "page");
if (!target) { console.error("no page target on port " + PORT); process.exit(1); }

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
    const timer = setTimeout(() => { pending.delete(myId); res({ __timeout: true }); }, timeoutMs);
    pending.set(myId, m => { clearTimeout(timer); res(m.error ? { __error: m.error } : m.result); });
    try { ws.send(JSON.stringify({ id: myId, method, params })); } catch { clearTimeout(timer); res({ __closed: true }); }
  });
}

await send("DOM.enable");
await send("Runtime.enable");

// Resolve the file input through the flattened document so shadow roots are visible.
// (Runtime.evaluate + DOM.requestNode returns nodeId 0 for shadow-DOM nodes.)
// The host custom element is version-tagged (code-codex-v0-4-25), so resolve its real
// tag name at runtime instead of hardcoding it.
const hostTag = await send("Runtime.evaluate", {
  expression: `(() => { const h = [...document.querySelectorAll('*')].find(e => e.tagName.startsWith('CODE-CODEX'));
                         return h ? h.tagName.toLowerCase() : null; })()`,
  returnByValue: true
});
const tag = hostTag?.result?.value;
if (!tag) {
  console.error("Code-Codex host element not found — is Codex running through Code-Codex, and has the UI mounted?");
  ws.close(); process.exit(1);
}
console.log("host element:", tag);

const doc = await send("DOM.getDocument", { depth: -1, pierce: true });
let nodeId = 0;
const host = await send("DOM.querySelector", { nodeId: doc?.root?.nodeId, selector: tag });
if (host?.nodeId) {
  const desc = await send("DOM.describeNode", { nodeId: host.nodeId, pierce: true });
  const sr = desc?.node?.shadowRoots?.[0];
  if (sr?.nodeId) {
    const inp = await send("DOM.querySelector", { nodeId: sr.nodeId, selector: SELECTOR });
    nodeId = inp?.nodeId ?? 0;
  }
}
if (!nodeId) {
  console.error(`could not resolve "${SELECTOR}" — is Code-Codex injected and the settings panel mounted?`);
  ws.close(); process.exit(1);
}
console.log("file input  : nodeId", nodeId);

const r = await send("DOM.setFileInputFiles", { files: [VIDEO], nodeId }, 20000);
console.log("setFileInputFiles:", (r && !r.__error && !r.__timeout && !r.__closed) ? "sent" : JSON.stringify(r));

// The app streams the blob to disk; give it time. Do not hold a long-await evaluate here.
await sleep(12000);

const st = await send("Runtime.evaluate", {
  expression: `(() => {
    const host = [...document.querySelectorAll('*')].find(e => e.tagName.startsWith('CODE-CODEX'));
    const sr = host?.shadowRoot;
    if (!sr) return 'shadow root gone (renderer reloaded) - check the managed store on disk';
    const still  = sr.querySelector('video.startupTransition-video-still');
    const range  = sr.querySelector('.startupTransition-timeline-range');
    const status = sr.querySelector('.startupTransition-status');
    return JSON.stringify({
      status:   status?.textContent.trim().slice(0, 80) ?? null,
      still:    still ? { duration: still.duration, w: still.videoWidth, h: still.videoHeight } : null,
      timeline: range?.textContent.trim().slice(0, 80) ?? null,
      stored:   localStorage.getItem('code-codex:startup-transition:v1')
    });
  })()`, returnByValue: true
}, 6000);

console.log("plugin state:", st?.result?.value ?? JSON.stringify(st));
ws.close();
process.exit(0);
