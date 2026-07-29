// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
// ziel-personalquote.ts zieht über supabase-kv den Supabase-Client (localStorage)
// herein. Für die reinen Normalisierungsfunktionen mocken wir das IO weg.
vi.mock('@/lib/supabase-kv', () => ({ kvGet: vi.fn(), kvSet: vi.fn() }));
import {
  DEFAULT_ZIEL_PERSONALQUOTE_PCT,
  normalizeZielPersonalquotePct,
  normalizeZielPersonalquoteBlob,
} from '@/lib/ziel-personalquote';

describe('ziel-personalquote — Normalisierung', () => {
  it('Default ist 35.5 %', () => {
    expect(DEFAULT_ZIEL_PERSONALQUOTE_PCT).toBe(35.5);
  });

  it('akzeptiert gültige Zahlen (auch als String mit Komma)', () => {
    expect(normalizeZielPersonalquotePct(30)).toBe(30);
    expect(normalizeZielPersonalquotePct('32,5')).toBe(32.5);
    expect(normalizeZielPersonalquotePct('40')).toBe(40);
  });

  it('fällt bei Unsinn/Grenzverletzung auf den Default zurück', () => {
    expect(normalizeZielPersonalquotePct(null)).toBe(35.5);
    expect(normalizeZielPersonalquotePct('abc')).toBe(35.5);
    expect(normalizeZielPersonalquotePct(-5)).toBe(35.5);
    expect(normalizeZielPersonalquotePct(150)).toBe(35.5);
  });

  it('normalizeBlob liest pct aus Objekt oder blankem Wert', () => {
    expect(normalizeZielPersonalquoteBlob({ pct: 28 }).pct).toBe(28);
    expect(normalizeZielPersonalquoteBlob(28).pct).toBe(28);
    expect(normalizeZielPersonalquoteBlob(null).pct).toBe(35.5);
    expect(normalizeZielPersonalquoteBlob({ pct: 28, updatedAt: 'x' }).updatedAt).toBe('x');
  });
});

describe('PK-Budget-Formel = ZielQuote × Netto-Umsatz-Budget', () => {
  it('Juli-Beispiel: 35.5 % × 250 000 = 88 750', () => {
    const pct = 35.5;
    const umsatzBudget = 250_000;
    const pkBudget = Math.round((pct / 100) * umsatzBudget * 100) / 100;
    expect(pkBudget).toBe(88_750);
  });

  it('Abweichung Hochrechnung − Budget (Juli-Beispiel)', () => {
    const budget = 88_750;
    const hochrechnung = 118_531;
    expect(hochrechnung - budget).toBe(29_781);
  });

  it('ohne Umsatz-Budget (0) gibt es kein PK-Budget', () => {
    const umsatzBudget = 0;
    const pkBudget = umsatzBudget > 0 ? (35.5 / 100) * umsatzBudget : null;
    expect(pkBudget).toBeNull();
  });
});
