import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

function corsProxyPlugin(): Plugin {
  return {
    name: 'cors-proxy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url!, `http://localhost`);
        if (url.pathname !== '/proxy') return next();

        const target = url.searchParams.get('url');
        if (!target) {
          res.writeHead(400);
          res.end('Missing ?url=');
          return;
        }

        let targetUrl: URL;
        try {
          targetUrl = new URL(target);
        } catch {
          res.writeHead(400);
          res.end('Invalid url');
          return;
        }

        const lib = targetUrl.protocol === 'https:' ? https : http;
        const headers: Record<string, string> = { 'User-Agent': 'gapless-dev-proxy/1.0' };
        if (req.headers.range) headers['Range'] = req.headers.range;

        const proxyReq = lib.get(target, { headers }, (proxyRes) => {
          const resHeaders: Record<string, string> = {
            'Content-Type': proxyRes.headers['content-type'] ?? 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=86400',
          };
          if (proxyRes.headers['content-length']) resHeaders['Content-Length'] = proxyRes.headers['content-length'];
          if (proxyRes.headers['content-range']) resHeaders['Content-Range'] = proxyRes.headers['content-range'];
          if (proxyRes.headers['accept-ranges']) resHeaders['Accept-Ranges'] = proxyRes.headers['accept-ranges'];

          res.writeHead(proxyRes.statusCode ?? 200, resHeaders);
          proxyRes.pipe(res);
        });
        proxyReq.on('error', (err) => {
          res.writeHead(502);
          res.end(err.message);
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), corsProxyPlugin()],
  resolve: {
    alias: {
      'gapless.js': path.resolve(__dirname, '../src/index.ts'),
    },
  },
});
