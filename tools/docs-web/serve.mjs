/**
 * serve.mjs —— 给 docs/platform-guide/web/ 起一个零依赖静态服务器（只读）
 * 用法：node tools/docs-web/serve.mjs [port]
 *
 * 除了站点根目录，还会回退到 docs/platform-guide/、docs/、仓库根 —— 这样页面里指向
 * 原始 .md（如 ../UI框架使用说明.md、../../tools/excel_export/README.md）的链接在
 * 浏览器里也能直接打开（否则那些 ../ 会被浏览器规整成站点根下的路径而 404）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const WEB = path.join(REPO, 'docs/platform-guide/web');
const ROOTS = [WEB, path.join(REPO, 'docs/platform-guide'), path.join(REPO, 'docs'), REPO];
const PORT = Number(process.argv[2] || 8799);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

http.createServer((req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/' || p.endsWith('/')) p += 'index.html';
    const rel = path.normalize(p).replace(/^([/\\])+/, '');
    let file = null;
    for (const root of ROOTS) {
      const cand = path.join(root, rel);
      if (cand.startsWith(root) && fs.existsSync(cand) && fs.statSync(cand).isFile()) { file = cand; break; }
    }
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 ' + p);
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('500 ' + e.message);
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`平台层教程已起在 http://127.0.0.1:${PORT}/`);
  console.log(`  站点根：${WEB}`);
  console.log(`  回退根：${ROOTS.slice(1).join(' , ')}`);
});

