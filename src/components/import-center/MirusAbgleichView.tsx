/**
 * MirusAbgleichView — Kontroll-Ansicht «MIRUS ↔ App Ist-Abgleich»
 * ================================================================
 * Vergleicht die persistierten MIRUS-Roh-Tageswerte (mirus-ist-werte, SSOT
 * der Stempeluhr) mit dem App-Ist (actual_hours). Mandantengetrennt, mit
 * Woche/Monat/Jahr-Steuerung.
 *
 *  - Zeigt nur echte Abweichungen |Δ| > 0.05 h; leer statt 0.
 *  - Ausnahme-MA (erfassungsart MANUELL, z.B. Lokaj Mendim / Ramadani Mejdi
 *    sowie App-eigene Aushilfen) werden ausgegraut als «Ausnahme» markiert.
 *  - Kopf: Summe der in der App fehlenden Stunden (ohne Ausnahmen).
 *  - Reine Anzeige — schreibt NICHTS.
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ZeitraumSteuerung } from '@/components/ZeitraumSteuerung';
import { initialZeitraum, zeitraumGrenzen, type Zeitraum } from '@/lib/zeitraum';
import { loadMirusIstWerteForMonths } from '@/lib/mirus-ist-werte';
import { buildMirusAbgleich, type AbgleichErgebnis } from '@/lib/mirus-abgleich';
import { loadActualHoursForMonth, loadEmployees } from '@/lib/supabase-db';
import type { TenantId } from '@/contexts/TenantContext';
import { cn } from '@/lib/utils';

function monateImBereich(von: string, bis: string): string[] {
  const out: string[] = [];
  let [y, m] = [Number(von.slice(0, 4)), Number(von.slice(5, 7))];
  const ende = bis.slice(0, 7);
  for (let i = 0; i < 24; i++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    out.push(key);
    if (key >= ende) break;
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

const fmtH = (h: number | null) => (h == null ? '–' : h.toFixed(2));
const fmtTag = (iso: string) => {
  const d = new Date(iso + 'T00:00:00');
  return `${['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][d.getDay()]} ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
};

export function MirusAbgleichView({ tenantId }: { tenantId: TenantId }) {
  const [zeitraum, setZeitraum] = useState<Zeitraum>(() => initialZeitraum('woche'));
  const [ergebnis, setErgebnis] = useState<AbgleichErgebnis | null>(null);
  const [laden, setLaden] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [hatWerte, setHatWerte] = useState(false);

  const { from, to } = useMemo(() => zeitraumGrenzen(zeitraum), [zeitraum]);

  useEffect(() => {
    let stale = false;
    setLaden(true); setFehler(null); setErgebnis(null);
    (async () => {
      const monate = monateImBereich(from, to);
      const [werte, employees, ...istMonate] = await Promise.all([
        loadMirusIstWerteForMonths(tenantId, monate),
        loadEmployees(tenantId),
        ...monate.map(m => loadActualHoursForMonth(new Date(`${m}-15T00:00:00`), tenantId)),
      ]);
      if (stale) return;
      const appIst: Record<string, { hours: number; absenceType?: string | null }> = {};
      for (const blob of istMonate) Object.assign(appIst, blob ?? {});
      const namen: Record<string, string> = {};
      const ausnahmen = new Set<string>();
      for (const e of employees ?? []) {
        namen[e.id] = e.name;
        if (e.erfassungsart === 'MANUELL') ausnahmen.add(e.id);
      }
      setHatWerte(Object.keys(werte).length > 0);
      setErgebnis(buildMirusAbgleich({ mirusWerte: werte, appIst, namen, ausnahmen, von: from, bis: to }));
    })().catch(e => {
      if (!stale) setFehler(e instanceof Error ? e.message : String(e));
    }).finally(() => { if (!stale) setLaden(false); });
    return () => { stale = true; };
  }, [tenantId, from, to]);

  return (
    <div className="space-y-3" data-testid="mirus-abgleich">
      <div className="flex flex-wrap items-center gap-3">
        <ZeitraumSteuerung value={zeitraum} onChange={setZeitraum} granularitaeten={['woche', 'monat', 'jahr']} />
        {laden && <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />}
        {ergebnis && ergebnis.fehlendeStunden > 0 && (
          <Badge variant="destructive" className="text-xs" data-testid="fehlende-stunden">
            In der App fehlend: {ergebnis.fehlendeStunden.toFixed(2)} h
          </Badge>
        )}
        {ergebnis && ergebnis.fehlendeStunden === 0 && !laden && (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
            <CheckCircle2 className="h-3.5 w-3.5" /> Keine fehlenden Stunden im Zeitraum
          </span>
        )}
      </div>

      {fehler && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" /> {fehler}
        </div>
      )}

      {!laden && !fehler && !hatWerte && (
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          Für diesen Zeitraum sind noch keine MIRUS-Rohwerte gespeichert — sie werden
          bei jedem MIRUS-Import (Dienstplan) automatisch abgelegt. Für ältere Wochen
          den MIRUS-Export einfach erneut importieren (Vorschau + Rückgängig vorhanden).
        </div>
      )}

      {ergebnis && ergebnis.rows.length > 0 && (
        <div className="border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Mitarbeiter</th>
                <th className="px-3 py-2 font-medium">Tag</th>
                <th className="px-3 py-2 font-medium text-right">MIRUS-Std</th>
                <th className="px-3 py-2 font-medium text-right">App-Ist-Std</th>
                <th className="px-3 py-2 font-medium text-right">Δ</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {ergebnis.rows.map(r => (
                <tr key={`${r.employeeId}|${r.date}`}
                  className={cn('border-b last:border-0', r.ausnahme && 'opacity-50')}
                  data-testid={`abgleich-${r.employeeId}-${r.date}`}>
                  <td className="px-3 py-1.5">{r.name}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{fmtTag(r.date)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtH(r.mirusStd)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtH(r.appStd)}</td>
                  <td className={cn('px-3 py-1.5 text-right tabular-nums font-medium',
                    !r.ausnahme && r.delta > 0 && 'text-destructive',
                    !r.ausnahme && r.delta < 0 && 'text-emerald-700')}>
                    {r.delta > 0 ? '+' : ''}{r.delta.toFixed(2)}
                  </td>
                  <td className="px-3 py-1.5">
                    {r.ausnahme && <Badge variant="outline" className="text-[10px]">Ausnahme</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {ergebnis && ergebnis.rows.length === 0 && hatWerte && !laden && (
        <p className="text-xs text-muted-foreground">Keine Abweichungen &gt; 0.05 h im Zeitraum.</p>
      )}
    </div>
  );
}
