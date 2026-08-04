/**
 * Positions-Kontierung direkt in der Import-Vorschau (alle Waren-Importe).
 * ========================================================================
 * - «⚠ N offen» in der Vorschau ist anklickbar → klappt diese Liste auf.
 * - Jede Position hat ein Konto-Dropdown; offene Positionen amber + zuoberst.
 * - Auswahl wirkt sofort (Override im Vorschau-State); beim Import wird die
 *   Zuordnung als Artikel→Konto-Regel des Lieferanten GEMERKT (pro Mandant)
 *   und gilt beim nächsten Import automatisch.
 * - Reine Vorschau-Bearbeitung: gebucht wird erst beim Import; Beträge/WKQ
 *   bleiben unverändert (Kategorie folgt dem Konto via bestehender Logik).
 */
import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import {
  artikelKey, kontoFuerPositionMitArtikel, KONTO_OPTIONEN,
  type ArtikelKontenMapping, type WarengruppenMapping, type WarenPosition,
} from '@/lib/waren-positionen';

const fmt = (n: number) => n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Overrides der Vorschau über die gespeicherten Artikel-Zuordnungen legen. */
export function effektiveArtikelKonten(
  artikelKonten: ArtikelKontenMapping, overrides: ArtikelKontenMapping,
): ArtikelKontenMapping {
  return { ...artikelKonten, ...overrides };
}

/** Anzahl offener (nicht kontierter) Positionen — live inkl. Overrides. */
export function offeneAnzahl(
  lieferant: string,
  positionen: WarenPosition[],
  mapping: WarengruppenMapping,
  artikelKonten: ArtikelKontenMapping,
): number {
  return positionen.filter(p =>
    kontoFuerPositionMitArtikel(lieferant, p, mapping, artikelKonten).status === 'offen').length;
}

/**
 * Aufklappbare Positionsliste einer Lieferung/Rechnung mit Konto-Dropdown
 * je Position. Offene zuoberst (amber), Pfand ohne Dropdown (neutral).
 */
export function PositionenKontierungListe({ lieferant, positionen, mapping, artikelKonten, onKonto, testidPrefix }: {
  lieferant: string;
  positionen: WarenPosition[];
  mapping: WarengruppenMapping;
  /** Bereits inkl. Vorschau-Overrides (effektiveArtikelKonten). */
  artikelKonten: ArtikelKontenMapping;
  /** key = artikelKey(lieferant, p); konto = '' löscht den Override nicht — nur gültige Konten wählbar. */
  onKonto: (key: string, konto: string) => void;
  testidPrefix: string;
}) {
  // Konto-Optionen: Standardliste + alle Konten der Mandanten-Tabelle (dedupliziert).
  const optionen = useMemo(() => {
    const m = new Map(KONTO_OPTIONEN.map(o => [o.konto, o.label]));
    for (const r of mapping) {
      const k = r.konto.trim();
      if (/^\d{4}$/.test(k) && !m.has(k)) m.set(k, `${k} ${r.gruppe}`);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([konto, label]) => ({ konto, label }));
  }, [mapping]);

  const zeilen = useMemo(() => positionen
    .map((p, i) => ({ p, i, pk: kontoFuerPositionMitArtikel(lieferant, p, mapping, artikelKonten) }))
    .sort((a, b) => {
      const rang = (s: string) => s === 'offen' ? 0 : s === 'zugeordnet' ? 1 : 2; // offen zuoberst, Pfand zuunterst
      return rang(a.pk.status) - rang(b.pk.status) || a.i - b.i;
    }), [positionen, lieferant, mapping, artikelKonten]);

  return (
    <div className="ml-6 mt-0.5 mb-1 rounded border border-border/50 bg-background/60 divide-y divide-border/30"
      data-testid={`${testidPrefix}-positionen`}>
      {zeilen.map(({ p, i, pk }) => {
        const key = artikelKey(lieferant, p);
        const offen = pk.status === 'offen';
        return (
          <div key={i} className={cn('flex flex-wrap items-center gap-2 px-2 py-1 tabular-nums',
            offen && 'bg-amber-500/10')}>
            {offen && <span className="text-amber-600 dark:text-amber-400 font-medium text-[10px] uppercase">offen</span>}
            <span className="truncate max-w-[240px]" title={p.artNr ? `Art. ${p.artNr}` : undefined}>{p.bezeichnung}</span>
            <span className="text-muted-foreground truncate max-w-[120px]">{p.warengruppe || '—'}</span>
            <span className="ml-auto text-muted-foreground">CHF {fmt(p.positionspreis)}</span>
            {pk.status === 'pfand' ? (
              <span className="text-muted-foreground w-40 text-right">Pfand/Depot</span>
            ) : key ? (
              <select
                className={cn('h-6 w-40 rounded border bg-background px-1 text-[11px]',
                  offen ? 'border-amber-500/60 text-amber-700 dark:text-amber-400' : 'border-border')}
                value={pk.konto ?? ''}
                onChange={e => { if (e.target.value) onKonto(key, e.target.value); }}
                data-testid={`${testidPrefix}-konto-${i}`}>
                {offen && <option value="">Konto wählen…</option>}
                {optionen.map(o => <option key={o.konto} value={o.konto}>{o.label}</option>)}
                {pk.konto && !optionen.some(o => o.konto === pk.konto) && <option value={pk.konto}>{pk.konto}</option>}
              </select>
            ) : (
              <span className="text-muted-foreground w-40 text-right">—</span>
            )}
          </div>
        );
      })}
      <div className="px-2 py-1 text-[10px] text-muted-foreground">
        Gewählte Konten werden beim Import als Artikel-Zuordnung von {lieferant} gemerkt (gilt künftig automatisch).
      </div>
    </div>
  );
}
