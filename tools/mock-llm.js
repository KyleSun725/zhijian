/* Minimal OpenAI-compatible mock so we can test the chat pipeline without a real key. */
const http = require('node:http');

const ANSWER = [
  '这份文档讲的是**如何把阅读变成可积累的理解**，而不是读完就忘。\n\n',
  '核心主张有三点：\n\n',
  '1. 被动阅读会制造「我在学习」的错觉，读得顺不等于读得懂 [p.2]\n',
  '2. 检视、分析、主题三种姿态要分开使用，混用是低效的主要原因 [p.3]\n',
  '3. 好批注留下的是「过程」而不是「结论」 [p.4]\n\n',
  '> 阅读的终点不是读完，而是能够用自己的话讲给另一个人听。 [p.6]\n\n',
  '如果你正拿它复习，建议先看第三章的四种批注，再用第四章的三个动作做一次回顾。',
];

const MODELS = [
  'gpt-5.2', 'gpt-5-mini', 'gpt-5.2-pro', 'o4-mini', 'o3',
  'text-embedding-3-large', 'whisper-1', 'dall-e-3',
  'deepseek-flash', 'deepseek-v4-pro', 'qwen3-max', 'kimi-k2',
];

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/last')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(globalThis.__lastBody || null));
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: MODELS.map((id) => ({ id, object: 'model' })) }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try { globalThis.__lastBody = JSON.parse(body); } catch {}
    let echo = '';
    try {
      const j = JSON.parse(body);
      echo =
        '参数回显：model=`' +
        j.model +
        '`，thinking=`' +
        JSON.stringify(j.thinking || null) +
        '`，reasoning_effort=`' +
        (j.reasoning_effort || 'null') +
        '`，temperature=`' +
        (j.temperature === undefined ? '未发送' : j.temperature) +
        '`\n\n';
    } catch {}
    const ANSWER = [echo + '这份文档讲的是**如何把阅读变成可积累的理解**，而不是读完就忘。\n\n', '核心主张有三点：\n\n', '1. 被动阅读会制造「我在学习」的错觉 [p.2]\n', '2. 三种姿态要分开使用 [p.3]\n', '3. 好批注留下的是过程而不是结论 [p.4]\n\n', '| 姿态 | 目的 | 做法 |\n', '|---|:--:|--:|\n', '| 检视 | 判断值不值得读 | 15 分钟看目录和首尾段 [p.3] |\n', '| 分析 | 吃透一本书 | 每章写三句话总结 [p.3] |\n', '| 主题 | 围绕问题读多本 | 先立问题再找书 [p.3] |\n\n', '表格上面的这一行是正文，用来检查表格前后的段落是否正常。\n\n',
    '公式测试：行内 $T_{c}=T_{CM}+\\frac{Q}{kA}$，以及 $\\Delta T$ 的代价。\n\n',
    '$$Q=kA\\,\\Delta T=kA\\,(T_{c}-T_{CM})\\quad\\Rightarrow\\quad T_{c}=T_{CM}+\\frac{Q}{kA}$$\n\n',
    '$$\\dot{m}\\,c_{p}\\,\\Delta T=\\rho\\,V\\,c_{p}\\,(T_{CM,outlet}-T_{CM,inlet})=Q$$\n'];
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    let i = 0;
    const tick = () => {
      if (i >= ANSWER.length) {
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: ANSWER[i++] } }] }) + '\n\n');
      setTimeout(tick, 90);
    };
    tick();
  });
});

server.listen(8799, '127.0.0.1', () => console.log('mock llm on 8799'));
