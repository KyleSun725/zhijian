import english from './locale-en.js';

const STORAGE_KEY = 'zj-language';
let locale = 'zh-CN';
try { if (localStorage.getItem(STORAGE_KEY) === 'en') locale = 'en'; } catch {}
export const getLocale = () => locale;
const escapeRE = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const entries = Object.entries(english).sort((a, b) => b[0].length - a[0].length);
const literals = new Map(entries.filter(([key]) => !/\{\d+\}/.test(key)));
const literalRE = new RegExp([...literals.keys()].map(escapeRE).join('|'), 'g');
const templates = entries.filter(([key]) => /\{\d+\}/.test(key)).map(([key, value]) => ({
  pattern: new RegExp(key.split(/\{\d+\}/).map(escapeRE).join('(\\{\\d+\\})'), 'g'), value,
}));

// Tagged templates translate the authored format BEFORE inserting values, so even
// a note/document title equal to a UI label remains byte-for-byte unchanged.
export function tr(source, ...values) {
  const tagged = Array.isArray(source) && Object.hasOwn(source, 'raw');
  let text = tagged ? source.map((part, i) => part + (i < values.length ? `{${i}}` : '')).join('') : String(source);
  if (locale === 'en') {
    for (const { pattern, value } of templates) {
      text = text.replace(pattern, (...args) => value.replace(/\{(\d+)\}/g, (_, n) => args[Number(n) + 1]));
    }
    text = text.replace(literalRE, (key) => literals.get(key));
  }
  return tagged ? text.replace(/\{(\d+)\}/g, (_, n) => String(values[Number(n)])) : text;
}

const staticNodes = [];
function captureStatic(root) {
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) {
    const node = walk.currentNode;
    if (/[\u4e00-\u9fff]/.test(node.data) && !node.parentElement.closest('script, style, [data-no-i18n]')) {
      staticNodes.push({ node, source: node.data, last: node.data });
    }
  }
  for (const node of root.querySelectorAll('[title], [placeholder], [aria-label]')) {
    if (node.closest('[data-no-i18n]')) continue;
    for (const attr of ['title', 'placeholder', 'aria-label']) {
      const source = node.getAttribute(attr);
      if (source && /[\u4e00-\u9fff]/.test(source)) staticNodes.push({ node, attr, source, last: source });
    }
  }
}
export function refreshStatic() {
  document.documentElement.lang = locale;
  document.title = tr('纸间 · PDF 阅读与批注');
  for (const item of staticNodes) {
    if (!item.node.isConnected) continue;
    const current = item.attr ? item.node.getAttribute(item.attr) : item.node.data;
    // A dynamic value replaced this label: its owner will render it, never overwrite it.
    if (current !== item.last) continue;
    item.last = tr(item.source);
    if (item.attr) item.node.setAttribute(item.attr, item.last);
    else item.node.data = item.last;
  }
  document.querySelectorAll('[data-language]').forEach((button) => {
    const selected = button.dataset.language === locale;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}
export function setLocale(next) {
  if (!['zh-CN', 'en'].includes(next)) return;
  locale = next;
  try { localStorage.setItem(STORAGE_KEY, locale); } catch {}
  refreshStatic();
  window.dispatchEvent(new CustomEvent('languagechange', { detail: { locale } }));
}
export function initI18n() {
  captureStatic(document.body);
  refreshStatic();
  document.querySelectorAll('[data-language]').forEach((button) => {
    button.addEventListener('click', () => setLocale(button.dataset.language));
  });
}
