/* Verify the live model-list fetch UI. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { backupConfig, restoreConfig } from './_config-backup.mjs';
const __cfgBackup = backupConfig();

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:8720/?demo=1&debug=1';
const OUT = path.join(import.meta.dirname, '..', '.tmp');
const PORT = 9390;
const profile = path.join(OUT, 'm-profile');
fs.mkdirSync(profile, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = spawn(process.execPath, [path.join(import.meta.dirname, 'mock-llm.js')], { stdio: 'ignore' });
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
  await sleep(4500);

  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    const v = r.exceptionDetails ? 'ERR ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) : r.result.value;
    console.log('  ' + e.replace(/\s+/g, ' ').slice(0, 56) + ' -> ' + String(v).slice(0, 90));
    return v;
  };
  const shot = async (n) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, n), Buffer.from(r.data, 'base64'));
    console.log('  shot ' + n);
  };

  await ev(`document.getElementById('btnSettings').click()`);
  await sleep(400);
  await ev(`document.querySelector('#providerSeg [data-provider="custom"]').click()`);
  await ev(`document.getElementById('cfgBaseUrl').value = 'http://127.0.0.1:8799'`);
  await ev(`document.getElementById('cfgModel').value = ''`);
  await ev(`document.getElementById('cfgKey').value = 'sk-test'`);
  await ev(`document.getElementById('btnFetchModels').click()`);
  await sleep(1800);
  await shot('m1-models.png');
  const info = await ev(`JSON.stringify({ chips: document.querySelectorAll('#modelChips .chip').length, first: [...document.querySelectorAll('#modelChips .chip')].slice(0,4).map(c=>c.textContent), scroll: document.getElementById('modelChips').classList.contains('scroll') })`);
  console.log('MODELS ->', info);
  console.log('LOGS:', logs.join(' | ') || '(none)');
} catch (e) {
  console.error('FAILED', e.message);
} finally {
  try { ws && ws.close(); } catch {}
  edge.kill();
  mock.kill();
  await sleep(300);
  restoreConfig(__cfgBackup);
  process.exit();
}
