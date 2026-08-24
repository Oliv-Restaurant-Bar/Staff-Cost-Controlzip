// Production SPA server — serves dist/ with fallback to index.html for all routes
import { createServer } from 'http';
import { createReadStream, statSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { createAuthorizationHandler } from './server/authorization.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DIST = join(__dirname, 'dist');
const PORT = parseInt(process.env.PORT || '3000', 10);
const handleAuthorization = createAuthorizationHandler();

const MIME = {
  '.html':  'text/html; charset=utf-8',
  '.js':    'text/javascript',
  '.mjs':   'text/javascript',
  '.css':   'text/css',
  '.json':  'application/json',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.gif':   'image/gif',
  '.svg':   'image/svg+xml',
  '.ico':   'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.webp':  'image/webp',
  '.pdf':   'application/pdf',
  '.txt':   'text/plain',
};

const cache = {
  // Assets with content-hash in filename get long cache; HTML gets no-cache
  header: (fp) => extname(fp) === '.html'
    ? 'no-cache, no-store, must-revalidate'
    : 'public, max-age=31536000, immutable',
};

const server = createServer(async (req, res) => {
  if (await handleAuthorization(req, res)) return;
  const urlPath = req.url.split('?')[0];
  const filePath = join(DIST, urlPath);

  try {
    const stat = statSync(filePath);
    if (!stat.isDirectory()) {
      const ext  = extname(filePath).toLowerCase();
      const mime = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type':  mime,
        'Cache-Control': cache.header(filePath),
      });
      createReadStream(filePath).pipe(res);
      return;
    }
  } catch {
    // File not found — fall through to SPA fallback
  }

  // SPA fallback: every non-file URL gets index.html
  res.writeHead(200, {
    'Content-Type':  'text/html; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  createReadStream(join(DIST, 'index.html')).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] Listening on port ${PORT}`);
});
