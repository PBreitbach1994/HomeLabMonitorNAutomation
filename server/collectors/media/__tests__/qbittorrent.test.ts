import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQbittorrent, parseQbitTorrents, parseQbitTransfer, qbitStatus, sessionCookie } from '../qbittorrent.ts';
import { NOW, cfg, fixture, json, makeCtx, stubFetch } from './helpers.ts';

afterEach(() => vi.unstubAllGlobals());

describe('parseQbitTransfer', () => {
  it('converts bytes/s to bits/s', () => {
    expect(parseQbitTransfer(fixture('qbittorrent-transfer.json'))).toEqual({ downBps: 5242880 * 8, upBps: 1310720 * 8 });
  });
});

describe('parseQbitTorrents', () => {
  const { queue, history } = parseQbitTorrents(fixture('qbittorrent-torrents.json'), NOW);

  it('upper-cases hashes (the *arr downloadId) and splits on progress', () => {
    expect(queue.map((t) => [t.id.slice(0, 6), t.status])).toEqual([
      ['A1B2C3', 'downloading'],
      ['BBBBBB', 'downloading'],
      ['CCCCCC', 'paused'],
      ['DDDDDD', 'downloading'],
      ['EEEEEE', 'failed'],
      ['111111', 'queued'],
    ]);
    // History is newest completion first.
    expect(history.map((t) => [t.id.slice(0, 6), t.status])).toEqual([
      ['8C2127', 'completed'],
      ['333333', 'completed'],
      ['FFFFFF', 'failed'],
      ['222222', 'completed'],
    ]);
  });

  it('fills progress, size, speed, timestamps and messages', () => {
    const furiosa = queue[0];
    expect(furiosa).toMatchObject({
      id: 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678',
      name: 'Furiosa.A.Mad.Max.Saga.2024.1080p.WEB-DL.DDP5.1.Atmos.H.264-FLUX',
      progress: 0.3712,
      sizeBytes: 7516192768,
      speedBps: 4194304 * 8,
      category: 'radarr',
      updatedAt: NOW,
    });
    expect(queue[1].message).toMatch(/stalled/i);
    expect(queue[1].updatedAt).toBe(1761200000 * 1000); // stalled: last activity, not now
    expect(queue[3].message).toMatch(/metadata/i);
    expect(queue[3].sizeBytes).toBeUndefined();
    expect(queue[4].message).toMatch(/error/i);

    const pack = history[0];
    expect(pack.id).toBe('8C212779B4ABDE7C6BC608063A0D008B7E40CE32');
    expect(pack.updatedAt).toBe(Date.parse('2025-10-24T14:30:00Z'));
    expect(pack.progress).toBe(1);
    expect(pack.speedBps).toBeUndefined();
    expect(history[2].message).toMatch(/missing/i);
  });

  it('caps history', () => {
    expect(parseQbitTorrents(fixture('qbittorrent-torrents.json'), NOW, { historyLimit: 2 }).history).toHaveLength(2);
  });
});

describe('qbitStatus', () => {
  it.each([
    ['pausedDL', 0.5, 'paused'],
    ['stoppedDL', 0.5, 'paused'],
    ['queuedDL', 0, 'queued'],
    ['checkingDL', 0.2, 'verifying'],
    ['checkingUP', 1, 'verifying'],
    ['forcedUP', 1, 'completed'],
    ['pausedUP', 1, 'completed'],
    ['stalledUP', 1, 'completed'],
    ['checkingResumeData', 1, 'completed'],
    ['checkingResumeData', 0.4, 'queued'],
    ['unknown', 0, 'queued'],
  ] as const)('%s (progress %s) → %s', (state, progress, expected) => {
    expect(qbitStatus(state, progress)).toBe(expected);
  });
});

describe('sessionCookie', () => {
  it('keeps name=value pairs only', () => {
    const h = new Headers();
    h.append('Set-Cookie', 'SID=abc123; HttpOnly; SameSite=Strict; path=/');
    expect(sessionCookie(h)).toBe('SID=abc123');
    const h2 = new Headers();
    h2.append('Set-Cookie', 'QBT_SID_8080=xyz; HttpOnly; path=/');
    expect(sessionCookie(h2)).toBe('QBT_SID_8080=xyz');
  });
});

describe('createQbittorrent', () => {
  const base = { kind: 'qbittorrent', id: 'qbit', url: 'http://switchyard:8081', username: 'admin', password: 'hunter2-long', host: 'switchyard' };

  it('requires a password when a username is set', () => {
    expect(() => createQbittorrent(cfg({ ...base, password: '' }), makeCtx())).toThrow(/password/);
    expect(() => createQbittorrent(cfg({ kind: 'qbittorrent', url: 'http://q:8081' }), makeCtx())).not.toThrow();
  });

  it('logs in, sends the cookie, and re-logs in once on 403', async () => {
    let valid = ''; // the session id the "server" currently accepts
    let logins = 0;
    const calls = stubFetch(({ url, method, headers, body }) => {
      if (url.pathname === '/api/v2/auth/login') {
        expect(method).toBe('POST');
        expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
        expect(headers.get('origin')).toBe('http://switchyard:8081');
        expect(new URLSearchParams(body).get('password')).toBe('hunter2-long');
        valid = `sid${++logins}`;
        return new Response('Ok.', { headers: { 'Set-Cookie': `SID=${valid}; HttpOnly; path=/` } });
      }
      if (headers.get('cookie') !== `SID=${valid}`) return new Response('Forbidden', { status: 403, statusText: 'Forbidden' });
      if (url.pathname === '/api/v2/transfer/info') return json(fixture('qbittorrent-transfer.json'));
      if (url.pathname === '/api/v2/torrents/info') return json(fixture('qbittorrent-torrents.json'));
      return undefined;
    });
    const ctx = makeCtx();
    const c = createQbittorrent(cfg(base), ctx);
    await c.poll(NOW);
    expect(logins).toBe(1); // both parallel requests share one login
    const f = ctx.facts.downloads.get('qbit')!;
    expect(f).toMatchObject({ client: 'qbittorrent', protocol: 'torrent', host: 'switchyard', downBps: 5242880 * 8, upBps: 1310720 * 8 });
    expect(f.queue).toHaveLength(6);
    expect(f.history).toHaveLength(4);

    // qBittorrent restarts and forgets the session: both requests 403, one re-login, retry succeeds.
    valid = 'restarted';
    await c.poll(NOW + 5000);
    expect(logins).toBe(2);
    expect(calls.filter((x) => x.url.pathname === '/api/v2/auth/login')).toHaveLength(2);
    expect(ctx.facts.downloads.get('qbit')!.at).toBe(NOW + 5000);
  });

  it('reports a failed login without the password', async () => {
    stubFetch(() => new Response('Fails.', { status: 200 }));
    const c = createQbittorrent(cfg(base), makeCtx());
    const err = (await c.poll(NOW).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/login failed/);
    expect(err.message).not.toContain('hunter2-long');
  });
});
