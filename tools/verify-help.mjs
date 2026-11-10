/* Verify the shortcuts / guide views inside settings. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:8720/?demo=1&debug=1';
const OUT = path.join(import.meta.dirname, '..', '.tmp');
const PORT = 9398;
const profile = path.join(OUT, 'h-profile');
fs.mkdirSync(profile, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(
  EDGE,
  ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--window-size=1500,960',
    '--force-device-scale-factor=1', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`],
  { stdio: 'ignore' },
);
let ws;
try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break;
    } catch {}
    await sleep(250);
  }
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(BASE)}`, { method: 'PUT' })).json();
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const logs = [];
  const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(4200);
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    return r.exceptionDetails ? 'ERR ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) : r.result.value;
  };
  const shot = async (n) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, n), Buffer.from(r.data, 'base64'));
    console.log('  shot ' + n);
  };

  await ev(`document.getElementById('btnSettings').click()`);
  await sleep(500);
  await shot('h1-settings.png');

  await ev(`document.querySelector('[data-view="shortcuts"]').click()`);
  await sleep(500);
  await shot('h2-shortcuts.png');
  console.log('title:', await ev(`document.getElementById('modalTitle').textContent`));
  console.log('foot hidden:', await ev(`document.getElementById('modalFoot').hidden`));

  await ev(`document.getElementById('btnViewBack').click()`);
  await sleep(300);
  await ev(`document.querySelector('[data-view="guide"]').click()`);
  await sleep(500);
  await shot('h3-guide.png');
  console.log('title:', await ev(`document.getElementById('modalTitle').textContent`));
  console.log('LOGS:', logs.join(' | ') || '(none)');
} catch (e) {
  console.error('FAILED', e.message);
} finally {
  try { ws && ws.close(); } catch {}
  edge.kill();
  await sleep(300);
  process.exit();
}
