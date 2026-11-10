import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Load browser ES modules without changing the CommonJS server's package type.
// Data URLs also keep this test compatible with the project's Node 18 baseline.
const moduleURL = (source) => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const catalogURL = moduleURL(await readFile(new URL('../public/js/locale-en.js', import.meta.url), 'utf8'));
const { default: english } = await import(catalogURL);
const source = (await readFile(new URL('../public/js/i18n.js', import.meta.url), 'utf8'))
  .replace("'./locale-en.js'", JSON.stringify(catalogURL));

globalThis.localStorage = { getItem: () => 'en' };
const en = await import(moduleURL(source) + '#en');
globalThis.localStorage = { getItem: () => null };
const zh = await import(moduleURL(source) + '#zh');

test('every catalog message translates completely, including parameterized messages', () => {
  for (const [source, expected] of Object.entries(english)) assert.equal(en.tr(source), expected, source);
});
test('interpolated document, note, and user text is not translated or re-interpolated', () => {
  const userText = '设置 保存 {0} <span>中文</span>';
  assert.equal(en.tr`<div>笔记</div>${userText}`, '<div>Notes</div>' + userText);
  assert.equal(en.tr`第 ${8} 页`, 'Page 8');
  assert.equal(en.tr`已附上相关 ${2} / ${6} 页 · ${'300 characters'}（全文 ${'900 characters'}）`, 'Relevant pages: 2 / 6 · 300 characters (full document: 900 characters)');
});
test('Chinese is the default and preserves source text and substitutions', () => {
  assert.equal(zh.getLocale(), 'zh-CN');
  assert.equal(zh.tr('设置'), '设置');
  assert.equal(zh.tr`第 ${3} 页`, '第 3 页');
});
