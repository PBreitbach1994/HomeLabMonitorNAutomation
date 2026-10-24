import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import type { HistoryResponse, Snapshot } from '../shared/model.ts';
import type { History } from './history.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

export interface ApiServer {
  broadcast(snapshot: Snapshot): void;
  close(): void;
}

export function startHttp(opts: {
  port: number;
  host: string;
  token?: string;
  staticDir: string;
  latest: () => Snapshot | null;
  history: History;
  log: (msg: string) => void;
}): ApiServer {
  const clients = new Set<ServerResponse>();
  const staticRoot = resolve(opts.staticDir);

  const authorized = (req: IncomingMessage, url: URL) => {
    if (!opts.token) return true;
    const header = req.headers.authorization;
    return header === `Bearer ${opts.token}` || url.searchParams.get('token') === opts.token;
  };

  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      if (!authorized(req, url)) return json(res, 401, { error: 'unauthorized' });
      switch (url.pathname) {
        case '/api/health':
          return json(res, 200, { ok: true, rev: opts.latest()?.rev ?? 0 });
        case '/api/snapshot': {
          const s = opts.latest();
          return s ? json(res, 200, s) : json(res, 503, { error: 'warming up' });
        }
        case '/api/history': {
          const key = url.searchParams.get('key') ?? '';
          const n = Math.min(360, Number(url.searchParams.get('n') ?? 360));
          const body: HistoryResponse = {
            key,
            stepMs: opts.history.stepMs,
            end: opts.history.lastSampleAt,
            points: opts.history.get(key, n),
          };
          return json(res, 200, body);
        }
        case '/api/stream': {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          });
          res.write('retry: 3000\n\n');
          const s = opts.latest();
          if (s) res.write(`event: snapshot\ndata: ${JSON.stringify(s)}\n\n`);
          clients.add(res);
          req.on('close', () => clients.delete(res));
          return;
        }
        default:
          return json(res, 404, { error: 'not found' });
      }
    }
    return serveStatic(url.pathname, res);
  }

  async function serveStatic(pathname: string, res: ServerResponse) {
    const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    let file = join(staticRoot, rel || 'index.html');
    if (!file.startsWith(staticRoot)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (!(await stat(file)).isFile()) throw new Error('not a file');
    } catch {
      file = join(staticRoot, 'index.html'); // SPA fallback
    }
    try {
      const body = await readFile(file);
      const immutable = file.includes(`${join(staticRoot, 'assets')}`);
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('UI not built — run `npm run build` (or use `npm run dev`).');
    }
  }

  const heartbeat = setInterval(() => clients.forEach((c) => c.write(': ping\n\n')), 15_000);
  server.listen(opts.port, opts.host, () => opts.log(`listening on http://${opts.host}:${opts.port}`));

  return {
    broadcast(snapshot) {
      if (!clients.size) return;
      const payload = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
      clients.forEach((c) => c.write(payload));
    },
    close() {
      clearInterval(heartbeat);
      clients.forEach((c) => c.end());
      server.close();
    },
  };
}
