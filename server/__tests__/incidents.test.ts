import { describe, expect, it } from 'vitest';
import { IncidentEngine, type Rule } from '../derive/incidents.ts';

const rule = (forMs = 0): Rule => ({ id: 'r', forMs, evaluate: () => [] });
const finding = (key = 'k') => ({ key, severity: 'warning' as const, title: 'T', detail: 'D', source: 's' });

describe('IncidentEngine', () => {
  it('opens after the debounce and recovers when the finding disappears', () => {
    const e = new IncidentEngine([]);
    const r = rule(20_000);
    expect(e.update([{ f: finding(), rule: r }], 0)).toEqual([]);
    expect(e.update([{ f: finding(), rule: r }], 10_000)).toEqual([]);
    const opened = e.update([{ f: finding(), rule: r }], 20_000);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ state: 'open', openedAt: 0 });
    const after = e.update([], 30_000);
    expect(after[0]).toMatchObject({ state: 'recovered', resolvedAt: 30_000 });
  });

  it('forgets a flapping condition that clears before the debounce', () => {
    const e = new IncidentEngine([]);
    const r = rule(20_000);
    e.update([{ f: finding(), rule: r }], 0);
    e.update([], 5_000);
    expect(e.update([{ f: finding(), rule: r }], 21_000)).toEqual([]);
  });

  it('records conditions that already ended as recovered (e.g. after a restart)', () => {
    const e = new IncidentEngine([]);
    const out = e.update([{ f: { ...finding(), since: 100, resolvedAt: 500 } }], 1000);
    expect(out[0]).toMatchObject({ state: 'recovered', openedAt: 100, resolvedAt: 500 });
    // and doesn't duplicate it on the next pass
    expect(e.update([{ f: { ...finding(), since: 100, resolvedAt: 500 } }], 2000)).toHaveLength(1);
  });

  it('orders open incidents by severity', () => {
    const e = new IncidentEngine([]);
    const out = e.update(
      [
        { f: { ...finding('a'), severity: 'info' } },
        { f: { ...finding('b'), severity: 'critical' } },
        { f: { ...finding('c'), severity: 'warning' } },
      ],
      0,
    );
    expect(out.map((i) => i.severity)).toEqual(['critical', 'warning', 'info']);
  });
});
