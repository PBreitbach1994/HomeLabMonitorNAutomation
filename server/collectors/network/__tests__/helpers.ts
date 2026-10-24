import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig, type CollectorConfig } from '../../../config.ts';
import { FactStore } from '../../../facts.ts';
import type { CollectorContext } from '../../types.ts';

export const FIXTURES = fileURLToPath(new URL('../__fixtures__/', import.meta.url));

export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

/** JSON fixtures; `{"type":"Buffer","data":[…]}` (what JSON.stringify makes of a Buffer) is revived. */
export function fixtureJson<T = unknown>(name: string): T {
  return JSON.parse(fixture(name), (_k, v) =>
    v && typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data) ? Buffer.from(v.data) : v,
  ) as T;
}

export function testContext(): CollectorContext & { logs: string[] } {
  const logs: string[] = [];
  return {
    lab: normalizeConfig({}),
    facts: new FactStore(),
    covered: new Set(),
    logs,
    log: {
      info: (m) => logs.push(`info: ${m}`),
      warn: (m) => logs.push(`warn: ${m}`),
      error: (m) => logs.push(`error: ${m}`),
    },
  };
}

export function cfg(kind: string, rest: Record<string, unknown> = {}): CollectorConfig {
  return { id: `test-${kind}`, kind, ...rest };
}

export type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

export interface TestServer {
  url: string;
  requests: { method: string; url: string; headers: IncomingMessage['headers']; body: string }[];
  close(): Promise<void>;
}

/** Local HTTP server on 127.0.0.1 (or a unix socket when `socketPath` is given). */
export async function serve(handler: Handler, socketPath?: string): Promise<TestServer> {
  const requests: TestServer['requests'] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => (socketPath ? server.listen(socketPath, resolve) : server.listen(0, '127.0.0.1', resolve)));
  const addr = server.address();
  const url = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : 'http://localhost';
  return {
    url,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections(); // don't wait out keep-alive sockets
      }),
  };
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

export function tempDir(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'hlc-net-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
