import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { documentModel, analyzeModel, generateDax } from './lib.js';
const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' })); return;
    }
    if (req.method === 'POST' && ['/api/docs', '/api/analyze', '/api/dax'].includes(path)) {
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 2_000_000) { res.writeHead(413); res.end('Model exceeds 2 MB.'); return; } }
      const input = JSON.parse(body);
      const result = path === '/api/docs' ? documentModel(input) : path === '/api/analyze' ? analyzeModel(input) : generateDax(input);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result })); return;
    }
    if (req.method !== 'GET' || !files[path]) { res.writeHead(404); res.end('Not found'); return; }
    const [file, type] = files[path];
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(await readFile(fileURLToPath(new URL(`./public/${file}`, import.meta.url))));
  } catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
});
const host = process.env.HOST || '127.0.0.1';
server.listen(Number(process.env.PORT || 3000), host, () => console.log(`PowerBI Doc listening on ${host} port ${server.address().port}`));
