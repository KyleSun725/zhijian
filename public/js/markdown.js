/* Tiny, dependency-free Markdown renderer tuned for chat answers. */
import { tr } from './i18n.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/** [p.12] / [第12页] / [P12] → clickable chip */
function citations(html) {
  return html.replace(/\[(?:p\.?\s*|page\s*|第\s*)(\d{1,4})\s*(?:页)?\]/gi, (m, n) => {
    return `<span class="cite" data-page="${n}" title="${tr`跳到第 ${n} 页`}">p.${n}</span>`;
  });
}

function inline(text) {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, (m, code) => `<code>${code}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return s;
}

/** 把 $...$ / $$...$$ / \(...\) / \[...\] 抽出来，避免被 Markdown 规则破坏 */
function extractMath(text) {
  const math = [];
  const push = (tex, display) => {
    math.push({ tex: tex.trim(), display });
    return `\u0000MATH${math.length - 1}\u0000`;
  };
  let s = text;

  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => push(tex, true));
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (m, tex) => push(tex, true));
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (m, tex) => push(tex, false));

  // 行内 $...$：要求内容里有 LaTeX 特征，避免把 $5 之类当公式
  s = s.replace(/(^|[^\\$])\$(?!\s)([^$\n]{1,300}?)(?<![\s\\])\$/g, (m, pre, tex) => {
    if (!/[\\^_={}]/.test(tex)) return m;
    return pre + push(tex, false);
  });

  return { text: s, math };
}

function renderMath(item) {
  const tex = item ? item.tex : '';
  if (!tex) return '';
  if (typeof window !== 'undefined' && window.katex && typeof window.katex.renderToString === 'function') {
    try {
      return window.katex.renderToString(tex, {
        displayMode: item.display,
        throwOnError: false,
        strict: 'ignore',
        output: 'html',
      });
    } catch {
      /* fall through */
    }
  }
  return `<code class="math-fallback">${esc(tex)}</code>`;
}

export function mdToHtml(src) {
  if (!src) return '';

  // 1. pull out fenced code blocks
  const blocks = [];
  let text = String(src).replace(/```([a-zA-Z0-9+#-]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    blocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000CODE${blocks.length - 1}\u0000`;
  });

  // 1.5 pull out math (after code, so $ inside code stays literal)
  const mathExtract = extractMath(text);
  text = mathExtract.text;

  // 2. inline pass on escaped text
  text = citations(inline(text));

  // 3. block pass
  const lines = text.split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  let para = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.join('<br>')}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  const splitRow = (line) => {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
  };
  const isSeparator = (line) =>
    typeof line === 'string' && line.includes('-') && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line);

  const buildTable = (header, aligns, rows) => {
    const th = header
      .map((c, i) => `<th style="text-align:${aligns[i] || 'left'}">${c}</th>`)
      .join('');
    const body = rows
      .map(
        (r) =>
          '<tr>' +
          header
            .map((_, i) => `<td style="text-align:${aligns[i] || 'left'}">${r[i] || ''}</td>`)
            .join('') +
          '</tr>',
      )
      .join('');
    return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const code = line.match(/^\u0000CODE(\d+)\u0000$/);
    if (code) {
      flushPara();
      flushList();
      out.push(blocks[Number(code[1])]);
      continue;
    }

    // 表格：当前行含 |，下一行是 |---|---| 分隔行
    if (line.includes('|') && isSeparator(lines[i + 1])) {
      flushPara();
      flushList();
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) =>
        c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left',
      );
      i += 1;
      const rows = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1].replace(/\s+$/, '');
        if (!next.trim() || !next.includes('|') || isSeparator(next)) break;
        const cells = splitRow(next);
        if (cells.some((c) => c.length)) rows.push(cells);
        i += 1;
      }
      out.push(buildTable(header, aligns, rows));
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      out.push(`<h3>${h[2]}</h3>`);
      continue;
    }
    const bq = line.match(/^&gt;\s?(.*)$/);
    if (bq) {
      flushPara();
      flushList();
      out.push(`<blockquote>${bq[1]}</blockquote>`);
      continue;
    }
    const ul = line.match(/^\s*[-*·]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) {
        flushList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${(ul || ol)[1]}</li>`);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();

  return out
    .join('')
    .replace(/\u0000CODE(\d+)\u0000/g, (m, i) => blocks[Number(i)] || '')
    .replace(/\u0000MATH(\d+)\u0000/g, (m, i) => renderMath(mathExtract.math[Number(i)]))
    .replace(/<p><\/p>/g, '');
}

export { esc };
