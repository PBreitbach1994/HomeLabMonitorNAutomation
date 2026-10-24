import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDocker, healthFromStatus, parseDockerContainers } from '../docker.ts';
import { cfg, fixture, fixtureJson, json, serve, tempDir, testContext } from './helpers.ts';

describe('parseDockerContainers', () => {
  it('maps Engine API summaries to state + health', () => {
    const byName = Object.fromEntries(parseDockerContainers(fixtureJson('docker-containers.json'), 'switchyard').map((c) => [c.name, c]));
    expect(byName.gluetun).toEqual({ name: 'gluetun', host: 'switchyard', state: 'running', health: 'healthy' });
    expect(byName.sabnzbd).toMatchObject({ state: 'running', health: 'starting' });
    expect(byName.tdarr).toMatchObject({ state: 'running', health: 'unhealthy' });
    expect(byName.bazarr).toMatchObject({ state: 'exited', health: null });
    expect(byName.qbittorrent).toMatchObject({ state: 'paused', health: null });
    expect(byName.prowlarr).toMatchObject({ state: 'restarting' });
    expect(byName.hearr).toMatchObject({ state: 'created' });
    expect(byName.audiobookshelf).toMatchObject({ health: 'healthy' }); // from the API ≥1.52 Health field
    // Legacy link alias "/web/db" is skipped in favour of the real name.
    expect(byName.postgres).toMatchObject({ state: 'running', health: null });
    expect(byName['web/db']).toBeUndefined();
  });

  it('parses health out of Status', () => {
    expect(healthFromStatus('Up 3 hours (healthy)')).toBe('healthy');
    expect(healthFromStatus('Up 2 days (unhealthy)')).toBe('unhealthy');
    expect(healthFromStatus('Up 5 seconds (health: starting)')).toBe('starting');
    expect(healthFromStatus('Up 6 days (Paused)')).toBeNull();
    expect(healthFromStatus('Exited (137) 2 minutes ago')).toBeNull();
  });

  it('maps unknown states and rejects non-lists', () => {
    expect(parseDockerContainers([{ Names: ['/x'], State: 'removing', Status: 'Removal In Progress' }])[0].state).toBe('unknown');
    expect(() => parseDockerContainers({ message: 'denied' })).toThrow(/did not return a list/);
  });
});

describe('docker collector', () => {
  const tmp = tempDir();
  afterAll(() => tmp.cleanup());

  it('reads the Engine API over a unix socket', async () => {
    const socket = join(tmp.dir, 'docker.sock');
    const srv = await serve((req, res) => {
      if (req.url === '/containers/json?all=1') return json(res, 200, fixture('docker-containers.json'));
      json(res, 404, { message: 'page not found' });
    }, socket);
    try {
      const ctx = testContext();
      const c = createDocker(cfg('docker', { host: 'switchyard', socket, interval: 15 }), ctx);
      expect(c).toMatchObject({ kind: 'docker', domains: ['containers'], intervalMs: 15_000 });
      await c.poll(7);
      expect(ctx.facts.containers.get('sonarr')).toEqual({ name: 'sonarr', host: 'switchyard', state: 'running', health: 'healthy', at: 7 });
      expect(ctx.facts.containers.size).toBe(10);
    } finally {
      await srv.close();
    }
  });

  it('reads a socket-proxy URL and fails loudly on a 403', async () => {
    const srv = await serve((req, res) =>
      req.url === '/containers/json?all=1' ? json(res, 200, '[]') : json(res, 403, 'Forbidden'),
    );
    try {
      await createDocker(cfg('docker', { url: `${srv.url}/` }), testContext()).poll(1);
      await expect(createDocker(cfg('docker', { url: `${srv.url}/nope` }), testContext()).poll(1)).rejects.toThrow(/HTTP 403/);
    } finally {
      await srv.close();
    }
  });

  it('needs exactly one of url / socket', () => {
    expect(() => createDocker(cfg('docker', {}), testContext())).toThrow(/"url".*"socket"/);
    expect(() => createDocker(cfg('docker', { url: 'http://x:2375', socket: '/var/run/docker.sock' }), testContext())).toThrow(/not both/);
  });
});
