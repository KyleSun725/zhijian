/* Drives the app through UI states and screenshots each. Usage: node tools/scene.mjs */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { backupConfig, restoreConfig } from './_config-backup.mjs';
const __cfgBackup = backupConfig();

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.ZJ_URL || 'http://127.0.0.1:8720/?demo=1&debug=1';
const OUT = path.join(import.meta.dirname, '..', '.tmp');
const PORT = 9340;
const profile = path.join(OUT, 'cdp-profile');
fs.mkdirSync(profile, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mock = spawn(process.execPath, [path.join(import.meta.dirname, 'mock-llm.js')], { stdio: 'ignore' });

const edge = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
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
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break;
    } catch {}
    await sleep(250);
  }
  const t = await (
    await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(BASE)}`, { method: 'PUT' })
  ).json();
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let id = 0;
  const pending = new Map();
  const logs = [];
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push('[' + m.params.type + '] ' + (m.params.args || []).map((a) => a.value ?? a.description).join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');
  await send('Storage.clearDataForOrigin', { origin: 'http://127.0.0.1:8720', storageTypes: 'all' });
  await send('Page.reload');

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const out = r.exceptionDetails
      ? 'ERR ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)
      : r.result.value;
    console.log('  eval ' + expr.replace(/\s+/g, ' ').slice(0, 66) + ' -> ' + String(out).slice(0, 100));
    return out;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
    console.log('  shot ' + name);
  };

  await sleep(4500);
  await shot('s1-reader.png');

  /* --- select text on page 3 --- */
  await evalJs('ZJ.scrollToPage(3)');
  await sleep(1000);
  await evalJs(`(() => {
    const page = document.querySelector('.page[data-page="3"]');
    const spans = [...page.querySelectorAll('.textLayer span')].filter(s => s.textContent.trim().length > 6);
    const a = spans.find(s => s.textContent.includes('十五分钟'));
    if (!a) return 'span not found';
    const r = document.createRange(); r.selectNodeContents(a);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    return 'ok';
  })()`);
  await sleep(600);
  await shot('s2-select.png');
  await evalJs(`document.querySelector('#selToolbar button[data-act="highlight"]').click()`);
  await sleep(500);
  await shot('s3-highlight.png');

  /* --- note flow --- */
  await evalJs(`(() => {
    const page = document.querySelector('.page[data-page="3"]');
    const spans = [...page.querySelectorAll('.textLayer span')].filter(s => s.textContent.trim().length > 6);
    const a = spans.find(s => s.textContent.includes('逐章推进'));
    if (!a) return 'span not found';
    const r = document.createRange(); r.selectNodeContents(a);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    return 'ok';
  })()`);
  await sleep(600);
  await evalJs(`document.querySelector('#selToolbar button[data-act="note"]').click()`);
  await sleep(500);
  await shot('s4-note-editor.png');
  await evalJs(`(() => {
    const ta = document.querySelector('.note-pop textarea');
    ta.value = '这里的三句话模板可以直接套用到任何一章。';
    document.querySelector('.note-pop [data-act="save"]').click();
    return 'saved';
  })()`);
  await sleep(500);
  await evalJs(`document.querySelector('.side-tab[data-panel="notes"]').click()`);
  await sleep(400);
  await shot('s5-notes.png');

  /* --- organizer: delete one page + insert blank, then save --- */
  await evalJs(`document.querySelector('.side-tab[data-panel="pages"]').click()`);
  await sleep(1600);
  await shot('s6-thumbs.png');
  await evalJs('ZJ.openOrganizer()');
  await sleep(2500);
  await shot('s7-organizer.png');
  await evalJs(`(() => {
    document.querySelector('.org-card[data-i="5"] [data-act="delete"]').click();
    document.querySelector('.org-card[data-i="1"] [data-act="after"]').click();
    return 'edited';
  })()`);
  await sleep(1800);
  await shot('s8-organizer-edited.png');
  const saveRes = await evalJs(`(async () => {
    window.showSaveFilePicker = async () => ({
      createWritable: async () => ({ write: async (b) => { window.__saved = b; }, close: async () => {} })
    });
    document.querySelector('#btnOrgSave').click();
    await new Promise(r => setTimeout(r, 3500));
    return JSON.stringify({ total: document.getElementById('pageTotal').textContent, annos: ZJ.state.annotations.length, saved: window.__saved ? window.__saved.length : 0, sheet: !document.getElementById('organizeSheet').hidden });
  })()`);
  console.log('SAVE ->', saveRes);
  await shot('s8-after-save.png');

  /* --- chat against mock LLM --- */
  await evalJs(`fetch('/api/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ provider:'custom', baseUrl:'http://127.0.0.1:8799', model:'mock-llm', apiKey:'sk-test' }) }).then(r=>r.status)`);
  await send('Page.reload');
  await sleep(5000);
  await evalJs(`document.getElementById('btnChatToggle').click(); 'toggled'`);
  await sleep(300);
  const chatOpen = await evalJs(`document.body.classList.contains('chat-collapsed')`);
  if (chatOpen) await evalJs(`document.getElementById('btnChatToggle').click()`);
  await sleep(300);
  await evalJs(`document.querySelector('#chatQuick button[data-act="summary"]').click()`);
  await sleep(2600);
  await shot('s9-chat.png');
  const chatState = await evalJs(`JSON.stringify({ msgs: document.querySelectorAll('.msg').length, cites: document.querySelectorAll('.cite').length, answer: (document.querySelector('.ai-body')?.innerText || '').slice(0, 40) })`);
  console.log('CHAT ->', chatState);

  /* --- dark + settings --- */
  await evalJs(`ZJ.applyTheme('dark')`);
  await sleep(600);
  await shot('s10-dark.png');
  await evalJs(`ZJ.applyTheme('light'); document.getElementById('btnSettings').click()`);
  await sleep(600);
  await shot('s11-settings.png');

  const probe = await evalJs(`JSON.stringify({
    annos: document.querySelectorAll('.anno').length,
    notes: document.querySelectorAll('.note-card').length,
    strong: document.querySelectorAll('.ai-body strong').length,
    typing: document.querySelectorAll('.typing').length,
    fatal: document.querySelector('.fatal')?.innerText || null
  })`);
  console.log('PROBE ' + probe);
  console.log('LOGS:\n' + (logs.filter((l) => !l.includes('Password field')).slice(0, 25).join('\n') || '(none)'));
} catch (e) {
  console.error('FAILED', e.message);
  process.exitCode = 1;
} finally {
  try {
    ws && ws.close();
  } catch {}
  edge.kill();
  mock.kill();
  await sleep(300);
  restoreConfig(__cfgBackup);
  process.exit();
}
