/* Generates public/samples/demo.pdf — a small, real Chinese PDF used by "看看示例". */
const fs = require('node:fs');
const path = require('node:path');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const W = 595.28;
const H = 841.89;
const M = 62; // left / right margin
const TOP = H - 74;
const BOTTOM = 66;
const INK = rgb(0.11, 0.1, 0.09);
const MUTED = rgb(0.36, 0.33, 0.29);
const SOFT = rgb(0.55, 0.52, 0.46);
const ACCENT = rgb(0.69, 0.32, 0.18);
const RULE = rgb(0.85, 0.82, 0.76);
const QUOTE_BG = rgb(0.98, 0.97, 0.95);

const FONT_REG = 'C:/Windows/Fonts/Deng.ttf';
const FONT_BOLD = 'C:/Windows/Fonts/Dengb.ttf';

const CJK_NO_START = '，。、；：？！）】》」』%”’·…—';
const tokenize = (text) => text.match(/[A-Za-z0-9@._%+-]+|\s+|[^\s]/g) || [];

async function main() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const reg = await doc.embedFont(fs.readFileSync(FONT_REG), { subset: true });
  const bold = await doc.embedFont(fs.readFileSync(FONT_BOLD), { subset: true });

  let page = null;
  let y = 0;
  const pages = [];

  const newPage = () => {
    page = doc.addPage([W, H]);
    pages.push(page);
    y = TOP;
  };

  const ensure = (h) => {
    if (!page || y - h < BOTTOM) newPage();
  };

  const wrap = (text, font, size, maxWidth) => {
    const lines = [];
    let line = '';
    for (const tk of tokenize(text)) {
      const next = line + tk;
      if (font.widthOfTextAtSize(next, size) > maxWidth && line.trim()) {
        const isSpace = /^\s+$/.test(tk);
        if (CJK_NO_START.includes(tk) && !isSpace) {
          lines.push(line + tk);
          line = '';
        } else {
          lines.push(line.replace(/\s+$/, ''));
          line = isSpace ? '' : tk;
        }
      } else {
        line = next;
      }
    }
    if (line.trim()) lines.push(line.replace(/\s+$/, ''));
    return lines;
  };

  const para = (text, opts = {}) => {
    const size = opts.size || 11;
    const font = opts.font || reg;
    const lh = opts.lh || 19.4;
    const indent = opts.indent || 0;
    const maxW = W - M * 2 - indent;
    const lines = wrap(text, font, size, maxW);
    lines.forEach((ln, i) => {
      ensure(lh);
      const x = M + indent + (i === 0 && opts.firstIndent ? size * 2 : 0);
      page.drawText(ln, { x, y: y - size, size, font, color: opts.color || INK });
      y -= lh;
    });
    y -= opts.after != null ? opts.after : 8;
  };

  const heading = (num, text) => {
    ensure(64);
    y -= 6;
    page.drawText(num, { x: M, y: y - 24, size: 22, font: reg, color: ACCENT });
    page.drawText(text, { x: M + 40, y: y - 24, size: 18.5, font: bold, color: INK });
    y -= 40;
    page.drawLine({ start: { x: M, y }, end: { x: M + 46, y }, thickness: 1.4, color: ACCENT });
    y -= 20;
  };

  const kicker = (text) => {
    ensure(30);
    const spaced = text.split('').join(' ');
    page.drawText(spaced, { x: M, y: y - 8, size: 7.4, font: reg, color: ACCENT });
    y -= 26;
  };

  const bullets = (items) => {
    items.forEach((it) => {
      ensure(24);
      page.drawCircle({ x: M + 5, y: y - 6.4, size: 1.7, color: ACCENT });
      const lines = wrap(it, reg, 10.6, W - M * 2 - 22);
      lines.forEach((ln, i) => {
        ensure(18.5);
        if (i > 0) page.drawText(ln, { x: M + 22, y: y - 10.6, size: 10.6, font: reg, color: INK });
        else page.drawText(ln, { x: M + 22, y: y - 10.6, size: 10.6, font: reg, color: INK });
        y -= 18.5;
      });
      y -= 4;
    });
    y -= 4;
  };

  const quote = (text) => {
    const lines = wrap(text, reg, 10.4, W - M * 2 - 38);
    const h = lines.length * 18.5 + 18;
    ensure(h + 12);
    page.drawRectangle({
      x: M,
      y: y - h + 4,
      width: W - M * 2,
      height: h,
      color: QUOTE_BG,
    });
    page.drawRectangle({ x: M, y: y - h + 4, width: 2.4, height: h, color: ACCENT });
    let qy = y - 6;
    lines.forEach((ln) => {
      page.drawText(ln, { x: M + 18, y: qy - 10.4, size: 10.4, font: reg, color: MUTED });
      qy -= 18.5;
    });
    y -= h + 14;
  };

  /* ---------------- cover ---------------- */
  newPage();
  y = H - 210;
  page.drawText('R E A D I N G   N O T E S   0 1', {
    x: M,
    y: y + 8,
    size: 8,
    font: reg,
    color: ACCENT,
  });
  y -= 26;
  page.drawText('认真阅读的', { x: M, y: y - 34, size: 34, font: bold, color: INK });
  y -= 60;
  page.drawText('艺术', { x: M, y: y - 34, size: 34, font: bold, color: INK });
  y -= 74;
  page.drawLine({ start: { x: M, y }, end: { x: M + 52, y }, thickness: 2.2, color: ACCENT });
  y -= 34;
  para('为什么我们读了很多，却什么也没留下', { size: 12.6, color: MUTED, lh: 22 });
  y -= 12;
  para('阅读不是把文字从纸上搬进脑子。它是提问、是反驳、是在页边留下自己的痕迹，然后在一周之后还能想起当时为什么点头。', {
    size: 11.6,
    color: MUTED,
    lh: 22,
  });
  page.drawText('纸间 · 示例文档　｜　共 6 页', {
    x: M,
    y: 60,
    size: 8.4,
    font: reg,
    color: SOFT,
  });

  /* ---------------- chapter 1 ---------------- */
  newPage();
  kicker('CHAPTER ONE');
  heading('01', '为什么我们读不进去');
  para(
    '大多数人的阅读困境，不是读得慢，而是读得太顺。眼睛一路滑过去，每一句都懂，合上书却讲不出这一章在论证什么。这种状态有一个准确的描述：被动阅读。它消耗时间，却不产生理解。',
    { firstIndent: true, lh: 20.4 },
  );
  para(
    '被动阅读之所以让人上瘾，是因为它制造了「我在学习」的错觉。翻页的动作、荧光笔的颜色、笔记本上的摘抄，都在提供即时的完成感。但理解发生在别处——发生在你试图用自己的话复述、试图找出作者的漏洞、试图把它和已知的东西连起来的那一刻。',
    { firstIndent: true, lh: 20.4 },
  );
  y -= 2;
  para('三个常见症状', { font: bold, size: 11.6, after: 10 });
  bullets([
    '划线代替思考。划完一句就以为掌握了，其实只是标记了「这里重要」，并没有回答「为什么重要」。',
    '不敢停下来。遇到不懂的段落硬着头皮往下读，后面的论证全部悬空。',
    '读完即结束。没有回顾机制，两周后只剩下「这本书不错」的印象。',
  ]);
  quote('不加批注的阅读，就像不记分的比赛：你参与了，但没有人知道结果。');
  para(
    '这一章剩下的部分，会把阅读拆成三种可以分别练习的姿态。你不需要每次都全力投入，但你需要知道自己此刻在用哪一种。',
    { firstIndent: true },
  );

  /* ---------------- chapter 2 ---------------- */
  newPage();
  kicker('CHAPTER TWO');
  heading('02', '三种阅读姿态');
  para('同一本书，在不同的目的下应该被用不同的方式读。混用这三种姿态，是效率低下的主要原因。', {
    lh: 20.4,
  });
  y -= 4;
  para('检视阅读', { font: bold, size: 11, after: 4 });
  para(
    '十五分钟内读完目录、序言、每章首尾段和结论。只回答一个问题：它和我关心的事有关吗？这一步决定你后面要不要投入十个小时。',
    { indent: 16, lh: 19 },
  );
  para('分析阅读', { font: bold, size: 11, after: 4 });
  para(
    '逐章推进，每章结束时用三句话写出：作者的主张、支撑它的证据、我是否被说服。写不出来，说明这一章还没读透。',
    { indent: 16, lh: 19 },
  );
  para('主题阅读', { font: bold, size: 11, after: 4 });
  para(
    '先立问题，再让书为问题服务。不同作者对同一概念的定义差异，往往比结论更有价值。',
    { indent: 16, lh: 19 },
  );
  y -= 6;
  para('一个实用的判断', { font: bold, size: 11.6, after: 8 });
  para(
    '如果你读完一章，说不出「作者想让我相信什么」，那就是检视阅读没做够，或者分析阅读刚开始就断了。回到章首，重读第一段和最后一段，通常就能找回骨架。',
    { firstIndent: true, lh: 20.4 },
  );
  para(
    '检视阅读并不低级。恰恰相反，它是最被低估的一种能力：在有限的时间里判断什么不值得读，比把每本书都读完更能提高你的平均输入质量。',
    { firstIndent: true, lh: 20.4 },
  );

  /* ---------------- chapter 3 ---------------- */
  newPage();
  kicker('CHAPTER THREE');
  heading('03', '批注的方法');
  para('批注的目的不是留下痕迹，而是留下可检索的思路。一条好的批注，三个月后你自己还能看懂。', {
    lh: 20.4,
  });
  y -= 4;
  para('四种值得写的批注', { font: bold, size: 11.6, after: 10 });
  bullets([
    '定义型。作者在这里给了一个关键概念下定义——把它圈出来，用自己的话重写一遍。',
    '质疑型。证据不足以支撑结论，或者样本有问题。写下你的反驳，哪怕后来证明是错的。',
    '连接型。这段和你读过的另一本书、做过的另一个项目有关。写下那个连接点。',
    '疑问型。没读懂的地方，明确标记「此处不懂」，而不是含混地划过去。',
  ]);
  y -= 2;
  para('颜色要有语义', { font: bold, size: 11.6, after: 8 });
  para(
    '如果所有重点都是黄色，那等于没有重点。给颜色分配固定的含义：黄色是事实与数据，绿色是作者的核心主张，蓝色是与自己工作的连接，粉色是需要回头核实的疑点。四种就够了，多了记不住。',
    { firstIndent: true, lh: 20.4 },
  );
  quote('批注的质量，取决于你写下的是「结论」还是「过程」。只写结论的批注，三个月后和原文一样陌生。');

  /* ---------------- chapter 4 ---------------- */
  newPage();
  kicker('CHAPTER FOUR');
  heading('04', '让笔记回到记忆里');
  para(
    '读完之后，笔记去哪里了？大多数人诚实地说：再也没打开过。这不是自制力的问题，是流程设计的问题——笔记被存放在你阅读时所在的地方，而不是你复习时所在的地方。',
    { lh: 20.4 },
  );
  y -= 4;
  para('三个动作，形成一个闭环', { font: bold, size: 11.6, after: 10 });
  bullets([
    '当天整理。读完当天，把批注过一遍，删掉一半。留下的每一条补一句「为什么它重要」。',
    '一周复述。不看原文，用五分钟向自己（或别人）讲清楚这份材料在说什么。讲不下去的地方，就是没读懂的地方。',
    '间隔回顾。两周、一个月、三个月各回顾一次。每次只花几分钟，看批注而不是重读原文。',
  ]);
  para(
    '这套流程真正的价值，不在于记住多少细节，而在于它会逼你在阅读时就为「未来的自己」写作。知道自己一周后要复述，你读的时候就会自动寻找论证结构，而不是被动接收句子。',
    { firstIndent: true, lh: 20.4 },
  );
  y -= 10;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.7, color: RULE });
  y -= 18;
  para('试试看：在这份示例里随便选一段文字，划一条高亮，再写一条笔记。然后问问右侧的 AI 助手「第三章讲了什么」。这就是纸间设计的使用方式。', {
    size: 9.4,
    color: SOFT,
    lh: 17,
  });

  /* ---------------- coda ---------------- */
  newPage();
  kicker('CODA');
  heading('05', '把书读薄，再读厚');
  para(
    '读书有两个方向。一个是把书读薄：用一页纸概括整本书的骨架，用三句话讲清楚作者的主张。另一个是把书读厚：从一个概念出发，连到十本别的书、三个自己的经验、一个尚未回答的问题。',
    { firstIndent: true, lh: 20.4 },
  );
  para(
    '只读薄，你会变成一个擅长总结却缺乏洞见的人。只读厚，你会淹没在材料里，永远写不出自己的判断。真正有效的阅读，是在这两端之间来回移动。',
    { firstIndent: true, lh: 20.4 },
  );
  para(
    '而工具能做的，只是让这个来回变得便宜一点：让批注随手可写，让页面随手可整，让「这一段到底什么意思」这个问题，不必等到合上书才被回答。',
    { firstIndent: true, lh: 20.4 },
  );
  quote('阅读的终点不是读完，而是能够用自己的话，把它讲给另一个人听。');
  y -= 16;
  para('—— 完 ——', { color: SOFT, size: 10.4 });

  /* ---------------- page numbers ---------------- */
  pages.forEach((p, i) => {
    if (i === 0) return;
    const label = String(i + 1);
    p.drawText(label, {
      x: W - M - reg.widthOfTextAtSize(label, 8.4),
      y: 42,
      size: 8.4,
      font: reg,
      color: SOFT,
    });
    p.drawText('纸间 · 认真阅读的艺术', { x: M, y: 42, size: 7.6, font: reg, color: SOFT });
  });

  const bytes = await doc.save();
  const out = path.join(__dirname, '..', 'public', 'samples', 'demo.pdf');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, bytes);
  console.log('wrote', out, (bytes.length / 1024).toFixed(0) + ' KB', 'pages:', pages.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
