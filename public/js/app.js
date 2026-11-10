import { tr, getLocale, initI18n, refreshStatic } from './i18n.js';
/* =========================================================
   纸间 Zhijian — reader, annotations, page tools, AI chat
   ========================================================= */
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
import { mdToHtml, esc } from './markdown.js';
import { loadDoc, saveDoc, fingerprint } from './store.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const VENDOR = new URL('../vendor/pdfjs/', import.meta.url).href;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'a' + Math.random().toString(36).slice(2));

const COLOR_VAR = {
  amber: 'var(--hl-amber)',
  sage: 'var(--hl-sage)',
  sky: 'var(--hl-sky)',
  rose: 'var(--hl-rose)',
};

/* ---------------------------------------------------------------- state */
const state = {
  pdfDoc: null,
  pdfBytes: null,
  fileName: '',
  fileHandle: null,
  docKey: '',
  numPages: 0,
  scale: 1,
  fit: true,
  pageGeos: [],
  pageEls: [],
  pageTops: [],
  rendered: new Set(),
  tasks: new Map(),
  currentPage: 1,
  annotations: [],
  textCache: new Map(),
  toc: [],
  selection: null,
  pendingColor: 'amber',
  chat: [],
  chats: [],
  activeChatId: '',
  busy: false,
  orgPlan: [],
  orgOpen: false,
  gen: 0,
  effort: localStorage.getItem('zj-effort') || 'high',
  scope: localStorage.getItem('zj-scope') || 'full',
  fetchedModels: null,
  pdfDark: localStorage.getItem('zj-pdf-dark') || 'smart',
  pageLight: new Map(),
};

const EFFORT_LABEL = { off: '关', low: '低', high: '高', max: '最高' };

const els = {
  reader: $('#reader'),
  pages: $('#pages'),
  dropzone: $('#dropzone'),
  docTitle: $('#docTitle'),
  pageInput: $('#pageInput'),
  pageTotal: $('#pageTotal'),
  zoomLabel: $('#zoomLabel'),
  sidebar: $('#sidebar'),
  chatPanel: $('#chatPanel'),
  chatScroll: $('#chatScroll'),
  chatText: $('#chatText'),
  chatForm: $('#chatForm'),
  chatQuick: $('#chatQuick'),
  selToolbar: $('#selToolbar'),
  toastWrap: $('#toastWrap'),
  settingsModal: $('#settingsModal'),
  organizeSheet: $('#organizeSheet'),
  orgGrid: $('#orgGrid'),
  orgSub: $('#orgSub'),
  annoMenu: $('#annoMenu'),
  noteCount: $('#noteCount'),
  chatMeta: $('#chatMeta'),
};

const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2, 2.4, 3];

/* ---------------------------------------------------------------- utils */
function toast(msg, ms = 2400) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  els.toastWrap.append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  }, ms);
}

let fatals = 0;
function fatal(err) {
  console.error(err);
  if (fatals++ > 2) return;
  const el = document.createElement('div');
  el.className = 'fatal';
  el.innerHTML = tr`<strong>出错了</strong><div>${esc(err && err.message ? err.message : String(err))}</div>`;
  document.body.append(el);
}
window.addEventListener('error', (e) => fatal(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => fatal(e.reason));

function fitScale() {
  const geo = state.pageGeos[state.currentPage] || state.pageGeos[1] || { w: 595, h: 842 };
  const avail = els.reader.clientWidth - 72;
  return clamp(avail / geo.w, 0.3, 2.2);
}

/* ---------------------------------------------------------------- theme */
const THEMES = [
  { id: 'parchment', name: '羊皮纸', mode: 'light', bg: '#e8e3d9', panel: '#ffffff', accent: '#b0512d' },
  { id: 'ivory', name: '素白', mode: 'light', bg: '#f1f0ec', panel: '#ffffff', accent: '#4a6b8a' },
  { id: 'ink', name: '墨蓝', mode: 'light', bg: '#e5e9ef', panel: '#ffffff', accent: '#2c5f8a' },
  { id: 'moss', name: '苔绿', mode: 'light', bg: '#e7e9e0', panel: '#ffffff', accent: '#4f7350' },
  { id: 'gold', name: '暗金', mode: 'dark', bg: '#14120e', panel: '#1d1a14', accent: '#c9a227' },
  { id: 'midnight', name: '午夜', mode: 'dark', bg: '#0e131b', panel: '#161c26', accent: '#5b8fd6' },
];
const themeById = (id) => THEMES.find((t) => t.id === id) || THEMES[0];

function applyTheme(id, remember = true) {
  const t = themeById(id);
  const root = document.documentElement;
  root.dataset.theme = t.id;
  root.dataset.mode = t.mode;
  if (remember) {
    localStorage.setItem('zj-theme', t.id);
    localStorage.setItem('zj-last-' + t.mode, t.id);
  }
  const use = t.mode === 'dark' ? '#i-sun' : '#i-moon';
  $('#btnTheme use').setAttribute('href', use);
  $('#btnTheme').title = t.mode === 'dark' ? tr('切换到浅色') : tr('切换到深色');
  $$('#themeGrid .theme-card').forEach((c) => c.classList.toggle('active', c.dataset.theme === t.id));
}

function toggleMode() {
  const cur = themeById(document.documentElement.dataset.theme);
  const target =
    cur.mode === 'dark'
      ? localStorage.getItem('zj-last-light') || 'parchment'
      : localStorage.getItem('zj-last-dark') || 'gold';
  applyTheme(target);
}

const stored = localStorage.getItem('zj-theme');
applyTheme(stored === 'dark' ? 'gold' : stored === 'light' ? 'parchment' : stored || 'parchment');

/* ================================================================
   file loading
   ================================================================ */
async function pickFile() {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: tr('PDF 文档'), accept: { 'application/pdf': ['.pdf'] } }],
        multiple: false,
      });
      const file = await handle.getFile();
      await loadFile(file, handle);
    } catch (err) {
      if (err && err.name !== 'AbortError') toast(tr('打开失败：') + err.message);
    }
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/pdf,.pdf';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (file) await loadFile(file, null);
  };
  input.click();
}

async function loadFile(file, handle) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  await loadBytes(bytes, file.name.replace(/\.pdf$/i, ''), {
    handle,
    mtime: file.lastModified,
    size: file.size,
  });
}

async function loadBytes(bytes, name, meta = {}) {
  closeOrganizer(true);
  hideSelectionBar();
  els.dropzone.classList.add('hidden');
  els.pages.innerHTML = '';
  state.rendered.clear();
  state.tasks.forEach((t) => {
    try {
      t.cancel();
    } catch {}
  });
  state.tasks.clear();
  state.textCache.clear();
  state.pageEls = [];
  state.pageGeos = [];
  state.pageTops = [];
  state.pageLight.clear();
  state.annotations = [];
  state.pdfBytes = bytes;
  state.fileName = name;
  state.fileHandle = meta.handle || null;
  state.docKey = fingerprint(name, bytes.length, meta.mtime || 0);
  state.gen += 1;

  els.docTitle.textContent = name;
  els.docTitle.classList.add('has-doc');
  els.docTitle.title = name;

  try {
    const task = pdfjsLib.getDocument({
      data: bytes.slice(0),
      cMapUrl: VENDOR + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: VENDOR + 'standard_fonts/',
      wasmUrl: VENDOR + 'wasm/',
      iccUrl: VENDOR + 'iccs/',
    });
    task.onPassword = (update, reason) => {
      const pw = window.prompt(reason === 2 ? tr('密码不正确，请重试：') : tr('这个 PDF 有密码，请输入：'));
      if (pw === null) task.destroy();
      else update(pw);
    };
    state.pdfDoc = await task.promise;
  } catch (err) {
    fatal(new Error(tr('无法解析这个 PDF：') + (err.message || err)));
    els.dropzone.classList.remove('hidden');
    return;
  }

  state.numPages = state.pdfDoc.numPages;
  els.pageTotal.textContent = state.numPages;
  state.currentPage = 1;

  if (state.numPages > 60) toast(tr`正在排版 ${state.numPages} 页…`, 1200);
  for (let i = 1; i <= state.numPages; i++) {
    const page = await state.pdfDoc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    state.pageGeos[i] = { w: vp.width, h: vp.height };
  }

  buildPageShells();
  state.fit = true;
  state.scale = fitScale();
  layout();

  const saved = await loadDoc(state.docKey);
  state.chats = [];
  state.activeChatId = '';
  if (saved) {
    state.annotations = saved.annotations || [];
    if (saved.lastPage && saved.lastPage <= state.numPages) state.currentPage = saved.lastPage;
    if (Array.isArray(saved.chats) && saved.chats.length) {
      state.chats = saved.chats;
    } else if (Array.isArray(saved.chat) && saved.chat.length) {
      // 旧版本只有一条对话，迁移成一条历史
      state.chats = [
        {
          id: uid(),
          title: titleOfMessages(saved.chat),
          messages: saved.chat,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];
    }
    if (saved.activeChatId && state.chats.some((c) => c.id === saved.activeChatId)) {
      state.activeChatId = saved.activeChatId;
    }
  }
  if (!state.chats.length) state.chats = [newChatObj()];
  if (!state.activeChatId) state.activeChatId = state.chats[0].id;
  state.chat = activeChat().messages;
  renderAllAnnotations();
  renderNotesList();
  renderChatHistory();
  renderChatList();

  await buildToc();
  ensureThumbPanel();
  scrollToPage(state.currentPage, false);
  updatePageInfo();
  updateChatMeta();
  if (window.innerWidth < 1200) document.body.classList.add('chat-collapsed');
}

function buildPageShells() {
  const frag = document.createDocumentFragment();
  for (let i = 1; i <= state.numPages; i++) {
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.page = i;
    el.dataset.rendered = '0';
    el.innerHTML =
      '<div class="page-skeleton"></div><div class="anno-layer"></div><span class="page-tag">' + i + '</span>';
    frag.append(el);
    state.pageEls.push(el);
  }
  els.pages.append(frag);
  observePages();
}

/* ================================================================
   layout & rendering
   ================================================================ */
function layout() {
  const s = state.scale;
  state.gen += 1;
  state.tasks.forEach((t) => {
    try {
      t.cancel();
    } catch {}
  });
  state.tasks.clear();
  state.rendered.clear();
  for (let i = 0; i < state.pageEls.length; i++) {
    const el = state.pageEls[i];
    const geo = state.pageGeos[i + 1];
    if (!geo) continue;
    el.style.width = geo.w * s + 'px';
    el.style.height = geo.h * s + 'px';
    el.style.setProperty('--total-scale-factor', s);
    el.style.setProperty('--scale-round-x', '1px');
    el.style.setProperty('--scale-round-y', '1px');
    if (el.dataset.rendered === '1') clearPage(el);
  }
  els.zoomLabel.textContent = Math.round(s * 100) + '%';
  measureTops();
  requestAnimationFrame(renderVisible);
}

function measureTops() {
  state.pageTops = state.pageEls.map((el) => el.offsetTop);
}

function clearPage(el) {
  el.dataset.rendered = '0';
  el.querySelectorAll('canvas, .textLayer').forEach((n) => n.remove());
  if (!el.querySelector('.page-skeleton')) {
    const sk = document.createElement('div');
    sk.className = 'page-skeleton';
    el.prepend(sk);
  }
  state.rendered.delete(Number(el.dataset.page));
}

let visibilityObserver = null;
function observePages() {
  if (visibilityObserver) visibilityObserver.disconnect();
  visibilityObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const n = Number(entry.target.dataset.page);
          if (n && entry.target.dataset.rendered !== '1') renderPage(n);
        }
      }
    },
    { root: els.reader, rootMargin: '700px 0px' },
  );
  state.pageEls.forEach((el) => visibilityObserver.observe(el));
}

function renderVisible() {
  const top = els.reader.scrollTop;
  const bottom = top + els.reader.clientHeight;
  const tops = state.pageTops;
  for (let i = 0; i < state.pageEls.length; i++) {
    const el = state.pageEls[i];
    const t = tops[i] != null ? tops[i] : el.offsetTop;
    const h = el.offsetHeight;
    if (t + h > top - 700 && t < bottom + 700 && el.dataset.rendered !== '1') {
      renderPage(i + 1);
      if (state.rendered.size >= 10) break;
    }
  }
  pruneRendered();
}

/* ---------------- 夜间 PDF 显示 ---------------- */
/** 把已渲染的画布缩到 40×40 采样，判断这一页是不是白底 */
function canvasIsLight(canvas) {
  try {
    const s = 40;
    const tmp = document.createElement('canvas');
    tmp.width = s;
    tmp.height = s;
    const ctx = tmp.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, s, s);
    const d = ctx.getImageData(0, 0, s, s).data;
    let sum = 0;
    let bright = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      sum += l;
      if (l > 0.78) bright++;
    }
    const n = s * s;
    return sum / n > 0.5 && bright / n > 0.35;
  } catch {
    return true;
  }
}

function applyPdfDarkMode() {
  document.documentElement.dataset.pdfDark = state.pdfDark;
  for (const [n, light] of state.pageLight) {
    const el = state.pageEls[n - 1];
    if (el) el.dataset.invert = light ? '1' : '0';
  }
}

async function renderPage(n) {
  const el = state.pageEls[n - 1];
  if (!el || el.dataset.rendered === '1' || state.tasks.has(n)) return;
  const geo = state.pageGeos[n];
  if (!geo) return;

  const gen = state.gen;
  const scale = state.scale;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const vpWidth = geo.w * scale;
  const vpHeight = geo.h * scale;

  let page;
  try {
    page = await state.pdfDoc.getPage(n);
  } catch {
    return;
  }
  if (gen !== state.gen) return;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(vpWidth * dpr));
  canvas.height = Math.max(1, Math.floor(vpHeight * dpr));
  canvas.style.width = '100%';
  canvas.style.height = '100%';

  const viewport = page.getViewport({ scale });
  const task = page.render({
    canvasContext: canvas.getContext('2d', { alpha: false }),
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
  });
  state.tasks.set(n, task);
  try {
    await task.promise;
  } catch (err) {
    state.tasks.delete(n);
    if (err && err.name === 'RenderingCancelledException') return;
    console.warn('render failed', n, err);
    return;
  }
  state.tasks.delete(n);
  if (!el.isConnected || gen !== state.gen) return;

  const light = canvasIsLight(canvas);
  state.pageLight.set(n, light);
  if (state.pdfDark === 'smart') el.dataset.invert = light ? '1' : '0';

  el.querySelectorAll('.page-skeleton').forEach((sk) => sk.remove());
  el.querySelectorAll('canvas, .textLayer').forEach((x) => x.remove());
  el.prepend(canvas);

  const textLayerDiv = document.createElement('div');
  textLayerDiv.className = 'textLayer';
  el.append(textLayerDiv);
  try {
    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: await page.getTextContent(),
      container: textLayerDiv,
      viewport,
    });
    await textLayer.render();
  } catch (err) {
    console.warn('text layer failed', n, err);
  }
  el.dataset.rendered = '1';
  state.rendered.add(n);
  renderPageAnnotations(n);
  pruneRendered();
}

function pruneRendered() {
  if (state.rendered.size <= 10) return;
  const keep = new Set();
  for (let d = -2; d <= 2; d++) keep.add(state.currentPage + d);
  const list = [...state.rendered].filter((n) => !keep.has(n));
  list.sort((a, b) => Math.abs(b - state.currentPage) - Math.abs(a - state.currentPage));
  for (const n of list) {
    if (state.rendered.size <= 10) break;
    const el = state.pageEls[n - 1];
    if (el) clearPage(el);
  }
}

/* ================================================================
   navigation
   ================================================================ */
function pageFromScroll() {
  const y = els.reader.scrollTop + 80;
  const tops = state.pageTops;
  if (!tops.length) return 1;
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function updatePageInfo() {
  const n = state.currentPage;
  els.pageInput.value = n;
  $$('.thumb.active').forEach((t) => t.classList.remove('active'));
  const th = $(`.thumb[data-page="${n}"]`);
  if (th) th.classList.add('active');
  $$('.toc-item.active').forEach((t) => t.classList.remove('active'));
  const toc = $(`.toc-item[data-page="${n}"]`);
  if (toc) toc.classList.add('active');
}

function scrollToPage(n, smooth = true) {
  if (!state.numPages) return;
  n = clamp(Math.round(n), 1, state.numPages);
  const el = state.pageEls[n - 1];
  if (!el) return;
  els.reader.scrollTo({ top: Math.max(0, el.offsetTop - 24), behavior: smooth ? 'smooth' : 'auto' });
  state.currentPage = n;
  updatePageInfo();
  persistSoon();
}

/* ================================================================
   TOC + thumbnails
   ================================================================ */
async function buildToc() {
  const panel = $('#panel-toc');
  panel.innerHTML = '';
  let outline = null;
  try {
    outline = await state.pdfDoc.getOutline();
  } catch {}
  if (!outline || !outline.length) {
    panel.innerHTML = tr('<div class="panel-empty">这份文档没有目录</div>');
    return;
  }
  const frag = document.createDocumentFragment();
  const walk = async (items, depth) => {
    for (const item of items) {
      let pageNo = 0;
      try {
        let dest = item.dest;
        if (typeof dest === 'string') dest = await state.pdfDoc.getDestination(dest);
        if (dest && dest[0] != null) {
          const ref = dest[0];
          pageNo = typeof ref === 'number' ? ref + 1 : (await state.pdfDoc.getPageIndex(ref)) + 1;
        }
      } catch {}
      const b = document.createElement('button');
      b.className = 'toc-item';
      b.dataset.page = pageNo || '';
      b.style.paddingLeft = 10 + depth * 13 + 'px';
      b.innerHTML = `<span class="toc-page">${pageNo || ''}</span>${esc(item.title || '')}`;
      if (pageNo) b.onclick = () => scrollToPage(pageNo);
      frag.append(b);
      if (item.items && item.items.length) await walk(item.items, depth + 1);
    }
  };
  await walk(outline, 0);
  panel.append(frag);
}

let thumbObserver = null;
function ensureThumbPanel(force) {
  const panel = $('#panel-pages');
  if (panel.dataset.built === '1' && !force) return;
  panel.dataset.built = '1';
  panel.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'thumb-grid';
  for (let i = 1; i <= state.numPages; i++) {
    const b = document.createElement('button');
    b.className = 'thumb';
    b.dataset.page = i;
    b.innerHTML = '<div class="thumb-ph"></div><span class="thumb-no">' + i + '</span>';
    b.onclick = () => scrollToPage(i);
    grid.append(b);
  }
  panel.append(grid);

  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const b = e.target;
        thumbObserver.unobserve(b);
        renderThumbInto(b, Number(b.dataset.page));
      }
    },
    { root: panel, rootMargin: '200px' },
  );
  [...grid.children].forEach((c) => thumbObserver.observe(c));
}

async function renderThumbInto(btn, n) {
  try {
    const page = await state.pdfDoc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 118 / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width * 1.5);
    canvas.height = Math.floor(vp.height * 1.5);
    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport: vp,
      transform: [1.5, 0, 0, 1.5, 0, 0],
    }).promise;
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    const ph = btn.querySelector('.thumb-ph');
    if (ph) ph.replaceWith(canvas);
  } catch {}
}

/* ================================================================
   annotations
   ================================================================ */
const pageBox = (n) => state.pageEls[n - 1];

function renderAllAnnotations() {
  for (let i = 1; i <= state.numPages; i++) renderPageAnnotations(i);
}

function renderPageAnnotations(n) {
  const el = pageBox(n);
  if (!el) return;
  const layer = el.querySelector('.anno-layer');
  if (!layer) return;
  layer.innerHTML = '';
  for (const a of state.annotations.filter((x) => x.page === n)) {
    a.rects.forEach((r) => {
      const d = document.createElement('div');
      d.className = 'anno';
      d.dataset.type = a.type === 'underline' ? 'underline' : 'highlight';
      d.dataset.color = a.color || 'amber';
      d.dataset.id = a.id;
      d.style.left = r.x * 100 + '%';
      d.style.top = r.y * 100 + '%';
      d.style.width = r.w * 100 + '%';
      d.style.height = r.h * 100 + '%';
      layer.append(d);
    });
    if (a.note || a.type === 'note') {
      const first = a.rects[0];
      if (first) {
        const badge = document.createElement('button');
        badge.className = 'anno-badge';
        badge.dataset.id = a.id;
        badge.title = a.note ? a.note.slice(0, 120) : tr('笔记');
        badge.style.left = first.x * 100 + '%';
        badge.style.top = first.y * 100 + '%';
        badge.onclick = (ev) => {
          ev.stopPropagation();
          openAnnoMenu(a.id, ev.clientX, ev.clientY);
        };
        layer.append(badge);
      }
    }
  }
}

function normalizeRects(rects, pageEl) {
  const pb = pageEl.getBoundingClientRect();
  return rects
    .map((r) => ({
      x: (r.left - pb.left) / pb.width,
      y: (r.top - pb.top) / pb.height,
      w: r.width / pb.width,
      h: r.height / pb.height,
    }))
    .filter((r) => r.w > 0 && r.h > 0 && r.y > -0.15 && r.y < 1.15)
    .map((r) => {
      const y = clamp(r.y, 0, 1);
      return { x: clamp(r.x, 0, 1), y, w: clamp(r.w, 0, 1), h: Math.min(r.h, 1 - y) };
    });
}

function captureSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const text = sel.toString().replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const range = sel.getRangeAt(0);
  if (!els.pages.contains(range.commonAncestorContainer)) return null;

  const groups = new Map();
  for (const r of range.getClientRects()) {
    if (r.width < 0.6 || r.height < 0.6) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) continue;
    const hit = document.elementFromPoint(cx, cy);
    const pageEl = hit && hit.closest ? hit.closest('.page') : null;
    if (!pageEl) continue;
    const n = Number(pageEl.dataset.page);
    if (!groups.has(n)) groups.set(n, []);
    groups.get(n).push(r);
  }
  if (!groups.size) return null;

  const sorted = [...groups.entries()].sort((a, b) => a[1][0].top - b[1][0].top);
  const [page, rects] = sorted[0];
  return {
    text,
    page,
    rects: normalizeRects(rects, pageBox(page)),
    anchor: rects[0],
    all: sorted.map(([p, rs]) => ({ page: p, rects: normalizeRects(rs, pageBox(p)) })),
  };
}

function showSelectionBar(sel) {
  const bar = els.selToolbar;
  bar.hidden = false;
  const r = sel.anchor;
  const bw = bar.offsetWidth || 260;
  const bh = bar.offsetHeight || 40;
  let left = r.left + r.width / 2 - bw / 2;
  let top = r.top - bh - 8;
  if (top < 8) top = r.bottom + 8;
  left = clamp(left, 8, window.innerWidth - bw - 8);
  top = clamp(top, 8, window.innerHeight - bh - 8);
  bar.style.left = left + 'px';
  bar.style.top = top + 'px';
}

function hideSelectionBar() {
  els.selToolbar.hidden = true;
  state.selection = null;
}

function addAnnotations(list) {
  if (!list.length) return;
  state.annotations.push(...list);
  list.forEach((a) => renderPageAnnotations(a.page));
  renderNotesList();
  persistSoon();
  toast(list.length > 1 ? tr`已添加 ${list.length} 处批注` : tr('已添加批注'));
}

function makeAnnotation(sel, type, color, note = '') {
  return sel.all.map((g) => ({
    id: uid(),
    page: g.page,
    type,
    color: color || state.pendingColor,
    rects: g.rects,
    text: sel.text.slice(0, 1200),
    note,
    createdAt: Date.now(),
  }));
}

function renderNotesList() {
  const panel = $('#panel-notes');
  const items = [...state.annotations].sort((a, b) => a.page - b.page || a.rects[0].y - b.rects[0].y);
  els.noteCount.textContent = items.length;
  els.noteCount.classList.toggle('show', items.length > 0);
  if (!items.length) {
    panel.innerHTML = tr('<div class="panel-empty">还没有批注。选中文字即可高亮或记笔记。</div>');
    return;
  }
  panel.innerHTML = '';
  for (const a of items) {
    const card = document.createElement('div');
    card.className = 'note-card';
    card.style.setProperty('--dot', COLOR_VAR[a.color] || 'var(--hl-amber)');
    card.innerHTML = tr`
      <div class="note-quote">${esc(a.text.slice(0, 240))}</div>
      ${a.note ? `<div class="note-note">${esc(a.note)}</div>` : ''}
      <div class="note-meta"><span>第 ${a.page} 页</span><span>·</span><span>${
        a.type === 'underline' ? tr('下划线') : a.type === 'note' ? tr('笔记') : tr('高亮')
      }</span></div>`;
    card.onclick = () => {
      scrollToPage(a.page);
      setTimeout(() => flashAnnotation(a.id), 320);
    };
    panel.append(card);
  }
}

function flashAnnotation(id) {
  $$(`.anno[data-id="${id}"]`).forEach((el) => {
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  });
}

function openAnnoMenu(id, x, y) {
  if (!state.annotations.some((a) => a.id === id)) return;
  const menu = els.annoMenu;
  menu.hidden = false;
  menu.dataset.id = id;
  const r = menu.getBoundingClientRect();
  menu.style.left = clamp(x - 10, 8, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = clamp(y + 8, 8, window.innerHeight - r.height - 8) + 'px';
}

function closeAnnoMenu() {
  els.annoMenu.hidden = true;
}

function deleteAnnotation(id) {
  const a = state.annotations.find((x) => x.id === id);
  state.annotations = state.annotations.filter((x) => x.id !== id);
  if (a) renderPageAnnotations(a.page);
  renderNotesList();
  persistSoon();
}

/* -------- note editor -------- */
let notePop = null;
function openNoteEditor(annotationId, initial, anchorRect) {
  closeNoteEditor();
  const pop = document.createElement('div');
  pop.className = 'note-pop';
  pop.innerHTML = tr`
    <div class="note-pop-head">笔记</div>
    <textarea placeholder="写点什么…"></textarea>
    <div class="note-pop-foot">
      <button class="btn-ghost" data-act="cancel">取消</button>
      <button class="btn-accent" data-act="save">保存</button>
    </div>`;
  document.body.append(pop);
  notePop = pop;
  const ta = pop.querySelector('textarea');
  ta.value = initial || '';
  const r = anchorRect || {
    left: window.innerWidth / 2 - 130,
    top: window.innerHeight / 2 - 90,
    bottom: window.innerHeight / 2,
  };
  const rect = pop.getBoundingClientRect();
  let left = clamp(r.left, 10, window.innerWidth - rect.width - 10);
  let top = (r.bottom || r.top) + 8;
  if (top + rect.height > window.innerHeight - 10) top = Math.max(10, r.top - rect.height - 8);
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  const close = () => closeNoteEditor();
  pop.querySelector('[data-act="cancel"]').onclick = () => {
    const a = state.annotations.find((x) => x.id === annotationId);
    if (a && a.type === 'note' && !a.note) {
      deleteAnnotation(a.id);
    }
    close();
  };
  pop.querySelector('[data-act="save"]').onclick = () => {
    const a = state.annotations.find((x) => x.id === annotationId);
    if (a) {
      a.note = ta.value.trim();
      renderPageAnnotations(a.page);
      renderNotesList();
      persistSoon();
    }
    close();
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') pop.querySelector('[data-act="save"]').click();
  });
}
function closeNoteEditor() {
  if (notePop) notePop.remove();
  notePop = null;
}

/* ================================================================
   page organizer
   ================================================================ */
function blankSize() {
  const g = state.pageGeos[1];
  return g ? { w: g.w, h: g.h } : { w: 595, h: 842 };
}

function openOrganizer() {
  if (!state.pdfDoc) return toast(tr('先打开一个 PDF'));
  state.orgOpen = true;
  state.orgPlan = [];
  for (let i = 0; i < state.numPages; i++) state.orgPlan.push({ kind: 'orig', index: i });
  els.organizeSheet.hidden = false;
  renderOrganizer();
}

function closeOrganizer(silent) {
  if (!state.orgOpen) return;
  state.orgOpen = false;
  els.organizeSheet.hidden = true;
  if (!silent) renderAllAnnotations();
}

const livePlan = () => state.orgPlan.filter((p) => !p.deleted);

function renderOrganizer() {
  const grid = els.orgGrid;
  grid.innerHTML = '';
  const plan = state.orgPlan;
  els.orgSub.textContent = tr`共 ${state.numPages} 页 · 保留 ${livePlan().length} 页`;

  plan.forEach((item, i) => {
    const card = document.createElement('div');
    card.className = 'org-card' + (item.deleted ? ' is-deleted' : '');
    card.dataset.i = i;

    const host = document.createElement('div');
    host.className = 'org-canvas';
    host.innerHTML = '<div class="thumb-ph" style="width:100%;aspect-ratio:1/1.36"></div>';
    card.append(host);

    const bar = document.createElement('div');
    bar.className = 'org-bar';
    bar.innerHTML = tr`<span class="org-no">${item.kind === 'blank' ? tr('空白页') : ''}</span>
      <span class="org-acts">
        <button data-act="before" title="在此页前插入空白页"><svg><use href="#i-plus"/></svg></button>
        <button data-act="after" title="在此页后插入空白页"><svg><use href="#i-pagesplus"/></svg></button>
        <button data-act="${item.deleted ? 'restore' : 'delete'}" class="${item.deleted ? '' : 'danger'}" title="${
          item.deleted ? tr('恢复') : tr('删除')
        }"><svg><use href="${item.deleted ? '#i-rotate' : '#i-trash'}"/></svg></button>
      </span>`;
    card.append(bar);

    const addBlank = (at) => {
      const b = blankSize();
      plan.splice(at, 0, { kind: 'blank', w: b.w, h: b.h });
      renderOrganizer();
    };
    bar.querySelector('[data-act="before"]').onclick = (e) => {
      e.stopPropagation();
      addBlank(i);
    };
    bar.querySelector('[data-act="after"]').onclick = (e) => {
      e.stopPropagation();
      addBlank(i + 1);
    };
    const delBtn = bar.querySelector('[data-act="delete"]');
    if (delBtn)
      delBtn.onclick = (e) => {
        e.stopPropagation();
        item.deleted = true;
        renderOrganizer();
      };
    const resBtn = bar.querySelector('[data-act="restore"]');
    if (resBtn)
      resBtn.onclick = (e) => {
        e.stopPropagation();
        item.deleted = false;
        renderOrganizer();
      };

    grid.append(card);
  });

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        drawOrgThumb(e.target, state.orgPlan[Number(e.target.dataset.i)]);
      }
    },
    { root: els.organizeSheet.querySelector('.sheet-body'), rootMargin: '300px' },
  );
  $$('.org-card', grid).forEach((c) => io.observe(c));
}

async function drawOrgThumb(card, item) {
  if (!item) return;
  const host = card.querySelector('.org-canvas');
  if (!host) return;
  try {
    if (item.kind === 'blank') {
      host.innerHTML = '';
      host.style.background = 'var(--surface-3)';
      card.querySelector('.org-no').textContent = tr('空白页');
      return;
    }
    const page = item.kind === 'orig' ? await state.pdfDoc.getPage(item.index + 1) : await item.doc.getPage(item.index + 1);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 150 / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width * 1.4);
    canvas.height = Math.floor(vp.height * 1.4);
    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport: vp,
      transform: [1.4, 0, 0, 1.4, 0, 0],
    }).promise;
    host.innerHTML = '';
    host.style.background = '#fff';
    host.append(canvas);
    card.querySelector('.org-no').textContent =
      item.kind === 'ext' ? tr`外来页 ${item.index + 1}` : tr`第 ${item.index + 1} 页`;
  } catch {}
}

async function orgInsertPdf() {
  const file = await new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,.pdf';
    input.onchange = () => resolve(input.files && input.files[0]);
    input.click();
  });
  if (!file) return;
  try {
    const doc = await PDFLib.PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
    const count = doc.getPageCount();
    for (let i = 0; i < count; i++) state.orgPlan.push({ kind: 'ext', doc, index: i });
    renderOrganizer();
    toast(tr`已加入 ${count} 页`);
  } catch (err) {
    toast(tr('读取失败：') + err.message);
  }
}

async function orgSave(asNew) {
  if (!state.orgPlan.length) return;
  const btn = $('#btnOrgSave');
  btn.disabled = true;
  try {
    const out = await PDFLib.PDFDocument.create();
    const plan = livePlan();
    if (!plan.length) throw new Error(tr('至少保留一页'));

    const origItems = plan.filter((p) => p.kind === 'orig');
    const src = await PDFLib.PDFDocument.load(state.pdfBytes.slice(0), { ignoreEncryption: true });
    const origPages = origItems.length ? await out.copyPages(src, origItems.map((p) => p.index)) : [];
    const origMap = new Map(origItems.map((p, k) => [p, origPages[k]]));

    const extDocs = [...new Set(plan.filter((p) => p.kind === 'ext').map((p) => p.doc))];
    const extMap = new Map();
    for (const doc of extDocs) {
      const list = plan.filter((p) => p.kind === 'ext' && p.doc === doc);
      const pages = await out.copyPages(doc, list.map((p) => p.index));
      list.forEach((p, k) => extMap.set(p, pages[k]));
    }

    const pageMap = new Map();
    for (const item of plan) {
      if (item.kind === 'blank') {
        out.addPage([item.w || 595, item.h || 842]);
      } else {
        out.addPage(item.kind === 'orig' ? origMap.get(item) : extMap.get(item));
      }
      pageMap.set(item, out.getPageCount());
    }

    const remap = new Map();
    for (const item of plan) {
      if (item.kind === 'orig') remap.set(item.index + 1, pageMap.get(item));
    }
    state.annotations = state.annotations
      .map((a) => ({ ...a, page: remap.get(a.page) }))
      .filter((a) => a.page > 0);

    const bytes = new Uint8Array(await out.save());
    await writeBytes(bytes, asNew);

    const now = Date.now();
    const nextKey = fingerprint(state.fileName, bytes.length, now);
    await saveDoc(nextKey, {
      annotations: state.annotations,
      chats: state.chats,
      activeChatId: state.activeChatId,
      lastPage: state.currentPage,
      name: state.fileName,
      savedAt: now,
    });

    closeOrganizer(true);
    await loadBytes(bytes, state.fileName, { handle: state.fileHandle, mtime: now, size: bytes.length });
    toast(tr('页面已保存'));
  } catch (err) {
    console.error(err);
    if (err && err.name === 'AbortError') toast(tr('已取消'));
    else toast(tr('保存失败：') + err.message);
  } finally {
    btn.disabled = false;
  }
}

async function writeBytes(bytes, asNew) {
  if (!asNew && state.fileHandle && state.fileHandle.createWritable) {
    const w = await state.fileHandle.createWritable();
    await w.write(bytes);
    await w.close();
    return;
  }
  if (window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({
      suggestedName: state.fileName + '.pdf',
      types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
    });
    const w = await handle.createWritable();
    await w.write(bytes);
    await w.close();
    state.fileHandle = handle;
    return;
  }
  download(bytes, state.fileName + '.pdf');
}

function download(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name || 'document.pdf';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ================================================================
   persistence
   ================================================================ */
let persistTimer = 0;
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 400);
}
async function persist() {
  if (!state.pdfDoc || !state.docKey) return;
  await saveDoc(state.docKey, {
    annotations: state.annotations,
    chats: state.chats,
    activeChatId: state.activeChatId,
    lastPage: state.currentPage,
    name: state.fileName,
    savedAt: Date.now(),
  });
}

/* ================================================================
   settings
   ================================================================ */
let config = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  hasKey: false,
  keyHint: '',
  hints: {},
  compat: false,
};

/** 每个服务商的 key 分开保存，切换时显示对应的“已保存”提示 */
function updateKeyPlaceholder() {
  const active = $('#providerSeg button.active');
  const p = active ? active.dataset.provider : config.provider;
  const hint = (config.hints && config.hints[p]) || '';
  $('#cfgKey').placeholder = hint ? tr`已保存 ${hint}` : 'sk-…';
}

const PRESETS = {
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  custom: { baseUrl: '', model: '' },
};

const MODEL_PRESETS = {
  deepseek: [
    { id: 'deepseek-flash', label: 'V4.1 Flash', hint: '日常阅读，快且便宜' },
    { id: 'deepseek-v4-pro', label: 'V4 Pro', hint: '更难的推理' },
  ],
  openai: [
    { id: 'gpt-4o-mini', label: 'GPT-4o mini', hint: '轻量' },
    { id: 'gpt-4o', label: 'GPT-4o', hint: '通用' },
  ],
  custom: [],
};

function renderModelChips(provider) {
  if (state.fetchedModels && state.fetchedModels.length) {
    renderModelList(state.fetchedModels);
    return;
  }
  const box = $('#modelChips');
  box.classList.remove('scroll');
  const list = MODEL_PRESETS[provider] || [];
  box.innerHTML = '';
  if (!list.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const current = $('#cfgModel').value.trim();
  for (const m of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (current === m.id ? ' active' : '');
    b.textContent = m.label;
    b.title = m.hint ? `${m.id} — ${tr(m.hint)}` : m.id;
    b.onclick = () => {
      $('#cfgModel').value = m.id;
      renderModelChips(provider);
    };
    box.append(b);
  }
}

/** 接口返回的模型列表：聊天类排前面，最多显示 80 个，可滚动 */
function renderModelList(models) {
  const box = $('#modelChips');
  box.hidden = false;
  box.classList.add('scroll');
  box.innerHTML = '';
  const pref = /gpt|^o[1-9]|chat|claude|deepseek|qwen|llama|glm|kimi|mistral|gemini|sonnet|opus|haiku/i;
  const sorted = [...models].sort((a, b) => {
    const pa = pref.test(a) ? 0 : 1;
    const pb = pref.test(b) ? 0 : 1;
    return pa - pb || a.localeCompare(b);
  });
  const current = $('#cfgModel').value.trim();
  for (const m of sorted.slice(0, 80)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (current === m ? ' active' : '');
    b.textContent = m;
    b.title = m;
    b.onclick = () => {
      $('#cfgModel').value = m;
      renderModelList(models);
    };
    box.append(b);
  }
  if (sorted.length > 80) {
    const more = document.createElement('span');
    more.className = 'chips-more';
    more.textContent = tr`还有 ${sorted.length - 80} 个，直接输入名字也可以`;
    box.append(more);
  }
}

function renderThemeGrid() {
  const grid = $('#themeGrid');
  const activeId = document.documentElement.dataset.theme;
  grid.innerHTML = '';
  for (const t of THEMES) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'theme-card' + (t.id === activeId ? ' active' : '');
    card.dataset.theme = t.id;
    card.innerHTML = `
      <div class="theme-preview" style="background:${t.bg}">
        <span class="dot" style="background:${t.accent}"></span>
        <span class="line" style="background:${t.accent}"></span>
        <span class="line short" style="background:${t.panel};border:1px solid rgba(0,0,0,.12)"></span>
      </div>
      <div class="theme-name"><span>${tr(t.name)}</span><span class="tick">✓</span></div>`;
    card.onclick = () => applyTheme(t.id);
    grid.append(card);
  }
}

async function loadConfig() {
  try {
    const r = await fetch('/api/config');
    config = { ...config, ...(await r.json()) };
  } catch {}
  updateChatMeta();
}

function updateChatMeta() {
  const parts = [config.provider, config.model];
  if (!config.hasKey) parts.push(tr('未配置 Key'));
  parts.push(tr('思考') + (getLocale() === 'en' ? ': ' : '') + tr(EFFORT_LABEL[state.effort] || '高'));
  els.chatMeta.textContent = parts.filter(Boolean).join(' · ');
}

function showSettingsView(name) {
  state.settingsView = name;
  const views = { settings: 'viewSettings', shortcuts: 'viewShortcuts', guide: 'viewGuide' };
  for (const [key, id] of Object.entries(views)) {
    const el = document.getElementById(id);
    if (el) el.hidden = key !== name;
  }
  $('#modalTitle').textContent = name === 'settings' ? tr('设置') : name === 'shortcuts' ? tr('快捷键') : tr('使用说明');
  $('#btnViewBack').hidden = name === 'settings';
  $('#modalFoot').hidden = name !== 'settings';
  const card = $('.modal-card', els.settingsModal);
  if (card) card.scrollTop = 0;
}

function openSettings() {
  state.fetchedModels = null;
  showSettingsView('settings');
  $('#cfgBaseUrl').value = config.baseUrl || '';
  $('#cfgModel').value = config.model || '';
  $('#cfgKey').value = '';
  $('#cfgCompat').checked = !!config.compat;
  const t = $('#testResult');
  t.textContent = '';
  t.className = 'test-result';
  $$('#providerSeg button').forEach((b) => b.classList.toggle('active', b.dataset.provider === config.provider));
  updateKeyPlaceholder();
  $$('#pdfDarkSeg button').forEach((b) => b.classList.toggle('active', b.dataset.pdfdark === state.pdfDark));
  renderModelChips(config.provider);
  renderThemeGrid();
  els.settingsModal.hidden = false;
}

async function saveSettings() {
  const provider = $('#providerSeg button.active')?.dataset.provider || 'deepseek';
  const body = {
    provider,
    baseUrl: $('#cfgBaseUrl').value.trim(),
    model: $('#cfgModel').value.trim(),
    apiKey: $('#cfgKey').value.trim(),
    compat: $('#cfgCompat').checked,
  };
  try {
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': getLocale() },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    config = { ...config, ...body, hasKey: j.hasKey, keyHint: j.keyHint };
    config.hints = { ...(config.hints || {}), [provider]: j.keyHint };
    els.settingsModal.hidden = true;
    updateChatMeta();
    toast(tr('设置已保存'));
  } catch (err) {
    toast(tr('保存失败：') + err.message);
  }
}

/* ================================================================
   chat
   ================================================================ */
const SYS = (docName, context, page, partialNote) => tr`你是「纸间」的阅读助手，帮助读者理解手头这一份 PDF。

规则：
1. 只依据下面提供的文档内容回答。文档里没有的信息，直接说「文档里没有提到」，不要编造，也不要用外部知识补充（除非用户明确要求）。
2. 引用原文时，在句末用 [p.页码] 标注来源，例如 [p.12]。页码必须是文档里标注的真实页码。
3. 回答用中文，简洁、直接、有结构。需要时用短列表，不要堆砌套话。
4. 如果用户的问题含糊，先给出最可能的解释并回答，再补一句你如何理解。

文档名：《${docName}》

=== 文档内容开始 ===
${context}
=== 文档内容结束 ===

当前阅读页：第 ${page} 页
${partialNote}`;

/* 各模型的安全字数上限（按 ≈0.7 token/字 估算，留了余量） */
function ctxBudget() {
  const m = (config.model || '').toLowerCase();
  if (config.provider === 'deepseek') return /pro/.test(m) ? 600000 : 900000;
  if (/gpt-5/.test(m)) return 400000;
  if (/gpt-4\.1/.test(m)) return 300000;
  if (/gpt-4o/.test(m)) return 180000;
  if (/^o\d/.test(m)) return 260000;
  return 200000;
}

function tokenize(s) {
  const out = [];
  const lower = String(s).toLowerCase();
  const words = lower.match(/[a-z0-9_]{2,}/g);
  if (words) out.push(...words);
  const cjk = lower.match(/[\u4e00-\u9fff]/g);
  if (cjk) for (let i = 0; i < cjk.length - 1; i++) out.push(cjk[i] + cjk[i + 1]);
  return out;
}

async function ensureDocText() {
  if (!state.pdfDoc) return;
  const missing = [];
  for (let i = 1; i <= state.numPages; i++) if (!state.textCache.has(i)) missing.push(i);
  if (!missing.length) return;
  if (missing.length > 30) toast(tr`正在读取 ${missing.length} 页文字…`, 1500);
  for (const n of missing) {
    if (state.textCache.has(n)) continue;
    try {
      const page = await state.pdfDoc.getPage(n);
      const tc = await page.getTextContent();
      let text = '';
      for (const item of tc.items) {
        if (item.type) continue;
        text += item.str + (item.hasEOL ? '\n' : '');
      }
      state.textCache.set(n, text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
    } catch {
      state.textCache.set(n, '');
    }
  }
}

function humanChars(n) {
  if (getLocale() === 'en') return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n) + ' characters';
  if (!n) return tr('0 字');
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + tr(' 万字');
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + tr(' 千字');
  return n + tr(' 字');
}

function humanTokens(n) {
  if (getLocale() === 'en') return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + tr(' 万');
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function docTotalChars() {
  let n = 0;
  for (const t of state.textCache.values()) n += t.length;
  return n;
}

function updateScopeInfo() {
  const el = $('#scopeInfo');
  if (!el) return;
  if (!state.textCache.size) {
    el.textContent = '';
    el.classList.remove('over');
    return;
  }
  const n = docTotalChars();
  const tokens = Math.round(n * 0.7);
  const over = n > ctxBudget();
  el.textContent = `${humanChars(n)} · ≈${humanTokens(tokens)} token`;
  el.title = over
    ? tr`全文约 ${n} 字（≈${tokens} token），超出当前模型 ${humanChars(ctxBudget())} 的安全上限；选「全文」会自动降级为相关页。`
    : tr`全文约 ${n} 字，估算 ${tokens} token，在 ${config.model} 的上下文之内。`;
  el.classList.toggle('over', over);
}

/** 按范围组装上下文，并如实报告这次给了模型什么 */
function buildContext(question, scope) {
  const pages = [...state.textCache.entries()].sort((a, b) => a[0] - b[0]);
  const total = pages.reduce((n, [, t]) => n + t.length, 0);
  const cur = state.currentPage;
  const fmt = (list) =>
    list.map(([p, t]) => tr`【第 ${p} 页】\n${t || tr('（此页没有可提取的文字，可能是扫描图片）')}`).join('\n\n');
  const sum = (list) => list.reduce((n, [, t]) => n + t.length, 0);
  const base = { total, totalPages: pages.length };

  if (scope === 'page') {
    const pick = pages.filter(([p]) => Math.abs(p - cur) <= 1);
    return { ...base, text: fmt(pick), mode: 'page', pageNumbers: pick.map(([p]) => p), pages: pick.length, chars: sum(pick) };
  }

  if (scope === 'full' && total <= ctxBudget()) {
    return { ...base, text: fmt(pages), mode: 'full', pageNumbers: pages.map(([p]) => p), pages: pages.length, chars: total };
  }

  const degraded = scope === 'full';
  const qSet = new Set(tokenize(question));
  const scored = pages.map(([p, t]) => {
    const toks = tokenize(t);
    let hit = 0;
    const seen = new Set();
    for (const tk of toks) {
      if (qSet.has(tk) && !seen.has(tk)) {
        seen.add(tk);
        hit += 1;
      }
    }
    const bonus = p === cur ? 3 : Math.abs(p - cur) <= 1 ? 1 : 0;
    return { p, score: hit / (1 + Math.log10(1 + t.length / 400)) + bonus };
  });
  scored.sort((a, b) => b.score - a.score);
  const pick = new Set([cur, cur - 1, cur + 1]);
  for (const s of scored) {
    if (pick.size >= 14) break;
    pick.add(s.p);
  }
  const list = [...pick].filter((p) => state.textCache.has(p)).sort((a, b) => a - b);
  return {
    ...base,
    text: fmt(list.map((p) => [p, state.textCache.get(p)])),
    mode: degraded ? 'degraded' : 'smart',
    pageNumbers: list,
    pages: list.length,
    chars: sum(list.map((p) => [p, state.textCache.get(p)])),
  };
}

function ctxNoteText(ctx) {
  if (ctx.mode === 'full') return tr`已附上全文 · ${ctx.pages} 页 · ${humanChars(ctx.chars)}`;
  if (ctx.mode === 'page') return tr`已附上第 ${ctx.pageNumbers?.join(', ') || state.currentPage} 页`;
  if (ctx.mode === 'degraded')
    return tr`全文 ${humanChars(ctx.total)} 超出 ${config.model} 的上下文上限，已改用相关 ${ctx.pages} 页 · ${humanChars(ctx.chars)}`;
  return tr`已附上相关 ${ctx.pages} / ${ctx.totalPages} 页 · ${humanChars(ctx.chars)}（全文 ${humanChars(ctx.total)}）`;
}

const chatScrollToEnd = () => {
  els.chatScroll.scrollTop = els.chatScroll.scrollHeight;
};

/* ---------------- 多个对话 ---------------- */
function newChatObj() {
  return { id: uid(), title: '', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
}

function activeChat() {
  return state.chats.find((c) => c.id === state.activeChatId) || state.chats[0];
}

function titleOfMessages(messages) {
  const first = messages.find((m) => m.role === 'user');
  return first ? first.content.replace(/\s+/g, ' ').trim().slice(0, 28) : tr('新对话');
}

function relTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return tr`今天 ${hm}`;
  const y = new Date(now.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return tr`昨天 ${hm}`;
  if (now - d < 7 * 86400000) return tr`${Math.floor((now - d) / 86400000)} 天前`;
  return tr`${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

function renderChatList() {
  const list = $('#chatList');
  if (!list) return;
  list.innerHTML = '';
  if (!state.chats.length) {
    list.innerHTML = tr('<div class="ch-empty">还没有对话</div>');
    return;
  }
  const items = [...state.chats].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  for (const c of items) {
    const row = document.createElement('div');
    row.className = 'ch-item' + (c.id === state.activeChatId ? ' active' : '');
    const count = c.messages.filter((m) => m.role === 'user').length;
    row.innerHTML = tr`<div class="ch-main">
        <div class="ch-title">${esc(c.messages.length ? c.title || tr('新对话') : tr('新对话'))}</div>
        <div class="ch-meta">${relTime(c.updatedAt || c.createdAt)}${count ? tr` · ${count} 问` : ''}</div>
      </div>
      <button class="ch-del" title="删除这段对话">×</button>`;
    row.onclick = () => switchChat(c.id);
    row.querySelector('.ch-del').onclick = (e) => {
      e.stopPropagation();
      deleteChat(c.id);
    };
    list.append(row);
  }
}

function createChat() {
  if (state.busy) return toast(tr('等这次回答结束再新建'));
  const c = newChatObj();
  state.chats.unshift(c);
  state.activeChatId = c.id;
  state.chat = c.messages;
  renderChatHistory();
  renderChatList();
  closeHistory();
  persistSoon();
  els.chatText.focus();
}

function switchChat(id) {
  if (state.busy) return toast(tr('等这次回答结束再切换'));
  const c = state.chats.find((x) => x.id === id);
  if (!c) return;
  state.activeChatId = id;
  state.chat = c.messages;
  renderChatHistory();
  renderChatList();
  closeHistory();
  persistSoon();
}

function deleteChat(id) {
  if (state.busy) return toast(tr('等这次回答结束再删除'));
  state.chats = state.chats.filter((c) => c.id !== id);
  if (!state.chats.length) state.chats = [newChatObj()];
  if (!state.chats.some((c) => c.id === state.activeChatId)) {
    state.activeChatId = state.chats[0].id;
    state.chat = state.chats[0].messages;
    renderChatHistory();
  }
  renderChatList();
  persistSoon();
}

function openHistory() {
  renderChatList();
  $('#chatHistory').hidden = false;
}
function closeHistory() {
  $('#chatHistory').hidden = true;
}

function renderChatHistory() {
  $$('.msg', els.chatScroll).forEach((m) => m.remove());
  const intro = $('#chatIntro');
  if (intro) intro.hidden = state.chat.length > 0;
  let lastUserIdx = -1;
  for (let i = state.chat.length - 1; i >= 0; i--) {
    if (state.chat[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  state.chat.forEach((m, i) =>
    appendMessageEl(m.role, m.content, {
      reasoning: m.reasoning,
      ctx: m.ctxData ? ctxNoteText(m.ctxData) : m.ctx,
      index: i,
      isLastUser: i === lastUserIdx,
    }),
  );
  chatScrollToEnd();
}

function appendMessageEl(role, content, opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (role === 'user' ? 'msg-user' : 'msg-ai');
  if (role === 'user') {
    const stack = document.createElement('div');
    stack.className = 'user-stack';
    const b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = content;
    stack.append(b);
    if (opts.index != null) {
      const tools = document.createElement('div');
      tools.className = 'msg-tools user-tools';
      if (opts.isLastUser) {
        const eb = document.createElement('button');
        eb.innerHTML = tr('<svg><use href="#i-edit"/></svg>编辑重问');
        eb.title = tr('删掉这条和它后面的回答，把问题放回输入框');
        eb.onclick = () => editUserMessage(opts.index);
        tools.append(eb);
      }
      const bb = document.createElement('button');
      bb.innerHTML = tr('<svg><use href="#i-branch"/></svg>从这里分支');
      bb.title = tr('保留原对话，另开一条包含前面内容的对话');
      bb.onclick = () => branchFrom(opts.index);
      tools.append(bb);
      stack.append(tools);
    }
    wrap.append(stack);
  } else {
    wrap.innerHTML = '<div class="ai-dot"></div>';
    const body = document.createElement('div');
    body.className = 'ai-body';
    body.innerHTML = (opts.ctx ? `<div class="ctx-note">${esc(opts.ctx)}</div>` : '') + mdToHtml(content);
    if (opts.reasoning) {
      const r = document.createElement('div');
      r.className = 'reasoning';
      r.textContent = opts.reasoning;
      body.prepend(r);
    }
    body.append(makeCopyTools(content));
    wrap.append(body);
  }
  els.chatScroll.append(wrap);
  return wrap;
}

function makeCopyTools(text) {
  const tools = document.createElement('div');
  tools.className = 'msg-tools';
  tools.innerHTML = tr('<button data-act="copy"><svg><use href="#i-copy"/></svg>复制</button>');
  tools.querySelector('[data-act="copy"]').onclick = () =>
    navigator.clipboard.writeText(text).then(() => toast(tr('已复制')));
  return tools;
}

/* 编辑最后一条提问：删掉它和之后的回答，把内容放回输入框 */
function editUserMessage(index) {
  if (state.busy) return toast(tr('等这次回答结束再改'));
  const msg = state.chat[index];
  if (!msg || msg.role !== 'user') return;
  state.chat.splice(index);
  renderChatHistory();
  renderChatList();
  persistSoon();
  els.chatText.value = msg.content;
  els.chatText.dispatchEvent(new Event('input'));
  els.chatText.focus();
  const end = els.chatText.value.length;
  els.chatText.setSelectionRange(end, end);
}

/* 从某条提问处分叉：原对话完整保留，另开一条带着前面内容的对话 */
function branchFrom(index) {
  if (state.busy) return toast(tr('等这次回答结束再分支'));
  const msg = state.chat[index];
  if (!msg) return;
  const prefix = state.chat.slice(0, index).map((m) => ({ ...m }));
  const chat = newChatObj();
  chat.messages = prefix;
  const lastQ = [...prefix].reverse().find((m) => m.role === 'user');
  chat.title = tr('分支 · ') + (lastQ ? lastQ.content.replace(/\s+/g, ' ').trim().slice(0, 18) : tr('新对话'));
  state.chats.unshift(chat);
  state.activeChatId = chat.id;
  state.chat = chat.messages;
  renderChatHistory();
  renderChatList();
  persistSoon();
  toast(tr('已开出新分支，原对话保留'));
  if (msg.role === 'user') {
    els.chatText.value = msg.content;
    els.chatText.dispatchEvent(new Event('input'));
  }
  els.chatText.focus();
}

async function sendChat(displayText, modelText) {
  if (state.busy) return;
  if (!state.pdfDoc) return toast(tr('先打开一个 PDF'));
  if (!config.hasKey) {
    toast(tr('先在设置里填入 API Key'));
    openSettings();
    return;
  }
  const question = modelText || displayText;
  state.busy = true;
  $('#btnChatSend').disabled = true;

  $('#chatIntro').hidden = true;
  appendMessageEl('user', displayText);
  state.chat.push({ role: 'user', content: displayText });
  const chatRec = activeChat();
  if (chatRec) {
    chatRec.updatedAt = Date.now();
    if (!chatRec.title || (chatRec.messages.length === 1 && ['新对话', 'New chat'].includes(chatRec.title))) {
      chatRec.title = displayText.replace(/\s+/g, ' ').trim().slice(0, 28) || tr('新对话');
      renderChatList();
    }
  }

  const aiWrap = appendMessageEl('assistant', '');
  const body = $('.ai-body', aiWrap);
  body.innerHTML = '<span class="typing"></span>';

  await ensureDocText();
  updateScopeInfo();
  const ctx = buildContext(question, state.scope);
  const partialNote =
    ctx.mode === 'full'
      ? ''
      : tr`本次仅提供 ${ctx.pages} 页，全文共 ${ctx.totalPages} 页。已提供的页码：${ctx.pageNumbers.join(', ')}。如果问题不在这些页中，请说明覆盖范围，不要猜测其余内容。`;
  const ctxHtml = `<div class="ctx-note">${esc(ctxNoteText(ctx))}</div>`;
  const messages = [{ role: 'system', content: SYS(state.fileName, ctx.text, state.currentPage, partialNote) }];
  for (const m of state.chat.slice(-8, -1)) {
    if (m.role === 'user' || m.role === 'assistant') messages.push({ role: m.role, content: m.content });
  }
  messages.push({ role: 'user', content: question });

  const controller = new AbortController();
  state.abort = controller;
  $('#btnChatStop').hidden = false;
  let answer = '';
  let reasoning = '';
  let finished = false;

  const paint = () => {
    if (finished) return;
    body.innerHTML = ctxHtml + mdToHtml(answer) + '<span class="typing"></span>';
    if (reasoning) {
      const r = document.createElement('div');
      r.className = 'reasoning';
      r.textContent = reasoning;
      body.prepend(r);
    }
    chatScrollToEnd();
  };

  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': getLocale() },
      body: JSON.stringify({
        messages,
        temperature: 0.25,
        reasoning: state.effort,
        compat: !!config.compat,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${resp.status}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let raf = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let ev;
          try {
            ev = JSON.parse(payload);
          } catch {
            continue;
          }
          if (ev.t) answer += ev.t;
          if (ev.r) reasoning += ev.r;
          if (ev.error) throw new Error(ev.error);
        }
      }
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          paint();
        });
      }
    }
    body.innerHTML = ctxHtml + mdToHtml(answer || tr('（没有返回内容）'));
    finished = true;
    if (raf) cancelAnimationFrame(raf);
    if (reasoning) {
      const r = document.createElement('div');
      r.className = 'reasoning';
      r.textContent = reasoning;
      body.prepend(r);
    }
    body.append(makeCopyTools(answer));
    state.chat.push({ role: 'assistant', content: answer, reasoning: reasoning || undefined, ctx: ctxNoteText(ctx), ctxData: { ...ctx, text: undefined } });
    const rec = activeChat();
    if (rec) rec.updatedAt = Date.now();
    persistSoon();
    renderChatHistory();
  } catch (err) {
    if (err.name === 'AbortError') {
      if (answer) {
        body.innerHTML = ctxHtml + mdToHtml(answer);
        state.chat.push({ role: 'assistant', content: answer, ctx: ctxNoteText(ctx), ctxData: { ...ctx, text: undefined } });
      } else {
        aiWrap.remove();
        state.chat.pop();
      }
    } else {
      body.innerHTML = '';
      const e = document.createElement('div');
      e.className = 'msg-error';
      e.textContent = err.message || tr('请求失败');
      body.append(e);
      state.chat.pop();
    }
  } finally {
    state.busy = false;
    state.abort = null;
    $('#btnChatSend').disabled = false;
    $('#btnChatStop').hidden = true;
    chatScrollToEnd();
  }
}

/* ---------------- chat quote bar ---------------- */
let quoteBar = null;
function setQuote(text, page) {
  if (!quoteBar) {
    quoteBar = document.createElement('div');
    quoteBar.className = 'chat-quote';
    quoteBar.innerHTML = tr('<div class="quote-text"></div><button class="quote-x" title="取消引用">×</button>');
    quoteBar.querySelector('.quote-x').onclick = () => {
      quoteBar.hidden = true;
    };
    els.chatForm.parentNode.insertBefore(quoteBar, els.chatForm);
  }
  quoteBar.hidden = false;
  quoteBar.dataset.page = page || state.currentPage;
  const t = quoteBar.querySelector('.quote-text');
  t.textContent = text.slice(0, 300) + (text.length > 300 ? '…' : '');
  els.chatText.focus();
}

function openChat() {
  document.body.classList.remove('chat-collapsed');
}

function askSelection(text, page) {
  openChat();
  setQuote(text, page);
  els.chatText.placeholder = tr('想问这段的什么？直接回车就解释');
  els.chatText.focus();
}

function sendFromInput() {
  const raw = els.chatText.value.trim();
  const quoting = quoteBar && !quoteBar.hidden;
  const q = quoting ? quoteBar.querySelector('.quote-text').textContent : '';
  if (!raw && !q) return;
  let display = raw;
  let modelText = raw;
  if (q) {
    const page = quoteBar.dataset.page;
    modelText = tr`【用户选中的原文，第 ${page} 页】\n“${q}”\n\n${
      raw || tr('请解释这段话的意思，并说明它在全文中的作用。')
    }`;
    if (!display) display = tr('解释这段内容');
  }
  els.chatText.value = '';
  els.chatText.style.height = 'auto';
  if (quoteBar) quoteBar.hidden = true;
  els.chatText.placeholder = tr('就这份文档提问…');
  sendChat(display, modelText);
}

const QUICK = {
  summary: () =>
    sendChat(tr('概括全文'), tr('请概括这份文档的核心内容：先用 3-5 句话说明它讲什么、给谁看、结论是什么，再列出 5 个要点。')),
  page: () =>
    sendChat(
      tr`总结第 ${state.currentPage} 页`,
      tr`请总结第 ${state.currentPage} 页的内容，提炼出这一页的主要论点和关键细节。`,
    ),
  explain: () => {
    const sel = captureSelection() || state.selection;
    if (!sel) return toast(tr('先在页面上选中一段文字'));
    askSelection(sel.text, sel.page);
  },
  quiz: () =>
    sendChat(
      tr('出 5 道复习题'),
      tr('请基于这份文档出 5 道复习题，覆盖核心概念，题目要有一定难度；先只给题目，最后再附上答案要点。'),
    ),
};

function applyChatWidth(w) {
  const max = Math.min(880, Math.max(320, window.innerWidth - 380));
  const width = clamp(w, 300, max);
  document.documentElement.style.setProperty('--chat-w', width + 'px');
  return width;
}

/* ================================================================
   wiring
   ================================================================ */
function refreshLanguage() {
  refreshStatic();
  $('#languageSeg').setAttribute('aria-label', tr('界面语言'));
  updateChatMeta();
  updateScopeInfo();
  updateKeyPlaceholder();
  applyTheme(document.documentElement.dataset.theme, false);
  $('#btnFetchModels').textContent = tr($('#btnFetchModels').disabled ? '获取中…' : '从接口获取列表');
  renderThemeGrid();
  renderModelChips($('#providerSeg button.active')?.dataset.provider || config.provider);
  $('#modalTitle').textContent = tr(state.settingsView === 'shortcuts' ? '快捷键' : state.settingsView === 'guide' ? '使用说明' : '设置');
  els.chatText.placeholder = tr(quoteBar && !quoteBar.hidden ? '想问这段的什么？直接回车就解释' : '就这份文档提问…');
  if (!state.pdfDoc) els.docTitle.textContent = tr('未打开文档');
  else {
    buildToc();
    renderAllAnnotations();
  }
  renderNotesList();
  renderChatList();
  // Do not replace the live streaming answer or the user's draft input.
  if (!state.busy) renderChatHistory();
  else {
    $$('.user-tools button').forEach((button) => {
      const edit = !!button.querySelector('use[href="#i-edit"]');
      button.lastChild.textContent = tr(edit ? '编辑重问' : '从这里分支');
      button.title = tr(edit ? '删掉这条和它后面的回答，把问题放回输入框' : '保留原对话，另开一条包含前面内容的对话');
    });
    $$('.msg-tools [data-act="copy"]').forEach((button) => { button.lastChild.textContent = tr('复制'); });
  }
  if (!els.organizeSheet.hidden) renderOrganizer();
  if (notePop) {
    $('.note-pop-head', notePop).textContent = tr('笔记');
    $('textarea', notePop).placeholder = tr('写点什么…');
    $('[data-act="cancel"]', notePop).textContent = tr('取消');
    $('[data-act="save"]', notePop).textContent = tr('保存');
  }
  if (quoteBar) $('.quote-x', quoteBar).title = tr('取消引用');
  $$('.cite[data-page]').forEach((cite) => { cite.title = tr`跳到第 ${cite.dataset.page} 页`; });
}

function initUI() {
  window.addEventListener('languagechange', refreshLanguage);
  $('#btnOpen').onclick = pickFile;
  $('#btnPick').onclick = pickFile;
  $('#btnDemo').onclick = loadDemo;
  $('#btnPrevPage').onclick = () => scrollToPage(state.currentPage - 1);
  $('#btnNextPage').onclick = () => scrollToPage(state.currentPage + 1);
  els.pageInput.onchange = () => scrollToPage(Number(els.pageInput.value) || 1);
  els.pageInput.onkeydown = (e) => {
    if (e.key === 'Enter') els.pageInput.blur();
  };
  $('#btnZoomIn').onclick = () => {
    const nxt = ZOOMS.find((z) => z > state.scale + 0.001) || ZOOMS[ZOOMS.length - 1];
    setScale(nxt);
  };
  $('#btnZoomOut').onclick = () => {
    const prev = [...ZOOMS].reverse().find((z) => z < state.scale - 0.001) || ZOOMS[0];
    setScale(prev);
  };
  $('#zoomLabel').onclick = () => setScale(fitScale(), true);
  $('#btnTheme').onclick = toggleMode;
  $('#btnSettings').onclick = openSettings;
  $('#btnOrganize').onclick = openOrganizer;
  $('#btnChatToggle').onclick = () => {
    document.body.classList.toggle('chat-collapsed');
    if (!document.body.classList.contains('chat-collapsed')) els.chatText.focus();
  };
  $('#btnChatClose').onclick = () => document.body.classList.add('chat-collapsed');
  $('#btnNewChat').onclick = createChat;
  $('#btnHistory').onclick = () => {
    const panel = $('#chatHistory');
    if (panel.hidden) openHistory();
    else closeHistory();
  };
  $('#btnHistoryClose').onclick = closeHistory;

  // 拖动聊天面板宽度
  const resizer = $('#chatResizer');
  const savedW = parseInt(localStorage.getItem('zj-chat-w') || '', 10);
  if (savedW) applyChatWidth(savedW);
  let drag = null;
  let lastW = 0;
  resizer.addEventListener('pointerdown', (e) => {
    if (document.body.classList.contains('chat-collapsed')) return;
    drag = { x: e.clientX, w: els.chatPanel.getBoundingClientRect().width };
    lastW = drag.w;
    resizer.classList.add('dragging');
    document.body.classList.add('resizing');
    try {
      resizer.setPointerCapture(e.pointerId);
    } catch {}
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  resizer.addEventListener('pointermove', (e) => {
    if (!drag) return;
    lastW = applyChatWidth(drag.w - (e.clientX - drag.x));
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    resizer.classList.remove('dragging');
    document.body.style.userSelect = '';
    const w = Math.round(lastW || els.chatPanel.getBoundingClientRect().width);
    localStorage.setItem('zj-chat-w', String(w));
    // 等布局稳定后再重新适应宽度，期间保持关闭过渡动画，避免量到动画中间值
    setTimeout(() => {
      if (state.pdfDoc && state.fit) setScale(fitScale(), true);
      document.body.classList.remove('resizing');
    }, 70);
  };
  resizer.addEventListener('pointerup', endDrag);
  resizer.addEventListener('pointercancel', endDrag);
  resizer.addEventListener('dblclick', () => {
    document.documentElement.style.removeProperty('--chat-w');
    localStorage.removeItem('zj-chat-w');
    if (state.pdfDoc && state.fit) setTimeout(() => setScale(fitScale(), true), 60);
  });

  $$('.side-tab').forEach((tab) => {
    tab.onclick = () => {
      $$('.side-tab').forEach((t) => t.classList.remove('active'));
      $$('.panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $('#panel-' + tab.dataset.panel).classList.add('active');
      if (tab.dataset.panel === 'pages') ensureThumbPanel();
    };
  });

  els.selToolbar.addEventListener('mousedown', (e) => e.preventDefault());
  $$('#swatches .swatch').forEach((sw) => {
    sw.onclick = () => {
      state.pendingColor = sw.dataset.color;
      $$('#swatches .swatch').forEach((s) => (s.style.outline = ''));
      sw.style.outline = '2px solid var(--ink-2)';
      sw.style.outlineOffset = '2px';
      if (state.selection) {
        addAnnotations(makeAnnotation(state.selection, 'highlight', sw.dataset.color));
        hideSelectionBar();
        window.getSelection()?.removeAllRanges();
      }
    };
  });

  $$('#selToolbar > button[data-act]').forEach((btn) => {
    btn.onclick = () => {
      const sel = state.selection;
      if (!sel) return;
      const act = btn.dataset.act;
      if (act === 'highlight') {
        addAnnotations(makeAnnotation(sel, 'highlight', state.pendingColor));
        hideSelectionBar();
        window.getSelection()?.removeAllRanges();
      } else if (act === 'underline') {
        addAnnotations(makeAnnotation(sel, 'underline', state.pendingColor));
        hideSelectionBar();
        window.getSelection()?.removeAllRanges();
      } else if (act === 'note') {
        const [a] = makeAnnotation(sel, 'note', state.pendingColor);
        state.annotations.push(a);
        renderPageAnnotations(a.page);
        renderNotesList();
        openNoteEditor(a.id, '', sel.anchor);
        hideSelectionBar();
        window.getSelection()?.removeAllRanges();
        persistSoon();
      } else if (act === 'ask') {
        askSelection(sel.text, sel.page);
        hideSelectionBar();
      }
    };
  });

  els.annoMenu.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = els.annoMenu.dataset.id;
    const a = state.annotations.find((x) => x.id === id);
    closeAnnoMenu();
    if (!a) return;
    if (btn.dataset.act === 'delete') deleteAnnotation(id);
    if (btn.dataset.act === 'edit-note') {
      const badge = $(`.anno-badge[data-id="${id}"]`);
      openNoteEditor(id, a.note || '', badge ? badge.getBoundingClientRect() : null);
    }
    if (btn.dataset.act === 'ask-about') askSelection(a.text, a.page);
  });

  $('#btnOrgClose').onclick = () => closeOrganizer();
  $('#btnOrgSave').onclick = () => orgSave(false);
  $('#btnOrgSaveAs').onclick = () => orgSave(true);
  $('#btnOrgInsertBlank').onclick = () => {
    const b = blankSize();
    state.orgPlan.push({ kind: 'blank', w: b.w, h: b.h });
    renderOrganizer();
  };
  $('#btnOrgInsertPdf').onclick = orgInsertPdf;

  $('#btnSaveSettings').onclick = saveSettings;
  $('#providerSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.fetchedModels = null;
    $$('#providerSeg button').forEach((x) => x.classList.toggle('active', x === b));
    const preset = PRESETS[b.dataset.provider];
    if (preset && preset.baseUrl) {
      $('#cfgBaseUrl').value = preset.baseUrl;
      $('#cfgModel').value = preset.model;
    }
    renderModelChips(b.dataset.provider);
    updateKeyPlaceholder();
  });
  $('#cfgModel').addEventListener('input', () => {
    const active = $('#providerSeg button.active');
    if (active) renderModelChips(active.dataset.provider);
  });

  $('#btnFetchModels').onclick = async () => {
    const btn = $('#btnFetchModels');
    btn.disabled = true;
    btn.textContent = tr('获取中…');
    try {
      const r = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept-Language': getLocale() },
        body: JSON.stringify({
          config: {
            baseUrl: $('#cfgBaseUrl').value.trim(),
            apiKey: $('#cfgKey').value.trim() || undefined,
          },
        }),
      });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
      if (!j.models || !j.models.length) throw new Error(tr('接口没有返回可用模型'));
      state.fetchedModels = j.models;
      renderModelList(j.models);
      toast(tr`拿到 ${j.models.length} 个模型`);
    } catch (err) {
      toast(tr('获取失败：') + err.message, 4000);
    } finally {
      btn.disabled = false;
      btn.textContent = tr('从接口获取列表');
    }
  };

  $$('#thinkSeg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.effort === state.effort);
    b.onclick = () => {
      state.effort = b.dataset.effort;
      localStorage.setItem('zj-effort', state.effort);
      $$('#thinkSeg button').forEach((x) => x.classList.toggle('active', x === b));
      updateChatMeta();
    };
  });

  $$('#scopeSeg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.scope === state.scope);
    b.onclick = () => {
      state.scope = b.dataset.scope;
      localStorage.setItem('zj-scope', state.scope);
      $$('#scopeSeg button').forEach((x) => x.classList.toggle('active', x === b));
    };
  });

  $$('#pdfDarkSeg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.pdfdark === state.pdfDark);
    b.onclick = () => {
      state.pdfDark = b.dataset.pdfdark;
      localStorage.setItem('zj-pdf-dark', state.pdfDark);
      $$('#pdfDarkSeg button').forEach((x) => x.classList.toggle('active', x === b));
      applyPdfDarkMode();
    };
  });
  $('#btnTest').onclick = async () => {
    const out = $('#testResult');
    out.className = 'test-result';
    out.textContent = tr('测试中…');
    try {
      const r = await fetch('/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept-Language': getLocale() },
        body: JSON.stringify({
          config: {
            provider: $('#providerSeg button.active').dataset.provider,
            baseUrl: $('#cfgBaseUrl').value.trim(),
            model: $('#cfgModel').value.trim(),
            apiKey: $('#cfgKey').value.trim() || undefined,
          },
        }),
      });
      const j = await r.json();
      if (j.ok) {
        out.className = 'test-result ok';
        out.textContent = tr`连接正常（${j.model}）`;
      } else {
        out.className = 'test-result err';
        out.textContent = j.error || tr('失败');
      }
    } catch (err) {
      out.className = 'test-result err';
      out.textContent = err.message;
    }
  };
  $$('[data-close]').forEach((b) => (b.onclick = () => (els.settingsModal.hidden = true)));
  $$('[data-view]').forEach((b) => {
    b.onclick = () => showSettingsView(b.dataset.view);
  });
  $('#btnViewBack').onclick = () => showSettingsView('settings');

  els.chatForm.onsubmit = (e) => {
    e.preventDefault();
    sendFromInput();
  };
  els.chatText.addEventListener('input', () => {
    els.chatText.style.height = 'auto';
    els.chatText.style.height = Math.min(els.chatText.scrollHeight, 132) + 'px';
  });
  els.chatText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendFromInput();
    }
  });
  els.chatQuick.addEventListener('mousedown', (e) => e.preventDefault());
  els.chatQuick.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && QUICK[b.dataset.act]) QUICK[b.dataset.act]();
  });
  $('#btnChatStop').onclick = () => state.abort && state.abort.abort();
  els.chatScroll.addEventListener('click', (e) => {
    const c = e.target.closest('.cite');
    if (c) {
      const p = Number(c.dataset.page);
      if (p) scrollToPage(p);
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (!els.annoMenu.hidden && !els.annoMenu.contains(e.target)) closeAnnoMenu();
    if (notePop && !notePop.contains(e.target) && !e.target.closest('.anno-badge')) closeNoteEditor();
  });

  document.addEventListener('selectionchange', () => {
    clearTimeout(window.__selTimer);
    window.__selTimer = setTimeout(() => {
      const sel = captureSelection();
      if (sel) {
        state.selection = sel;
        showSelectionBar(sel);
      } else if (els.selToolbar.hidden === false) {
        hideSelectionBar();
      }
    }, 120);
  });

  els.reader.addEventListener(
    'scroll',
    () => {
      if (!els.selToolbar.hidden) hideSelectionBar();
      if (state.rafScroll) return;
      state.rafScroll = requestAnimationFrame(() => {
        state.rafScroll = 0;
        const n = pageFromScroll();
        if (n !== state.currentPage) {
          state.currentPage = n;
          updatePageInfo();
          persistSoon();
        }
        renderVisible();
      });
    },
    { passive: true },
  );

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.pdfDoc) {
        if (state.fit) setScale(fitScale(), true);
        else layout();
        measureTops();
      }
      const w = parseInt(localStorage.getItem('zj-chat-w') || '', 10);
      if (w) applyChatWidth(w);
    }, 180);
  });

  document.addEventListener('keydown', (e) => {
    const el = document.activeElement;
    const typing = el && (/^(INPUT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      pickFile();
      return;
    }
    if (e.key === 'Escape') {
      hideSelectionBar();
      closeAnnoMenu();
      closeNoteEditor();
      els.settingsModal.hidden = true;
      if (state.orgOpen) closeOrganizer();
      return;
    }
    if (typing) return;
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') scrollToPage(state.currentPage - 1);
    else if (e.key === 'ArrowRight' || e.key === 'PageDown') scrollToPage(state.currentPage + 1);
    else if (e.key === '+' || e.key === '=') $('#btnZoomIn').click();
    else if (e.key === '-') $('#btnZoomOut').click();
    else if (e.key.toLowerCase() === 'h' && state.selection) {
      addAnnotations(makeAnnotation(state.selection, 'highlight', state.pendingColor));
      hideSelectionBar();
      window.getSelection()?.removeAllRanges();
    }
  });

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) document.body.classList.remove('dragging');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const file = e.dataTransfer?.files?.[0];
    if (file && /\.pdf$/i.test(file.name)) await loadFile(file, null);
    else if (file) toast(tr('只支持 PDF 文件'));
  });

  if (window.innerWidth < 1360) document.body.classList.add('sidebar-collapsed');
}

function setScale(next, fit = false) {
  const s = clamp(next, 0.3, 3);
  if (Math.abs(s - state.scale) < 0.0005 && !fit) return;
  const el = state.pageEls[state.currentPage - 1];
  const offset = el ? (els.reader.scrollTop - el.offsetTop) / el.offsetHeight : 0;
  state.scale = s;
  state.fit = fit;
  layout();
  const el2 = state.pageEls[state.currentPage - 1];
  if (el2) els.reader.scrollTop = el2.offsetTop + offset * el2.offsetHeight;
  measureTops();
}

async function loadDemo() {
  try {
    const r = await fetch('samples/demo.pdf');
    if (!r.ok) throw new Error(tr('示例文件缺失'));
    const buf = new Uint8Array(await r.arrayBuffer());
    await loadBytes(buf, '示例 · 认真阅读的艺术', { mtime: 0, size: buf.length });
  } catch (err) {
    toast(tr('示例加载失败：') + err.message);
  }
}

/* ================================================================
   boot
   ================================================================ */
(async function boot() {
  initI18n();
  initUI();
  applyPdfDarkMode();
  await loadConfig();
  const ok = await fetch('/api/health')
    .then((r) => r.ok)
    .catch(() => false);
  if (!ok) fatal(new Error(tr('本地服务没有响应，请重启「纸间」。')));
  if (window.innerWidth >= 1400) document.body.classList.remove('sidebar-collapsed');
  const params = new URLSearchParams(location.search);
  const wanted = params.get('theme');
  if (wanted && THEMES.some((t) => t.id === wanted)) applyTheme(wanted);
  if (params.has('demo')) loadDemo();

  if (new URLSearchParams(location.search).has('debug')) {
    window.ZJ = {
      state,
      scrollToPage,
      loadDemo,
      openOrganizer,
      closeOrganizer,
      addAnnotations,
      makeAnnotation,
      captureSelection,
      renderNotesList,
      openSettings,
      setScale,
      buildContext,
      ensureDocText,
      setQuote,
      applyTheme,
    };
  }
})();
