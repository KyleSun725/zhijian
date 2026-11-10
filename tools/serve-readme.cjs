// Local preview only: expose generated HTML documents, no directory access.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const pages = new Map(['README-preview.html', 'README-en-preview.html', 'USAGE-preview.html', 'USAGE-en-preview.html'].map(name =>
  ['/' + name, path.join(__dirname, '..', 'docs', name)]));
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const page = pages.get(pathname === '/' ? '/README-preview.html' : pathname);
  if (!page || !['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(page).pipe(res);
});
server.listen(0, '127.0.0.1', () => {
  console.log('Local: http://127.0.0.1:' + server.address().port + '/README-preview.html');
});
