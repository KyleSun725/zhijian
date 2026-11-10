/* Headless screenshot + console capture via CDP. Usage: node tools/shot.mjs <url> <out.png> [waitMs] */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const url = process.argv[2] || 'http://127.0.0.1:8720/?demo=1';
const out = process.argv[3] || path.join(import.meta.dirname, '..', '.tmp', 'shot.png');
const waitMs = Number(process.argv[4] || 5000);
const PORT = 9333 + (Number(process.env.SHOT_PORT_OFFSET) || 0);
const profile = path.join(import.meta.dirname, '..', '.tmp', 'cdp-profile');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.mkdirSync(profile, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--window-size=1500,960',
    '--force-device-scale-factor=1',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--disk-cache-dir=' + path.join(profile, 'cache'),
  ],
  { stdio: 'ignore' },
);

let ws;
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await sleep(250);
  }
  if (!ready) throw new Error('Edge CDP 未就绪');

  const t = await (
    await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  ).json();
  ws = new WebSocket(t.webSocketDebuggerUrl);

  let id = 0;
  const pending = new Map();
  const logs = [];

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const args = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      logs.push(`[${msg.params.type}] ${args}`);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      logs.push(`[exception] ${d.exception?.description || d.text}`);
    }
    if (msg.method === 'Log.entryAdded') {
      logs.push(`[${msg.params.entry.level}] ${msg.params.entry.text}`);
    }
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Network.enable');

  await sleep(waitMs);

  const probe = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      pages: document.querySelectorAll('.page').length,
      rendered: document.querySelectorAll('.page[data-rendered="1"]').length,
      canvases: document.querySelectorAll('canvas').length,
      total: document.getElementById('pageTotal')?.textContent,
      fatal: document.querySelector('.fatal')?.innerText || null,
      toast: document.querySelector('.toast')?.innerText || null,
      title: document.getElementById('docTitle')?.textContent
    })`,
    returnByValue: true,
  });

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));

  console.log('PROBE ' + probe.result.value);
  console.log('LOGS:\n' + (logs.slice(0, 40).join('\n') || '(none)'));
  console.log('SHOT ' + out);
} catch (err) {
  console.error('FAILED', err.message);
  process.exitCode = 1;
} finally {
  try {
    ws && ws.close();
  } catch {}
  edge.kill();
  await sleep(300);
  process.exit();
}
