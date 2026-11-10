#!/usr/bin/env node
/*
 * 纸间 Zhijian — local server
 * - serves the static app from ./public
 * - proxies chat requests to OpenAI / DeepSeek / any OpenAI-compatible endpoint
 * - keeps the API key in ./data/config.json (never leaves this machine except to the provider)
 * Zero runtime dependencies.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { URL } = require('node:url');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');


const SERVER_EN = {
  "请求体过大": "Request body is too large",
  "请求格式错误": "Invalid request format",
  "还没有设置 API Key，请在右上角「设置」里填入。": "Add an API key in Settings first.",
  "缺少 API 地址。": "Missing API URL.",
  "没有对话内容。": "No messages supplied.",
  "无法连接到模型服务：": "Could not connect to the model provider: ",
  "（检查网络或 API 地址）": " (check your network and API URL)",
  "API Key 无效或已过期。": "The API key is invalid or expired.",
  "模型或接口地址不对。": "Check the model name and API URL.",
  "请求太频繁或额度不足。": "Rate limit reached or insufficient quota.",
  "生成中断：": "Generation interrupted: ",
  "请先填写 API Key。": "Enter an API key first.",
  "连接失败：": "Connection failed: ",
  "缺少 API 地址": "Missing API URL",
  "请先填写 API Key": "Enter an API key first",
  "这个地址没有 /models 接口，手动填模型名即可。": "This endpoint has no /models route. Enter a model name manually."
};
function requestText(req, text) {
  return /^en(?:-|,|;|$)/i.test(req.headers['accept-language'] || '') ? (SERVER_EN[text] || text) : text;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
};

const PROVIDERS = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', label: 'OpenAI' },
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', label: 'DeepSeek' },
};

/* ------------------------------------------------------------------ config */

function defaultConfig() {
  return {
    provider: 'deepseek',
    baseUrl: PROVIDERS.deepseek.baseUrl,
    model: PROVIDERS.deepseek.model,
    keys: {},
    compat: false,
  };
}

async function readConfig() {
  let raw = {};
  try {
    raw = JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8'));
  } catch {
    return defaultConfig();
  }
  const cfg = { ...defaultConfig(), ...raw };
  // 每个服务商各存一把 key，来回切换不会互相覆盖
  cfg.keys = { ...(raw.keys || {}) };
  if (raw.apiKey && !cfg.keys[cfg.provider]) cfg.keys[cfg.provider] = raw.apiKey; // 兼容旧格式
  delete cfg.apiKey;
  return cfg;
}

async function writeConfig(cfg) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const safe = {
    provider: String(cfg.provider || 'deepseek'),
    baseUrl: String(cfg.baseUrl || '').trim(),
    model: String(cfg.model || '').trim(),
    keys: { ...(cfg.keys || {}) },
    compat: !!cfg.compat,
  };
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(safe, null, 2), 'utf8');
  return safe;
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 10) return '••••••';
  return key.slice(0, 5) + '••••••' + key.slice(-4);
}

/* ------------------------------------------------------------------- utils */

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(requestText(req, '请求体过大')));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error(requestText(req, '请求格式错误')));
      }
    });
    req.on('error', reject);
  });
}

function joinBase(baseUrl, suffix) {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  return b + suffix;
}

function authHeaders(cfg) {
  const h = { 'Content-Type': 'application/json' };
  const key = cfg.apiKey || (cfg.keys && cfg.keys[cfg.provider]) || '';
  if (key) h.Authorization = 'Bearer ' + key;
  return h;
}

/* --------------------------------------------------------------- chat proxy */

async function handleChat(req, res) {
  const body = await readBody(req);
  const cfg = await readConfig();

  const override = body.config || {};
  const provider = override.provider || cfg.provider;
  const baseUrl = (override.baseUrl || cfg.baseUrl || PROVIDERS[provider]?.baseUrl || '').trim();
  const model = (override.model || cfg.model || '').trim();
  const apiKey = (override.apiKey || cfg.keys[provider] || '').trim();

  if (!apiKey) return sendJSON(res, 400, { error: requestText(req, '还没有设置 API Key，请在右上角「设置」里填入。') });
  if (!baseUrl) return sendJSON(res, 400, { error: requestText(req, '缺少 API 地址。') });
  if (!Array.isArray(body.messages) || !body.messages.length) return sendJSON(res, 400, { error: requestText(req, '没有对话内容。') });

  const payload = {
    model: model || 'deepseek-flash',
    messages: body.messages,
    stream: true,
  };

  // 思考强度：DeepSeek 官方格式是 thinking + reasoning_effort；
  // 其他 OpenAI 兼容端点只发 reasoning_effort，避免出现未知字段报错。
  const effort = String(body.reasoning || '').trim();
  const compat = body.compat === undefined ? !!cfg.compat : !!body.compat;
  const supportsEffort =
    provider === 'deepseek' || provider === 'custom' || /^(o\d|gpt-5)/i.test(model);

  if (!compat && effort && supportsEffort) {
    if (effort === 'off') {
      if (provider === 'deepseek') payload.thinking = { type: 'disabled' };
    } else {
      payload.reasoning_effort = effort;
      if (provider === 'deepseek') payload.thinking = { type: 'enabled' };
    }
  }

  const thinkingOn = payload.thinking && payload.thinking.type === 'enabled';
  // 推理系模型（o 系列、gpt-5 起）只接受默认 temperature，传了会 400
  const strictSampling = /^(o\d|gpt-5)/i.test(model);
  if (!thinkingOn && !strictSampling && typeof body.temperature === 'number') {
    payload.temperature = body.temperature;
  }
  if (typeof body.maxTokens === 'number') payload.max_tokens = body.maxTokens;

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  let upstream;
  try {
    upstream = await fetch(joinBase(baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: authHeaders({ apiKey }),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    return sendJSON(res, 502, { error: requestText(req, '无法连接到模型服务：') + err.message + requestText(req, '（检查网络或 API 地址）') });
  }

  if (!upstream.ok) {
    let detail = '';
    try {
      const text = await upstream.text();
      try {
        const j = JSON.parse(text);
        detail = j.error?.message || j.message || text;
      } catch {
        detail = text;
      }
    } catch {
      /* ignore */
    }
    const hint =
      upstream.status === 401
        ? requestText(req, 'API Key 无效或已过期。')
        : upstream.status === 404
          ? requestText(req, '模型或接口地址不对。')
          : upstream.status === 429
            ? requestText(req, '请求太频繁或额度不足。')
            : '';
    return sendJSON(res, upstream.status, { error: [hint, detail].filter(Boolean).join(' ').slice(0, 600) });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const decoder = new TextDecoder();
  let buffer = '';
  let closed = false;
  res.on('close', () => (closed = true));

  const emit = (obj) => {
    if (!closed) res.write('data: ' + JSON.stringify(obj) + '\n\n');
  };

  try {
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          emit({ done: true });
          res.end();
          return;
        }
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta || {};
          if (delta.content) emit({ t: delta.content });
          if (delta.reasoning_content) emit({ r: delta.reasoning_content });
          const finish = json.choices?.[0]?.finish_reason;
          if (finish) emit({ finish });
        } catch {
          /* partial json line, ignore */
        }
      }
    }
    emit({ done: true });
    res.end();
  } catch (err) {
    if (err.name !== 'AbortError') emit({ error: requestText(req, '生成中断：') + err.message });
    if (!closed) res.end();
  }
}

async function handleTest(req, res) {
  const body = await readBody(req);
  const cfg = await readConfig();
  const override = body.config || {};
  const provider = override.provider || cfg.provider;
  const baseUrl = (override.baseUrl || cfg.baseUrl || '').trim();
  const apiKey = (override.apiKey || cfg.keys[provider] || '').trim();
  const model = (override.model || cfg.model || '').trim();
  if (!apiKey) return sendJSON(res, 400, { error: requestText(req, '请先填写 API Key。') });
  try {
    // 不带 max_tokens：新版 OpenAI 推理模型只认 max_completion_tokens，带错会直接 400
    const payload = { model, messages: [{ role: 'user', content: 'ping' }], stream: false };
    const r = await fetch(joinBase(baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: authHeaders({ apiKey, provider }),
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const t = await r.text();
      return sendJSON(res, r.status, { error: `HTTP ${r.status}: ${t.slice(0, 300)}` });
    }
    return sendJSON(res, 200, { ok: true, model });
  } catch (err) {
    return sendJSON(res, 502, { error: requestText(req, '连接失败：') + err.message });
  }
}

async function handleModels(req, res) {
  const body = await readBody(req);
  const cfg = await readConfig();
  const override = body.config || body;
  const provider = override.provider || cfg.provider;
  const baseUrl = (override.baseUrl || cfg.baseUrl || '').trim();
  const apiKey = (override.apiKey || cfg.keys[provider] || '').trim();
  if (!baseUrl) return sendJSON(res, 400, { error: requestText(req, '缺少 API 地址') });
  if (!apiKey) return sendJSON(res, 400, { error: requestText(req, '请先填写 API Key') });

  try {
    const r = await fetch(joinBase(baseUrl, '/models'), { headers: authHeaders({ apiKey }) });
    if (!r.ok) {
      let detail = '';
      try {
        detail = (await r.text()).slice(0, 300);
      } catch {}
      return sendJSON(res, r.status, {
        error: r.status === 404 ? requestText(req, '这个地址没有 /models 接口，手动填模型名即可。') : `HTTP ${r.status}: ${detail}`,
      });
    }
    const j = await r.json();
    const arr = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : Array.isArray(j) ? j : [];
    const models = [
      ...new Set(
        arr
          .map((m) => (typeof m === 'string' ? m : m.id || m.name || m.model || ''))
          .filter((s) => typeof s === 'string' && s.trim()),
      ),
    ];
    return sendJSON(res, 200, { models });
  } catch (err) {
    return sendJSON(res, 502, { error: requestText(req, '连接失败：') + err.message });
  }
}

/* ------------------------------------------------------------ static files */

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJSON(res, 403, { error: 'forbidden' });

  let stat;
  try {
    stat = await fsp.stat(filePath);
    if (stat.isDirectory()) return serveStatic(req, res, path.posix.join(rel, 'index.html'));
  } catch {
    return sendJSON(res, 404, { error: 'not found' });
  }

  const ext = path.extname(filePath).toLowerCase();
  const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304).end();
    return;
  }
  const revalidate = ['.html', '.js', '.mjs', '.css', '.json'].includes(ext);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    ETag: etag,
    'Cache-Control': revalidate ? 'no-cache' : 'public, max-age=86400',
  });
  fs.createReadStream(filePath).pipe(res);
}

/* ------------------------------------------------------------------- start */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/config' && req.method === 'GET') {
      const cfg = await readConfig();
      const hints = {};
      for (const [p, k] of Object.entries(cfg.keys)) hints[p] = maskKey(k);
      return sendJSON(res, 200, {
        provider: cfg.provider,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        compat: cfg.compat,
        hasKey: !!cfg.keys[cfg.provider],
        keyHint: maskKey(cfg.keys[cfg.provider] || ''),
        hints,
      });
    }
    if (url.pathname === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      const current = await readConfig();
      const provider = body.provider ?? current.provider;
      const next = {
        provider,
        baseUrl: body.baseUrl ?? current.baseUrl,
        model: body.model ?? current.model,
        compat: body.compat === undefined ? current.compat : !!body.compat,
        keys: { ...current.keys },
      };
      // 只更新当前服务商的 key，其他服务商的保持不变
      if (typeof body.apiKey === 'string' && body.apiKey.trim()) next.keys[provider] = body.apiKey.trim();
      const saved = await writeConfig(next);
      return sendJSON(res, 200, {
        ok: true,
        hasKey: !!saved.keys[provider],
        keyHint: maskKey(saved.keys[provider] || ''),
      });
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') return await handleChat(req, res);
    if (url.pathname === '/api/models' && req.method === 'POST') return await handleModels(req, res);
    if (url.pathname === '/api/test' && req.method === 'POST') return await handleTest(req, res);
    if (url.pathname === '/api/health') return sendJSON(res, 200, { ok: true });

    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJSON(res, 405, { error: 'method not allowed' });
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    if (!res.headersSent) sendJSON(res, 500, { error: err.message || 'server error' });
    else res.end();
  }
});

function findPort(start, attempts = 20) {
  return new Promise((resolve, reject) => {
    let port = start;
    const tryPort = () => {
      const probe = http.createServer();
      probe.once('error', () => {
        probe.close();
        port += 1;
        if (port >= start + attempts) reject(new Error('没有可用端口'));
        else tryPort();
      });
      probe.once('listening', () => probe.close(() => resolve(port)));
      probe.listen(port, '127.0.0.1');
    };
    tryPort();
  });
}

function openAppWindow(url) {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
  ];
  const edge = candidates.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  const args = [
    `--app=${url}`,
    '--window-size=1500,960',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
  ];
  if (edge) {
    try {
      spawn(edge, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      return;
    } catch {
      /* fall through */
    }
  }
  try {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* the console already prints the URL */
  }
}

/** 如果同一个端口上已经有一个纸间在跑，直接复用，避免换端口导致数据看起来“丢了” */
async function isRunning(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    if (!r.ok) return false;
    const j = await r.json();
    return !!(j && j.ok);
  } catch {
    return false;
  }
}

(async () => {
  const noOpen = process.argv.includes('--no-open');
  const preferred = 8720;

  if (await isRunning(preferred)) {
    console.log('');
    console.log('  纸间已经在运行，直接打开窗口。');
    console.log('  http://127.0.0.1:' + preferred + '/');
    console.log('');
    if (!noOpen) openAppWindow(`http://127.0.0.1:${preferred}/`);
    return;
  }

  const port = await findPort(preferred);
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log('');
    console.log('  纸间 Zhijian  ·  已启动');
    console.log('  ' + url);
    console.log('  关闭这个窗口即可退出。');
    console.log('');
    if (!noOpen) openAppWindow(url);
  });
})();
