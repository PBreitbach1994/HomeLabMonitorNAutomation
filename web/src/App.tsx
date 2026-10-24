import { useEffect, useState } from 'react';
import { Header } from './components/Header.tsx';
import { useHashRoute, useNow, useSnapshot } from './lib/data.ts';
import { NetworkView } from './views/Network.tsx';
import { Overview } from './views/Overview.tsx';

export function App() {
  const { snap, status, lastAt, sourceKind } = useSnapshot();
  const now = useNow();
  const [route, go] = useHashRoute();
  const [kiosk, setKiosk] = useState(() => new URLSearchParams(location.search).has('kiosk'));
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    document.title = snap ? `${snap.attention ? `(${snap.attention}) ` : ''}${snap.lab.name}` : 'Home Lab Control';
  }, [snap?.attention, snap?.lab.name]);

  if (!snap) {
    return (
      <div className="app">
        <div className="loading">{status === 'offline' ? 'Can’t reach the dashboard server.' : 'Connecting to the lab…'}</div>
      </div>
    );
  }

  const select = (id: string) => {
    setSelected(id);
    go('network');
  };

  return (
    <div className="app">
      <Header
        snap={snap}
        status={status}
        lastAt={lastAt}
        now={now}
        route={route}
        go={go}
        kiosk={kiosk}
        setKiosk={setKiosk}
        sourceKind={sourceKind}
      />
      {route === 'network' ? (
        <NetworkView snap={snap} selected={selected} onSelect={setSelected} />
      ) : (
        <Overview snap={snap} now={now} kiosk={kiosk} onSelect={select} />
      )}
    </div>
  );
}
