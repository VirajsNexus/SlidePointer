// server.js — run: node server.js — open: http://localhost:3000
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = 3000;
const ROOT = path.join(__dirname, 'public');
const MIME = {
  '.html':'text/html; charset=utf-8',
  '.css' :'text/css',
  '.js'  :'application/javascript',
  '.png' :'image/png',
  '.jpg' :'image/jpeg',
  '.ico' :'image/x-icon',
};

http.createServer((req, res) => {
  const safe = path.join(ROOT, req.url === '/' ? 'index.html' : req.url);
  if (!safe.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(safe, (err, data) => {
    if (err) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(safe)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log('\n  LaserPresent v3 running!');
  console.log('  Open → http://localhost:' + PORT);
  console.log('  Ctrl+C to stop\n');
});
