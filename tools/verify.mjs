/* Verification scenes for themes + model + thinking. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { backupConfig, restoreConfig } from './_config-backup.mjs';
const __cfgBackup = backupConfig();

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:8720/?demo=1&debug=1';
const OUT = path.join(import.meta.dirname, '..', '.tmp');
const PORT = 9370;
const profile = path.join(OUT, 'v-profile');
fs.mkdirSync(profile, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = spawn(process.execPath, [path.join(import.meta.dirname, 'mock-llm.js')], { stdio: 'ignore' });
const edge = spawn(
  EDGE,
  ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--window-size=1500,960',
    '--force-device-scale-factor=1', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--disk-cache-dir=' + path.join(profile, 'cache')],
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
  await send('Storage.clearDataForOrigin', { origin: 'http://127.0.0.1:8720', storageTypes: 'all' });
  await send('Page.reload');

  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    const v = r.exceptionDetails ? 'ERR ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) : r.result.value;
    console.log('  ' + e.replace(/\s+/g, ' ').slice(0, 60) + ' -> ' + String(v).slice(0, 80));
    return v;
  };
  const shot = async (n) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, n), Buffer.from(r.data, 'base64'));
    console.log('  shot ' + n);
  };

  await sleep(4500);
  await ev(`document.getElementById('btnSettings').click()`);
  await sleep(700);
  await shot('v1-settings.png');

  await ev(`document.querySelector('#themeGrid [data-theme="gold"]').click()`);
  await sleep(700);
  await shot('v2-settings-gold.png');
  await ev(`document.getElementById('settingsModal').hidden = true`);
  await sleep(500);
  await shot('v3-gold-reader.png');

  await ev(`ZJ.applyTheme('ink')`);
  await sleep(600);
  await shot('v4-ink.png');
  await ev(`ZJ.applyTheme('moss')`);
  await sleep(600);
  await shot('v5-moss.png');
  await ev(`ZJ.applyTheme('parchment')`);
  await sleep(400);

  // chat with mock
  await ev(`fetch('/api/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ provider:'custom', baseUrl:'http://127.0.0.1:8799', model:'deepseek-flash', apiKey:'sk-test', compat:false }) }).then(r=>r.status)`);
  await send('Page.reload');
  await sleep(5200);
  await ev(`document.querySelector('#thinkSeg button[data-effort="low"]').click()`);
  await sleep(300);
  await ev(`document.querySelector('#chatQuick button[data-act="summary"]').click()`);
  await sleep(2600);
  await shot('v6-chat.png');
  const state = await ev(`JSON.stringify({ meta: document.getElementById('chatMeta').textContent, think: [...document.querySelectorAll('#thinkSeg button')].find(b=>b.classList.contains('active'))?.dataset.effort, answer: (document.querySelector('.ai-body')?.innerText||'').slice(0,120) })`);
  console.log('CHAT ->', state);
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
