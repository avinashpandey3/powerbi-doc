import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { documentModel, analyzeModel, generateDax } from './lib.js';
import { importFile, MAX_FILE_BYTES } from './importers.js';
import { getLimits } from './limits.js';
const limits = getLimits();
const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/import-model.js': ['import-model.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
function readBody(req, limit, label) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0, exceeded = false;
    req.on('data', chunk => {
      if (exceeded) return;
      size += chunk.length;
      if (size > limit) {
        exceeded = true; chunks = [];
        reject(Object.assign(new Error(`${label} exceeds ${limit / 1_000_000} MB.`), { status: 413 }));
      } else chunks.push(chunk);
    });
    req.once('end', () => { if (!exceeded) resolve(Buffer.concat(chunks)); });
    req.once('error', reject);
    req.once('aborted', () => reject(new Error('Upload interrupted. Please try again.')));
  });
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost'), path = url.pathname;
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' })); return;
    }
    if (req.method === 'GET' && path === '/api/limits') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(limits)); return;
    }
    if (req.method === 'POST' && path === '/api/import') {
      const filename = url.searchParams.get('filename');
      if (!filename || filename.length > 255) throw new Error('Provide a filename of up to 255 characters.');
      const buffer = await readBody(req, MAX_FILE_BYTES, 'Uploaded file');
      const result = await importFile(buffer, filename);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result })); return;
    }
    if (req.method === 'POST' && ['/api/docs', '/api/analyze', '/api/dax'].includes(path)) {
      const body = await readBody(req, limits.maxModelBytes, 'Model metadata');
      const input = JSON.parse(body.toString('utf8'));
      const result = path === '/api/docs' ? documentModel(input) : path === '/api/analyze' ? analyzeModel(input) : generateDax(input);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result })); return;
    }
    if (req.method !== 'GET' || !files[path]) { res.writeHead(404); res.end('Not found'); return; }
    const [file, type] = files[path];
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(await readFile(fileURLToPath(new URL(`./public/${file}`, import.meta.url))));
  } catch (error) { res.writeHead(error.status || 400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
});
const host = process.env.HOST || '127.0.0.1';
server.listen(Number(process.env.PORT || 3000), host, () => console.log(`PowerBI Doc listening on ${host} port ${server.address().port}`));
