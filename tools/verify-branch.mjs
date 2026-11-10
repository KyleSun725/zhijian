/* Verify KaTeX rendering + chat branching + edit-last. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { backupConfig, restoreConfig } from './_config-backup.mjs';
const __cfgBackup = backupConfig();

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:8720/?demo=1&debug=1';
const OUT = path.join(import.meta.dirname, '..', '.tmp');
const PORT = 9430;
const profile = path.join(OUT, 'b-profile');
fs.mkdirSync(profile, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = spawn(process.execPath, [path.join(import.meta.dirname, 'mock-llm.js')], { stdio: 'ignore' });
const edge = spawn(
  EDGE,
  ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--window-size=1500,1000',
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
  await send('Storage.clearDataForOrigin', { origin: 'http://127.0.0.1:8720', storageTypes: 'all' });
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

  await ev("fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'custom',baseUrl:'http://127.0.0.1:8799',model:'deepseek-flash',apiKey:'sk-test',compat:false})}).then(r=>r.status)");
  await send('Page.reload');
  await sleep(5200);

  await ev("document.querySelector('#chatQuick button[data-act=\"summary\"]').click()");
  await sleep(3000);
  console.log('katex:', await ev("document.querySelectorAll('.ai-body .katex').length"), 'display:', await ev("document.querySelectorAll('.ai-body .katex-display').length"));
  await shot('b1-math.png');

  await ev("document.querySelector('#chatQuick button[data-act=\"quiz\"]').click()");
  await sleep(2800);
  console.log('user msgs:', await ev("document.querySelectorAll('.msg-user').length"), 'tools:', await ev("[...document.querySelectorAll('.msg-user')].map(m=>m.querySelectorAll('.user-tools button').length).join(',')"));
  await ev("document.querySelectorAll('.msg-user')[1].scrollIntoView({block:'start'})");
  await sleep(500);
  await shot('b2-tools.png');

  await ev("document.querySelectorAll('.msg-user')[1].querySelectorAll('.user-tools button')[1].click()");
  await sleep(700);
  console.log('branch ->', await ev("JSON.stringify({chats:ZJ.state.chats.length, msgs:ZJ.state.chat.length, input:document.getElementById('chatText').value.slice(0,16), titles:ZJ.state.chats.map(c=>c.title)})"));
  await shot('b3-branch.png');

  await ev("document.querySelectorAll('.msg-user')[0].querySelectorAll('.user-tools button')[0].click()");
  await sleep(500);
  console.log('edit ->', await ev("JSON.stringify({msgs:ZJ.state.chat.length, input:document.getElementById('chatText').value.slice(0,12), chats:ZJ.state.chats.length})"));
  await shot('b4-edit.png');
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
