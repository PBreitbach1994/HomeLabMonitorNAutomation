import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import type { CollectorConfig, LabConfig } from '../../../config.ts';
import { FactStore } from '../../../facts.ts';
import type { CollectorContext } from '../../types.ts';

/** "Now" for every fixture: 2025-10-24T16:00:00Z. */
export const NOW = Date.parse('2025-10-24T16:00:00Z');

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), 'utf8')) as T;
}

export function makeCtx(): CollectorContext & { logs: string[] } {
  const logs: string[] = [];
  const lab: LabConfig = {
    lab: { name: 'Test lab' },
    mode: 'live',
    server: { port: 0, host: '127.0.0.1' },
    topology: {
      nodes: [
        { id: 'wan', kind: 'internet', label: 'Internet' },
        { id: 'office', kind: 'router', label: 'Office', parent: 'wan', link: { medium: '10G' } },
        { id: 'livingroom', kind: 'mesh', label: 'Living Room', parent: 'office', link: { medium: 'wifi' } },
        { id: 'nichnas', kind: 'nas', label: 'NAS', parent: 'office', link: { medium: '2.5G' } },
      ],
    },
    services: [],
    collectors: [],
  };
  return {
    lab,
    facts: new FactStore(),
    covered: new Set(),
    logs,
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
  };
}

export const cfg = (c: Partial<CollectorConfig> & { kind: string }): CollectorConfig => ({ id: c.kind, ...c });

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init });
}

export interface Call {
  url: URL;
  method: string;
  headers: Headers;
  body?: string;
}

/**
 * Stubs global fetch with a router: `handler` gets each request and returns a Response
 * (or undefined → 404). Returns the recorded calls.
 */
export function stubFetch(handler: (call: Call) => Response | Promise<Response> | undefined): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const call: Call = {
      url: new URL(String(input)),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    return (await handler(call)) ?? new Response('not found', { status: 404, statusText: 'Not Found' });
  });
  return calls;
}
