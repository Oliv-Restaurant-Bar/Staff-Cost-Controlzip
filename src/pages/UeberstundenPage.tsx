/**
 * Überstunden-Aufstellung pro FIX-Mitarbeiter (je Mandant)
 * ─────────────────────────────────────────────────────────
 * Woche/Monat/Laufend (ab Juli 2026) je Fix-MA; Ist = MIRUS-Stunden +
 * Absenz-Gutschriften (Ferien/Krank/Unfall = Pensum×8.4 h/Tag, Frei = 0).
 * Manuelle Absenz-Erfassung mit Vorschau, striktem Speichern und einstufigem
 * Rückgängig. «leer statt 0»: Wochen ohne Mirus-/Absenz-Datenbasis bleiben leer.
 * Nicht zuordenbare Mirus-Namen (Park-Store) werden als Hinweis angezeigt.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTenant } from '@/contexts/TenantContext';
import {
  ladeUeberstundenJahr, ladeUeAbsenzenStrict, speichereUeAbsenzen, UeAbsenzenKonflikt,
  UE_ABSENZ_LABELS, UEBERSTUNDEN_START, VOLLZEIT_WOCHE_H,
  type UeJahresDaten, type UeAbsenzTyp, type UeAbsenzenBlob,
} from '@/lib/ueberstunden';
import { fetchOpenParkedEntries, type ParkedHoursEntry } from '@/lib/mirus-open-hours-store';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';

const MONATE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

function fmtH(v: number | null | undefined): string {
  if (v === null || v === undefined) return '–';
  return `${v.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`;
}
function saldoClass(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'text-muted-foreground';
  if (v > 0.05) return 'text-red-600 font-medium';
  if (v < -0.05) return 'text-blue-600';
  return '';
}

export default function UeberstundenPage() {
  const { tenantId, tenantKey } = useTenant();
  const { toast } = useToast();
  const heute = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [daten, setDaten] = useState<UeJahresDaten | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [parked, setParked] = useState<ParkedHoursEntry[]>([]);
  const [selEmp, setSelEmp] = useState<string | null>(null);
  /** Zellen-Klick: Montag der ausgewählten KW (Wochen-Detail genau dieser Woche). */
  const [selWeek, setSelWeek] = useState<string | null>(null);
  /** Standard-Ansicht = Wochenübersicht (MA × KW); Monatsübersicht per Umschalter. */
  const [ansicht, setAnsicht] = useState<'woche' | 'monat'>('woche');

  // Absenz-Editor (staged → Vorschau → Speichern; einstufiges Rückgängig)
  const [editMonat, setEditMonat] = useState(() => new Date().getMonth() + 1);
  const [staged, setStaged] = useState<Record<string, UeAbsenzTyp | ''>>({});
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true); setLoadError(false);
    try {
      const [d, p] = await Promise.all([
        ladeUeberstundenJahr(tenantId, tenantKey, year, heute),
        fetchOpenParkedEntries(tenantId).catch(() => [] as ParkedHoursEntry[]),
      ]);
      if (d === null) { setLoadError(true); setDaten(null); }
      else setDaten(d);
      setParked(p);
    } catch (e) {
      console.error('[Ueberstunden] Laden fehlgeschlagen:', e);
      setLoadError(true); setDaten(null);
    } finally {
      setLoading(false);
    }
  }, [tenantId, tenantKey, year, heute]);

  useEffect(() => { void reload(); setStaged({}); setSelEmp(null); setSelWeek(null); }, [reload]);

  const erg = daten?.ergebnis ?? null;
  /** Gerechnete MA (mit Eintrittsdatum) vs. Hinweis-Liste (ohne Eintritt). */
  const gerechnet = useMemo(() => (erg?.mitarbeiter ?? []).filter(m => !m.ohneEintritt), [erg]);
  const ohneEintritt = useMemo(() => (erg?.mitarbeiter ?? []).filter(m => m.ohneEintritt), [erg]);
  /** Wochen-Spalten (alle MA haben identische Wochenliste): nur bis heute. */
  const wochenSpalten = useMemo(
    () => (gerechnet[0]?.wochen ?? []).filter(w => w.monday <= heute).map(w => ({ label: w.label, monday: w.monday })),
    [gerechnet, heute],
  );
  /** Monats-Spalten: ab Konto-Start (2026 → Jul–Dez), sonst ganzes Jahr. */
  const startMonatIdx = year === Number(UEBERSTUNDEN_START.slice(0, 4)) ? Number(UEBERSTUNDEN_START.slice(5, 7)) - 1 : 0;
  const sel = erg?.mitarbeiter.find(m => m.id === selEmp) ?? null;
  const selWoche = (sel && selWeek && sel.wochen.find(w => w.monday === selWeek)) || null;
  /** Import-Ampel je KW: Anteil Tage (≤ heute) mit Mirus-Datenbasis (0..1). */
  const importAnteil = useCallback((monday: string): number => {
    const tage = daten?.tageMitDaten;
    if (!tage) return 0;
    let mit = 0, gesamt = 0;
    for (let i = 0; i < 7; i++) {
      // TZ-sicher: lokales Datum formatieren, NIE via toISOString (UTC-Shift).
      const dt = new Date(monday + 'T12:00:00'); dt.setDate(dt.getDate() + i);
      const day = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      if (day > heute) break;
      gesamt++;
      if (tage.has(day)) mit++;
    }
    return gesamt === 0 ? 0 : mit / gesamt;
  }, [daten, heute]);
  /** Total je KW-Spalte (Summe der gerechneten MA; null = keiner hat Werte). */
  const wochenTotal = useCallback((monday: string): number | null => {
    let tot: number | null = null;
    for (const m of gerechnet) {
      const s = m.wochen.find(w => w.monday === monday)?.saldo ?? null;
      if (s !== null) tot = (tot ?? 0) + s;
    }
    return tot;
  }, [gerechnet]);
  const selAbsenzen = (selEmp && daten?.absenzen.entries[selEmp]) || {};

  const editDays = useMemo(() => {
    const n = new Date(year, editMonat, 0).getDate();
    return Array.from({ length: n }, (_, i) => `${year}-${String(editMonat).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`);
  }, [year, editMonat]);

  const changes = useMemo(() => {
    const list: Array<{ date: string; von: UeAbsenzTyp | undefined; zu: UeAbsenzTyp | '' }> = [];
    for (const [date, zu] of Object.entries(staged)) {
      const von = selAbsenzen[date];
      if ((zu || undefined) !== von) list.push({ date, von, zu });
    }
    return list.sort((a, b) => a.date.localeCompare(b.date));
  }, [staged, selAbsenzen]);

  async function speichern() {
    if (!selEmp || changes.length === 0 || saving) return;
    setSaving(true);
    try {
      // Frisch UND STRIKT laden (Lesefehler wirft — nie leeren Pseudo-Stand
      // als Basis nehmen); updatedAt = Stale-Wache gegen parallele Tabs.
      const remote = await ladeUeAbsenzenStrict(tenantKey, year);
      const prevEntries = JSON.parse(JSON.stringify(remote.entries)) as UeAbsenzenBlob['entries'];
      const empRec = { ...(remote.entries[selEmp] ?? {}) };
      for (const c of changes) {
        if (c.zu === '') delete empRec[c.date];
        else empRec[c.date] = c.zu;
      }
      const nextEntries = { ...remote.entries, [selEmp]: empRec };
      if (Object.keys(empRec).length === 0) delete nextEntries[selEmp];
      await speichereUeAbsenzen(tenantKey, { year, entries: nextEntries, prev: prevEntries }, remote.updatedAt);
      setStaged({});
      toast({ title: 'Absenzen gespeichert', description: `${changes.length} Änderung(en) übernommen.` });
      await reload();
    } catch (e) {
      console.error('[Ueberstunden] Speichern fehlgeschlagen:', e);
      if (e instanceof UeAbsenzenKonflikt) {
        toast({ title: 'Konflikt', description: 'Absenzen wurden zwischenzeitlich geändert — Ansicht wird neu geladen, bitte erneut speichern.', variant: 'destructive' });
        await reload();
      } else {
        toast({ title: 'Speichern fehlgeschlagen', description: String(e), variant: 'destructive' });
      }
    } finally {
      setSaving(false);
    }
  }

  async function rueckgaengig() {
    if (saving) return;
    setSaving(true);
    try {
      const remote = await ladeUeAbsenzenStrict(tenantKey, year);
      if (!remote.prev) {
        toast({ title: 'Nichts rückgängig zu machen', description: 'Kein gespeicherter Vorzustand vorhanden.' });
        return;
      }
      // Undo nur auf den Stand, den die Ansicht zeigt — nicht blind einen
      // fremden, zwischenzeitlich gespeicherten Stand zurückrollen.
      if ((daten?.absenzen.updatedAt ?? undefined) !== (remote.updatedAt ?? undefined)) {
        toast({ title: 'Konflikt', description: 'Absenzen wurden zwischenzeitlich geändert — Ansicht wird neu geladen. Rückgängig danach erneut prüfen.', variant: 'destructive' });
        await reload();
        return;
      }
      await speichereUeAbsenzen(tenantKey, { year, entries: remote.prev, prev: remote.entries }, remote.updatedAt);
      setStaged({});
      toast({ title: 'Letztes Speichern rückgängig gemacht' });
      await reload();
    } catch (e) {
      console.error('[Ueberstunden] Rückgängig fehlgeschlagen:', e);
      toast({ title: 'Rückgängig fehlgeschlagen', description: String(e), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  const jahre = [2026, 2027, 2028].filter(y => y <= new Date().getFullYear() + 1);

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-6xl">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Überstunden (Fix-Mitarbeiter)</h1>
        <select
          className="border rounded px-2 py-1 text-sm bg-background"
          value={year}
          onChange={e => setYear(Number(e.target.value))}
          data-testid="select-jahr"
        >
          {jahre.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <span className="text-xs text-muted-foreground">
          Laufendes Konto ab Juli 2026 · Soll = Pensum × {VOLLZEIT_WOCHE_H} h/Woche · Stand bis heute
        </span>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Lade…</p>}
      {loadError && !loading && (
        <p className="text-sm text-red-600">Daten konnten nicht geladen werden (Verbindung prüfen und neu laden).</p>
      )}

      {erg && !loading && (
        <>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <span>{ansicht === 'woche' ? 'Wochen-Saldi' : 'Monats-Saldi'} &amp; laufendes Konto</span>
                  <span className="inline-flex rounded border overflow-hidden text-xs font-normal">
                    <button
                      className={`px-2 py-0.5 ${ansicht === 'woche' ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted'}`}
                      onClick={() => setAnsicht('woche')}
                      data-testid="button-ansicht-woche"
                    >Wochen</button>
                    <button
                      className={`px-2 py-0.5 border-l ${ansicht === 'monat' ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted'}`}
                      onClick={() => setAnsicht('monat')}
                      data-testid="button-ansicht-monat"
                    >Monate</button>
                  </span>
                </span>
                <span data-testid="text-total-laufend" className={saldoClass(erg.totalLaufend)}>
                  Total laufend: {fmtH(erg.totalLaufend)}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {gerechnet.length === 0 ? (
                <p className="text-sm text-muted-foreground">Keine Fix-Mitarbeiter im gewählten Jahr.</p>
              ) : ansicht === 'woche' ? (
                <table className="text-xs w-full">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="text-left py-1 pr-2">Mitarbeiter</th>
                      <th className="text-right pr-2">Pensum</th>
                      {wochenSpalten.map(w => {
                        const anteil = importAnteil(w.monday);
                        return (
                          <th key={w.monday} className="text-right px-1 whitespace-nowrap">
                            <div>{w.label}</div>
                            <div className="font-normal">{w.monday.slice(8, 10)}.{w.monday.slice(5, 7)}.</div>
                            {/* Import-Ampel: Anteil Tage mit Mirus-Import (voll grün / teilweise / grau) */}
                            <div
                              className="mt-0.5 h-1 w-full rounded bg-muted overflow-hidden"
                              title={`Mirus-Import: ${Math.round(anteil * 100)} % der Tage`}
                              data-testid={`ampel-${w.monday}`}
                              data-anteil={Math.round(anteil * 100)}
                            >
                              <div
                                className={`h-full ${anteil >= 0.999 ? 'bg-green-500' : 'bg-amber-500'}`}
                                style={{ width: `${Math.round(anteil * 100)}%` }}
                              />
                            </div>
                          </th>
                        );
                      })}
                      <th className="text-right pl-2 font-semibold">Laufend</th>
                      <th className="text-right pl-2 font-semibold">ÜStd-Kosten</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gerechnet.map(m => {
                      const byMonday = new Map(m.wochen.map(w => [w.monday, w]));
                      return (
                        <tr
                          key={m.id}
                          className={`border-t cursor-pointer hover:bg-muted/50 ${selEmp === m.id ? 'bg-muted/60' : ''}`}
                          onClick={() => { setSelEmp(m.id); setSelWeek(null); setStaged({}); }}
                          data-testid={`row-emp-${m.id}`}
                        >
                          <td className="py-1 pr-2 whitespace-nowrap">{m.name}</td>
                          <td className="text-right pr-2">{Math.round(m.wochenSollH / VOLLZEIT_WOCHE_H * 100)}%</td>
                          {wochenSpalten.map(ws => {
                            const s = byMonday.get(ws.monday)?.saldo ?? null;
                            const aktiv = selEmp === m.id && selWeek === ws.monday;
                            return (
                              <td
                                key={ws.monday}
                                className={`text-right px-1 tabular-nums cursor-pointer ${saldoClass(s)} ${aktiv ? 'ring-1 ring-primary rounded' : ''}`}
                                onClick={e => { e.stopPropagation(); setSelEmp(m.id); setSelWeek(ws.monday); setStaged({}); }}
                                data-testid={`cell-${m.id}-${ws.monday}`}
                              >
                                {s === null ? '–' : s.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
                              </td>
                            );
                          })}
                          <td className={`text-right pl-2 tabular-nums font-semibold ${saldoClass(m.laufend)}`}>
                            {fmtH(m.laufend)}
                          </td>
                          <td className="text-right pl-2 tabular-nums" data-testid={`kosten-${m.id}`}>
                            {m.kosten === null ? '–' : `${m.kosten.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                          </td>
                        </tr>
                      );
                    })}
                    {/* Total-Zeile: Summe aller gerechneten Fix-MA je KW + Laufend/Kosten */}
                    <tr className="border-t-2 font-semibold" data-testid="row-total">
                      <td className="py-1 pr-2">Total</td>
                      <td />
                      {wochenSpalten.map(ws => {
                        const t = wochenTotal(ws.monday);
                        return (
                          <td key={ws.monday} className={`text-right px-1 tabular-nums ${saldoClass(t)}`} data-testid={`total-${ws.monday}`}>
                            {t === null ? '–' : t.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
                          </td>
                        );
                      })}
                      <td className={`text-right pl-2 tabular-nums ${saldoClass(erg.totalLaufend)}`}>{fmtH(erg.totalLaufend)}</td>
                      <td className="text-right pl-2 tabular-nums" data-testid="text-total-kosten">
                        {erg.totalKosten === null ? '–' : erg.totalKosten.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                    </tr>
                  </tbody>
                </table>
              ) : (
                <table className="text-xs w-full">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="text-left py-1 pr-2">Mitarbeiter</th>
                      <th className="text-right pr-2">Pensum</th>
                      {MONATE.slice(startMonatIdx).map(m => <th key={m} className="text-right px-1">{m}</th>)}
                      <th className="text-right pl-2 font-semibold">Laufend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gerechnet.map(m => (
                      <tr
                        key={m.id}
                        className={`border-t cursor-pointer hover:bg-muted/50 ${selEmp === m.id ? 'bg-muted/60' : ''}`}
                        onClick={() => { setSelEmp(m.id); setSelWeek(null); setStaged({}); }}
                        data-testid={`row-emp-${m.id}`}
                      >
                        <td className="py-1 pr-2 whitespace-nowrap">{m.name}</td>
                        <td className="text-right pr-2">{Math.round(m.wochenSollH / VOLLZEIT_WOCHE_H * 100)}%</td>
                        {m.monatsSaldo.slice(startMonatIdx).map((s, i) => (
                          <td key={i} className={`text-right px-1 tabular-nums ${saldoClass(s)}`}>
                            {s === null ? '–' : s.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
                          </td>
                        ))}
                        <td className={`text-right pl-2 tabular-nums font-semibold ${saldoClass(m.laufend)}`}>
                          {fmtH(m.laufend)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="text-[11px] text-muted-foreground mt-2">
                «–» = keine Datenbasis oder ausserhalb der Anstellung (Eintritt/Austritt). Konto ab {UEBERSTUNDEN_START.split('-').reverse().join('.')} — frühere Zeiträume werden nicht gezeigt; die erste Woche zählt nur Tage ab Konto-Start (anteiliges Soll). Klick auf einen Mitarbeiter öffnet die Wochen-Details.
              </p>
              {ohneEintritt.length > 0 && (
                <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-1" data-testid="text-ohne-eintritt">
                  Ohne Eintrittsdatum im Personalstamm (nicht gerechnet, bitte nachtragen): {ohneEintritt.map(m => m.name).join(', ')}
                </p>
              )}
            </CardContent>
          </Card>

          {sel && selWoche && (
            <Card data-testid="card-wochen-detail">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  {sel.name} — {selWoche.label} ({selWoche.monday.slice(8, 10)}.{selWoche.monday.slice(5, 7)}. – {selWoche.tage[6]?.datum.slice(8, 10)}.{selWoche.tage[6]?.datum.slice(5, 7)}.)
                </CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="text-xs w-full max-w-xl">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="text-left py-1">Tag</th>
                      <th className="text-right px-2">Mirus-Std</th>
                      <th className="text-left px-2">Absenz</th>
                      <th className="text-right px-2">Gutschrift</th>
                      <th className="text-right px-2">Tages-Soll</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selWoche.tage.map(t => {
                      const wd = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][new Date(t.datum + 'T12:00:00').getDay()];
                      return (
                        <tr key={t.datum} className={`border-t ${t.zaehlt ? '' : 'text-muted-foreground'}`} data-testid={`detail-tag-${t.datum}`}>
                          <td className="py-0.5 whitespace-nowrap">{wd} {t.datum.slice(8, 10)}.{t.datum.slice(5, 7)}.</td>
                          <td className="text-right px-2 tabular-nums">{t.zaehlt ? fmtH(t.arbeitH ?? 0) : '–'}</td>
                          <td className="px-2">{t.absenzTyp ? UE_ABSENZ_LABELS[t.absenzTyp] : t.zaehlt ? '' : '–'}</td>
                          <td className="text-right px-2 tabular-nums">{t.zaehlt ? (t.gutschrift ? fmtH(t.gutschrift) : '') : '–'}</td>
                          <td className="text-right px-2 tabular-nums">{t.zaehlt ? fmtH(t.soll ?? 0) : '–'}</td>
                        </tr>
                      );
                    })}
                    <tr className="border-t-2 font-medium">
                      <td className="py-1">Woche</td>
                      <td className="text-right px-2 tabular-nums">{selWoche.ist === null ? '–' : fmtH(selWoche.ist)}</td>
                      <td className="px-2 text-muted-foreground">Soll {selWoche.soll === null ? '–' : fmtH(selWoche.soll)}</td>
                      <td className="text-right px-2 tabular-nums text-muted-foreground">{selWoche.gutschrift ? fmtH(selWoche.gutschrift) : ''}</td>
                      <td className={`text-right px-2 tabular-nums ${saldoClass(selWoche.saldo)}`} data-testid="detail-saldo">
                        {selWoche.saldo === null ? '–' : fmtH(selWoche.saldo)}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p className="text-[11px] text-muted-foreground mt-2">
                  «–» = Tag zählt nicht (vor Konto-Start/Eintritt, nach Austritt oder keine Datenbasis).
                  {sel.stundensatz !== null && selWoche.saldo !== null && (
                    <> · Wochen-Kostenwirkung: {selWoche.saldo > 0
                      ? `${(Math.round(selWoche.saldo * sel.stundensatz * 100) / 100).toLocaleString('de-CH', { minimumFractionDigits: 2 })} CHF (Saldo × ${sel.stundensatz.toLocaleString('de-CH', { minimumFractionDigits: 2 })} CHF/h)`
                      : '0.00 CHF (kein positives Saldo)'}</>
                  )}
                </p>
              </CardContent>
            </Card>
          )}

          {sel && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  {sel.name} — Wochen {year} (Soll {fmtH(sel.wochenSollH)}/Woche)
                </CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="text-xs w-full max-w-xl">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="text-left py-1">KW</th>
                      <th className="text-right px-2">Soll</th>
                      <th className="text-right px-2">Ist</th>
                      <th className="text-right px-2">davon Gutschrift</th>
                      <th className="text-right px-2">Saldo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sel.wochen.filter(w => w.monday <= heute).map(w => (
                      <tr key={w.monday} className="border-t">
                        <td className="py-0.5 whitespace-nowrap">{w.label} <span className="text-muted-foreground">({w.monday.slice(8, 10)}.{w.monday.slice(5, 7)}.)</span></td>
                        <td className="text-right px-2 tabular-nums">{w.soll === null ? '–' : fmtH(w.soll)}</td>
                        <td className="text-right px-2 tabular-nums">{w.ist === null ? '–' : fmtH(w.ist)}</td>
                        <td className="text-right px-2 tabular-nums text-muted-foreground">{w.gutschrift ? fmtH(w.gutschrift) : w.gutschrift === 0 ? '0.0 h' : '–'}</td>
                        <td className={`text-right px-2 tabular-nums ${saldoClass(w.saldo)}`}>{w.saldo === null ? '–' : fmtH(w.saldo)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {sel && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex flex-wrap items-center gap-3">
                  <span>Absenzen erfassen — {sel.name}</span>
                  <select
                    className="border rounded px-2 py-1 text-sm bg-background font-normal"
                    value={editMonat}
                    onChange={e => { setEditMonat(Number(e.target.value)); setStaged({}); }}
                    data-testid="select-absenz-monat"
                  >
                    {MONATE.map((m, i) => <option key={m} value={i + 1}>{m} {year}</option>)}
                  </select>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Ferien/Krank/Unfall = Gutschrift {fmtH(sel.wochenSollH / 5)}/Tag · Frei = 0 (wie kein Eintrag, aber dokumentiert).
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-1">
                  {editDays.map(date => {
                    const gespeichert = selAbsenzen[date];
                    const val = staged[date] !== undefined ? staged[date] : (gespeichert ?? '');
                    const dirty = staged[date] !== undefined && (staged[date] || undefined) !== gespeichert;
                    const wd = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][new Date(date + 'T12:00:00').getDay()];
                    return (
                      <label key={date} className={`flex items-center gap-1 text-[11px] rounded px-1 py-0.5 ${dirty ? 'bg-amber-100 dark:bg-amber-900/40' : ''}`}>
                        <span className={`w-10 tabular-nums ${wd === 'Sa' || wd === 'So' ? 'text-muted-foreground' : ''}`}>{wd} {date.slice(8, 10)}.</span>
                        <select
                          className="border rounded px-1 py-0.5 bg-background flex-1"
                          value={val}
                          onChange={e => setStaged(s => ({ ...s, [date]: e.target.value as UeAbsenzTyp | '' }))}
                          data-testid={`select-absenz-${date}`}
                        >
                          <option value="">—</option>
                          {(Object.keys(UE_ABSENZ_LABELS) as UeAbsenzTyp[]).map(t => (
                            <option key={t} value={t}>{UE_ABSENZ_LABELS[t]}</option>
                          ))}
                        </select>
                      </label>
                    );
                  })}
                </div>
                {changes.length > 0 && (
                  <div className="text-xs border rounded p-2 bg-muted/40" data-testid="text-vorschau">
                    <p className="font-medium mb-1">Vorschau — {changes.length} Änderung(en):</p>
                    <ul className="space-y-0.5">
                      {changes.map(c => (
                        <li key={c.date}>
                          {c.date.slice(8, 10)}.{c.date.slice(5, 7)}.: {c.von ? UE_ABSENZ_LABELS[c.von] : '—'} → {c.zu ? UE_ABSENZ_LABELS[c.zu] : '—'}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void speichern()} disabled={changes.length === 0 || saving} data-testid="button-absenz-speichern">
                    {saving ? 'Speichert…' : 'Speichern'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setStaged({})} disabled={changes.length === 0 || saving} data-testid="button-absenz-verwerfen">
                    Verwerfen
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void rueckgaengig()} disabled={saving} data-testid="button-absenz-undo">
                    Letztes Speichern rückgängig
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {parked.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Hinweis: nicht zuordenbare Mirus-Namen ({parked.length})</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground mb-2">
                  Diese importierten Stunden sind KEINEM Mitarbeiter zugeordnet und fehlen darum
                  in der Überstunden-Rechnung. Zuordnung im Import-Center vornehmen.
                </p>
                <ul className="text-xs space-y-0.5">
                  {parked.map(p => (
                    <li key={p.id} data-testid={`text-parked-${p.id}`}>
                      <span className="font-medium">{p.name}</span> — {p.month}, {Object.keys(p.days).length} Tag(e), Σ {fmtH(p.totalHours)}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
