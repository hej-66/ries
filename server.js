'use strict';

const express = require('express');
const path = require('path');

const ROOT_DIR = __dirname;
const BLOCKED_TOP_LEVEL = new Set([
  'server.js',
  'package.json',
  'package-lock.json',
  'metadata.json',
  'node_modules',
  'tools',
]);

function createApp() {
  const app = express();

  app.disable('x-powered-by');

  // Block internal/server files and dotfiles from being served statically
  app.use((req, res, next) => {
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(req.path);
    } catch {
      return res.status(400).send('Bad Request');
    }

    const segments = decodedPath.split('/').filter(Boolean);
    if (segments.some((seg) => seg.startsWith('.') || seg === '..')) {
      return res.status(404).send('Not Found');
    }
    if (segments.length > 0 && BLOCKED_TOP_LEVEL.has(segments[0])) {
      return res.status(404).send('Not Found');
    }
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Compatibility alias for docs referencing integral.html
  app.get('/integral.html', (_req, res) => {
    res.sendFile(path.join(ROOT_DIR, 'index.html'));
  });

  app.use(
    express.static(ROOT_DIR, {
      index: 'index.html',
      dotfiles: 'ignore',
      etag: true,
      maxAge: 0,
    })
  );

  return app;
}

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  const HOST = '0.0.0.0';
  const app = createApp();
  app.listen(PORT, HOST, () => {
    console.log(`RIES static server listening on http://${HOST}:${PORT}`);
  });
}

module.exports = { createApp };
