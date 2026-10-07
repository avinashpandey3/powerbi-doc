import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { documentModel, analyzeModel, generateDax } from './lib.js';
import { documentHtml } from './document-html.js';
import { inspectModel, reviewDax } from './model-doctor.js';
import { buildDashboard } from './dashboard.js';
import { generateAssistant, getAiStatus } from './ai.js';
import { importFile, MAX_FILE_BYTES } from './importers.js';
import { getLimits } from './limits.js';
const limits = getLimits();
const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/import-model.js': ['import-model.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
let activeAiRequests = 0;
const aiRequests = [];
function assistantAccess(req) {
  const expected = process.env.AI_ACCESS_TOKEN;
  if (!expected) return;
  const received = String(req.headers['x-assistant-token'] || '');
  const actualBytes = Buffer.from(received), expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) throw Object.assign(new Error('Enter the private assistant token configured by the app owner.'), { status: 401 });
}
function reserveAssistant() {
  const now = Date.now();
  while (aiRequests.length && aiRequests[0] < now - 60_000) aiRequests.shift();
  if (activeAiRequests >= 2 || aiRequests.length >= 20) throw Object.assign(new Error('The assistant is busy. Please try again in a minute.'), { status: 429 });
  aiRequests.push(now); activeAiRequests++;
}
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
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
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
    if (req.method === 'GET' && path === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ app: { name: 'PowerBI Doctor', version: '0.2.0' }, ai: { ...getAiStatus(), accessRequired: Boolean(process.env.AI_ACCESS_TOKEN) }, features: { documentation: true, dax: true, analysis: true, dashboard: true, powerquery: true, executeDax: false, livePowerBi: false } })); return;
    }
    if (req.method === 'POST' && path === '/api/import') {
      const filename = url.searchParams.get('filename');
      if (!filename || filename.length > 255) throw new Error('Provide a filename of up to 255 characters.');
      const buffer = await readBody(req, MAX_FILE_BYTES, 'Uploaded file');
      const result = await importFile(buffer, filename);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result })); return;
    }
    if (req.method === 'POST' && ['/api/docs', '/api/docs-html', '/api/analyze', '/api/analysis-overview', '/api/dax', '/api/dax-review', '/api/dashboard', '/api/assistant'].includes(path)) {
      if (path === '/api/assistant') assistantAccess(req);
      const body = await readBody(req, limits.maxModelBytes, 'Model metadata');
      const input = JSON.parse(body.toString('utf8'));
      let result;
      if (path === '/api/docs') result = documentModel(input);
      else if (path === '/api/docs-html') result = documentHtml(input);
      else if (path === '/api/analyze') result = analyzeModel(input);
      else if (path === '/api/analysis-overview') result = inspectModel(input);
      else if (path === '/api/dax') result = generateDax(input);
      else if (path === '/api/dax-review') result = reviewDax(input);
      else if (path === '/api/dashboard') result = buildDashboard(input);
      else {
        reserveAssistant();
        try { result = await generateAssistant(input); }
        finally { activeAiRequests--; }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result })); return;
    }
    let asset = files[path];
    if (!asset && /^\/[a-z][a-z0-9-]*\.js$/.test(path)) asset = [path.slice(1), 'text/javascript'];
    if (!asset && /^\/fonts\/[a-z0-9-]+\.woff2$/.test(path)) asset = [path.slice(1), 'font/woff2'];
    if (req.method !== 'GET' || !asset) { res.writeHead(404); res.end('Not found'); return; }
    const [file, type] = asset;
    const contents = await readFile(fileURLToPath(new URL(`./public/${file}`, import.meta.url)));
    if (type === 'font/woff2') res.setHeader('Cache-Control', 'public, max-age=86400');
    res.writeHead(200, { 'Content-Type': type === 'font/woff2' ? type : `${type}; charset=utf-8` }); res.end(contents);
  } catch (error) {
    const status = error.code === 'ENOENT' ? 404 : error.status || 400;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: status === 404 ? 'Not found' : error instanceof SyntaxError ? 'Invalid JSON request. Check commas, quotes, and brackets.' : error.message }));
  }
});
const host = process.env.HOST || '127.0.0.1';
server.listen(Number(process.env.PORT || 3000), host, () => console.log(`PowerBI Doctor listening on ${host} port ${server.address().port}`));
