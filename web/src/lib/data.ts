import { useEffect, useRef, useState } from 'react';
import type { HistoryResponse, Snapshot } from '../../../shared/model.ts';

export type ConnStatus = 'connecting' | 'live' | 'offline';

export interface DataSource {
  kind: 'server' | 'browser-demo';
  subscribe(onSnapshot: (s: Snapshot) => void, onStatus: (s: ConnStatus) => void): () => void;
  history(key: string, n?: number): Promise<HistoryResponse>;
}

const token = new URLSearchParams(location.search).get('token');
const withToken = (path: string) => {
  const url = new URL(path, location.href);
  if (token) url.searchParams.set('token', token);
  return url.toString();
};

function serverSource(): DataSource {
  return {
    kind: 'server',
    subscribe(onSnapshot, onStatus) {
      onStatus('connecting');
      const es = new EventSource(withToken('api/stream'));
      es.addEventListener('snapshot', (e) => {
        onSnapshot(JSON.parse((e as MessageEvent<string>).data) as Snapshot);
        onStatus('live');
      });
      es.onerror = () => onStatus(es.readyState === EventSource.CLOSED ? 'offline' : 'connecting');
      return () => es.close();
    },
    async history(key, n = 360) {
      const res = await fetch(withToken(`api/history?key=${encodeURIComponent(key)}&n=${n}`));
      if (!res.ok) throw new Error(`history ${res.status}`);
      return (await res.json()) as HistoryResponse;
    },
  };
}

/** Runs the simulator + derivations in the page — used for the static demo build or `?demo`. */
function browserDemoSource(): DataSource {
  const demo = import('./browserDemo.ts').then((m) => m.createBrowserDemo());
  return {
    kind: 'browser-demo',
    subscribe(onSnapshot, onStatus) {
      onStatus('connecting');
      let stop: (() => void) | undefined;
      let cancelled = false;
      void demo.then((d) => {
        if (cancelled) return;
        stop = d.subscribe((s) => {
          onSnapshot(s);
          onStatus('live');
        });
      });
      return () => {
        cancelled = true;
        stop?.();
      };
    },
    history: (key, n) => demo.then((d) => d.history(key, n)),
  };
}

const wantsDemo = import.meta.env.VITE_STATIC_DEMO === '1' || new URLSearchParams(location.search).has('demo');
export const source: DataSource = wantsDemo ? browserDemoSource() : serverSource();

export function useSnapshot() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [lastAt, setLastAt] = useState<number | null>(null);
  useEffect(
    () =>
      source.subscribe(
        (s) => {
          setSnap(s);
          setLastAt(Date.now());
        },
        setStatus,
      ),
    [],
  );
  return { snap, status, lastAt, sourceKind: source.kind };
}

/** Fetches a history series and refreshes it every `refreshMs`. */
export function useHistory(keys: string[], n = 360, refreshMs = 10_000) {
  const [data, setData] = useState<Record<string, HistoryResponse>>({});
  const keyStr = keys.join('|');
  const latest = useRef(keyStr);
  latest.current = keyStr;
  useEffect(() => {
    if (!keyStr) return;
    let alive = true;
    const load = () =>
      Promise.all(keyStr.split('|').map((k) => source.history(k, n)))
        .then((rs) => {
          if (alive && latest.current === keyStr) setData(Object.fromEntries(rs.map((r) => [r.key, r])));
        })
        .catch(() => undefined);
    void load();
    const t = setInterval(load, refreshMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [keyStr, n, refreshMs]);
  return data;
}

/** A ticking clock for relative times ("4s ago"). */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function useHashRoute(): [string, (r: string) => void] {
  const read = () => location.hash.replace(/^#\/?/, '').split('?')[0] || 'overview';
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [route, (r) => (location.hash = `#/${r === 'overview' ? '' : r}`)];
}
