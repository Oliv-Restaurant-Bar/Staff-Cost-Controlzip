/**
 * Transgourmet/Prodega CSV-Import (Rechnungspositionen) mit Preisüberwachung.
 * ===========================================================================
 * - Vorschau VOR dem Schreiben: Rechnungen (Datum, Nr., Positionen, Netto)
 *   + Liste «Preisänderungen (N)»: Artikel · alt → neu · Δ% · seit wann.
 * - Preis-Historie pro (Mandant + Lieferant + Art.-Nr. bzw. Name);
 *   Pfand/Gebinde (MwSt-Code 0) ausgenommen; Re-Import derselben Rechnung
 *   vergleicht nicht neu (Historie-Eintrag trägt die Quell-Rechnungsnummer).
 * - Schwelle (±% / Mindest-CHF) einstellbar, mandantenweit persistiert.
 * - Dublettensicher: gleiche Referenz (Rechnungsnummer) + Lieferant im
 *   Zielmonat → bestehender Eintrag wird ERSETZT (gleiche id), nie doppelt.
 * - Rein erfassend: Beträge kommen 1:1 aus dem CSV (netto + MwSt-Beträge).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { AlertTriangle, FileSpreadsheet, Loader2, TrendingDown, TrendingUp, X } from 'lucide-react';
import {
  parseTransgourmetCsv, berechnePreisAenderungen,
  aktualisierePreisHistorie, DEFAULT_PREIS_SCHWELLE, DEFAULT_WARENGRUPPEN_MAPPING,
  offeneWarengruppen, positionenAusRechnung, kontoSplitsAusPositionen, uebernehmeManuelleKontierung,
  type CsvParseErgebnis, type PreisAenderung, type PreisHistorie, type PreisSchwelle,
  type WarengruppenMapping,
} from '@/lib/waren-positionen';
import {
  loadMonthInvoices, saveInvoiceEntry, loadPreisHistorie, savePreisHistorie,
  loadPreisSchwelle, savePreisSchwelle, loadPreisHinweise, savePreisHinweise,
  loadWarengruppenMapping, saveWarengruppenMapping, loadRechnungsPositionen, saveRechnungsPositionen,
  kategorieFromKonto, type InvoiceEntry, type Supplier,
} from '@/lib/waren-db';
import { fmtDatumCH } from '@/lib/waren-fibu-matches';
import type { TenantId } from '@/contexts/TenantContext';

const fmt = (n: number) => n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Einstellungen-Editor «Warengruppe → Konto» (mandantengetrennt, KV-persistiert).
 * Konten 4000–Grenze zählen zur WKQ, ≥4091 (z.B. 4701) sind Betriebskosten —
 * die Klassifizierung übernimmt die bestehende Kontoklassen-Logik.
 */
export function WarengruppenKontenEditor({ tenantId, canEdit }: { tenantId: TenantId; canEdit: boolean }) {
  const [mapping, setMapping] = useState<WarengruppenMapping | null>(null);
  const [neuGruppe, setNeuGruppe] = useState('');
  const [neuKonto, setNeuKonto] = useState('');
  // Aktueller Stand als Ref (blur-Handler dürfen nie einen veralteten Render-Stand speichern)
  const mappingRef = useRef<WarengruppenMapping | null>(null);
  useEffect(() => { mappingRef.current = mapping; }, [mapping]);
  // Serialisierte Save-Kette: kein paralleles Überschreiben bei schnellen Blur-Folgen
  const saveKette = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let alive = true;
    loadWarengruppenMapping(tenantId).then(m => { if (alive) setMapping(m); })
      .catch(() => { if (alive) setMapping(DEFAULT_WARENGRUPPEN_MAPPING); });
    return () => { alive = false; };
  }, [tenantId]);

  const zeileGueltig = (r: { gruppe: string; konto: string }) =>
    r.gruppe.trim().length > 0 && /^\d{4}$/.test(r.konto.trim());

  /** Validiert + persistiert den AKTUELLEN Stand (aus Ref, nie Render-Closure). */
  const speichernAktuell = () => {
    const cur = mappingRef.current;
    if (!cur) return;
    if (!cur.every(zeileGueltig)) {
      toast.error('Nicht gespeichert: Warengruppe darf nicht leer sein, Konto muss 4-stellig sein (z.B. 4060).');
      return;
    }
    const next = cur.map(r => ({ gruppe: r.gruppe.trim(), konto: r.konto.trim() }));
    saveKette.current = saveKette.current
      .then(() => saveWarengruppenMapping(tenantId, next))
      .catch(e => { toast.error(`Speichern fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`); });
  };

  const speichern = (next: WarengruppenMapping) => {
    setMapping(next);
    mappingRef.current = next;
    speichernAktuell();
  };

  if (mapping === null) return <p className="text-xs text-muted-foreground">Lädt…</p>;
  return (
    <div className="space-y-2 text-xs" data-testid="warengruppen-konten-editor">
      <p className="text-muted-foreground">
        Kontierung der CSV-Positionen nach Warengruppe. Unbekannte Gruppen werden als
        «Konto offen» markiert (nie geraten); Pfand/Gebinde (MwSt-Code 0) bleibt ohne Warenkonto.
      </p>
      <div className="space-y-1 max-h-56 overflow-y-auto pr-1">
        {mapping.map((r, i) => (
          <div key={`${r.gruppe}-${i}`} className="flex items-center gap-2">
            <Input value={r.gruppe} disabled={!canEdit} className="h-7 text-xs flex-1"
              onChange={e => setMapping(m => m!.map((x, xi) => xi === i ? { ...x, gruppe: e.target.value } : x))}
              onBlur={speichernAktuell} />
            <span className="text-muted-foreground">→</span>
            <Input value={r.konto} disabled={!canEdit} className="h-7 text-xs w-20 text-right tabular-nums"
              onChange={e => setMapping(m => m!.map((x, xi) => xi === i ? { ...x, konto: e.target.value } : x))}
              onBlur={speichernAktuell} />
            {canEdit && (
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground"
                onClick={() => speichern((mappingRef.current ?? mapping).filter((_, xi) => xi !== i))}>
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        ))}
      </div>
      {canEdit && (
        <div className="flex items-center gap-2 pt-1 border-t border-border/40">
          <Input placeholder="Warengruppe (z.B. Tiefkühl)" value={neuGruppe}
            onChange={e => setNeuGruppe(e.target.value)} className="h-7 text-xs flex-1" data-testid="neu-warengruppe" />
          <span className="text-muted-foreground">→</span>
          <Input placeholder="Konto" value={neuKonto} onChange={e => setNeuKonto(e.target.value)}
            className="h-7 text-xs w-20 text-right tabular-nums" data-testid="neu-warengruppe-konto" />
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs"
            disabled={!neuGruppe.trim() || !/^\d{4}$/.test(neuKonto.trim())}
            onClick={() => {
              speichern([...(mappingRef.current ?? mapping), { gruppe: neuGruppe.trim(), konto: neuKonto.trim() }]);
              setNeuGruppe(''); setNeuKonto('');
            }} data-testid="neu-warengruppe-add">Hinzufügen</Button>
        </div>
      )}
    </div>
  );
}

export function WarenCsvImport({ tenantId, suppliers, onImported }: {
  tenantId: TenantId;
  suppliers: Supplier[];
  onImported: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [ergebnis, setErgebnis] = useState<CsvParseErgebnis | null>(null);
  const [ausgewaehlt, setAusgewaehlt] = useState<Set<string>>(new Set());
  const [lieferant, setLieferant] = useState('');
  const [historie, setHistorie] = useState<PreisHistorie | null>(null);
  const [schwelle, setSchwelle] = useState<PreisSchwelle>(DEFAULT_PREIS_SCHWELLE);
  const [schwelleText, setSchwelleText] = useState({ pct: '10', minChf: '0.20' });
  const [mapping, setMapping] = useState<WarengruppenMapping>(DEFAULT_WARENGRUPPEN_MAPPING);
  const geladen = useRef(false);

  useEffect(() => {
    if (geladen.current) return;
    geladen.current = true;
    Promise.all([loadPreisHistorie(tenantId), loadPreisSchwelle(tenantId), loadWarengruppenMapping(tenantId)]).then(([h, s, m]) => {
      setHistorie(h); setSchwelle(s); setMapping(m);
      setSchwelleText({ pct: String(s.pct), minChf: s.minChf.toFixed(2) });
    }).catch(() => setHistorie({}));
  }, [tenantId]);

  const handleFile = async (file: File | null) => {
    if (!file) return;
    const text = await file.text();
    const res = parseTransgourmetCsv(text);
    setErgebnis(res);
    setAusgewaehlt(new Set(res.rechnungen.map(r => r.docKey)));
    if (!lieferant) {
      const bekannt = suppliers.find(s => /transgourmet|prodega/i.test(s.name));
      setLieferant(bekannt?.name ?? 'Transgourmet');
    }
    if (res.failureReason) toast.error(res.failureReason);
  };

  // Preisänderungen je Rechnung — sequenziell gegen die fortgeschriebene
  // Historie (Datei-interne Änderungen werden ebenfalls erkannt).
  const vorschau = useMemo(() => {
    if (!ergebnis || historie === null || !lieferant.trim()) return null;
    let hist = historie;
    const proRechnung = new Map<string, PreisAenderung[]>();
    const alle: PreisAenderung[] = [];
    for (const r of ergebnis.rechnungen) {
      if (!ausgewaehlt.has(r.docKey)) continue;
      const aen = berechnePreisAenderungen(r, lieferant, hist, schwelle);
      proRechnung.set(r.docKey, aen);
      alle.push(...aen);
      hist = aktualisierePreisHistorie(hist, [r], lieferant);
    }
    return { proRechnung, alle, histNachImport: hist };
  }, [ergebnis, historie, lieferant, ausgewaehlt, schwelle]);

  const speichereSchwelle = async () => {
    const pct = Number(schwelleText.pct.replace(',', '.'));
    const minChf = Number(schwelleText.minChf.replace(',', '.'));
    if (!Number.isFinite(pct) || pct < 0 || !Number.isFinite(minChf) || minChf < 0) {
      setSchwelleText({ pct: String(schwelle.pct), minChf: schwelle.minChf.toFixed(2) });
      return;
    }
    const s = { pct, minChf };
    setSchwelle(s);
    try { await savePreisSchwelle(tenantId, s); }
    catch (e) { toast.error(`Schwelle speichern fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`); }
  };

  const importieren = async () => {
    if (!ergebnis || !vorschau || !lieferant.trim()) return;
    const zuImportieren = ergebnis.rechnungen.filter(r => ausgewaehlt.has(r.docKey));
    if (zuImportieren.length === 0) return;
    setBusy(true);
    try {
      let ersetzt = 0, neu = 0;
      const hinweiseProMonat = new Map<string, Record<string, PreisAenderung[]>>();
      const positionenProMonat = new Map<string, Record<string, ReturnType<typeof positionenAusRechnung>>>();
      for (const r of zuImportieren) {
        const month = r.datum.slice(0, 7);
        const bestand = await loadMonthInvoices(tenantId, month);
        const vorhanden = bestand.find(e =>
          (e.reference ?? '').trim().toLowerCase() === r.rechnungsNr.toLowerCase()
          && e.date === r.datum // Portal-Nummern werden über Monate wiederverwendet
          && e.supplierName.trim().toLowerCase() === lieferant.trim().toLowerCase());
        // Positionen kontieren — bei Re-Import manuelle Overrides des Altbestands übernehmen.
        let bestehendePos = positionenProMonat.get(month);
        if (!bestehendePos) {
          bestehendePos = { ...(await loadRechnungsPositionen(tenantId, month)) };
          positionenProMonat.set(month, bestehendePos);
        }
        const positionen = uebernehmeManuelleKontierung(
          positionenAusRechnung(r, mapping),
          vorhanden ? bestehendePos[vorhanden.id] : undefined,
        );
        const splits = kontoSplitsAusPositionen(positionen);
        // Hauptkonto = grösstes NUMERISCHES Konto (Pseudo-Splits «Depot»/«offen» nie als Kategorie-Quelle)
        const haupt = splits.find(s => /^\d+$/.test(s.warenkonto))?.warenkonto ?? splits[0]?.warenkonto ?? '4060';
        const jetzt = new Date().toISOString();
        const id = vorhanden?.id ?? `csv-${r.rechnungsNr}-${Date.now()}`;
        const entry: InvoiceEntry = {
          id,
          date: r.datum,
          supplierName: lieferant.trim(),
          amountGross: r.bruttoTotal,
          amountNet: r.nettoTotal,
          vatIncluded: false,
          vatRate: r.nettoTotal > 0 ? Math.round((r.mwstTotal / r.nettoTotal) * 1000) / 10 : 0,
          reference: r.rechnungsNr,
          note: `CSV-Import ${r.markt ? `(${r.markt}) ` : ''}· ${r.positionen.length} Positionen`,
          ...(splits.length > 1 ? { kontoSplits: splits } : { warenkonto: haupt }),
          kategorie: kategorieFromKonto(haupt),
          ...(vorhanden?.receiptPath ? { receiptPath: vorhanden.receiptPath } : {}),
          createdAt: vorhanden?.createdAt ?? jetzt,
          updatedAt: jetzt,
        };
        await saveInvoiceEntry(tenantId, entry);
        if (vorhanden) ersetzt++; else neu++;
        const aen = vorschau.proRechnung.get(r.docKey) ?? [];
        const monat = hinweiseProMonat.get(month) ?? {};
        if (aen.length > 0) monat[id] = aen; else delete monat[id];
        hinweiseProMonat.set(month, monat);
        // Positionen inkl. Kontierung persistieren (Re-Import ersetzt je Rechnung).
        const posMonat = positionenProMonat.get(month) ?? {};
        posMonat[id] = positionen;
        positionenProMonat.set(month, posMonat);
      }
      for (const [month, neue] of positionenProMonat) {
        const bestehend = await loadRechnungsPositionen(tenantId, month);
        await saveRechnungsPositionen(tenantId, month, { ...bestehend, ...neue });
      }
      // Hinweise pro Monat mit Bestand mergen (Re-Import ersetzt je Rechnung).
      for (const [month, neue] of hinweiseProMonat) {
        const bestehend = await loadPreisHinweise(tenantId, month);
        await savePreisHinweise(tenantId, month, { ...bestehend, ...neue });
      }
      await savePreisHistorie(tenantId, vorschau.histNachImport);
      setHistorie(vorschau.histNachImport);
      toast.success(`${neu} Rechnung${neu === 1 ? '' : 'en'} importiert${ersetzt > 0 ? `, ${ersetzt} ersetzt` : ''} · ${vorschau.alle.length} Preisänderung${vorschau.alle.length === 1 ? '' : 'en'}.`);
      setErgebnis(null);
      onImported();
    } catch (e) {
      toast.error(`Import fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const toggleRechnung = (nr: string) => {
    setAusgewaehlt(prev => {
      const next = new Set(prev);
      if (next.has(nr)) next.delete(nr); else next.add(nr);
      return next;
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className={cn(
          'inline-flex items-center gap-2 text-xs font-medium rounded-lg border border-dashed px-3 py-2 cursor-pointer transition-colors',
          busy ? 'opacity-60 pointer-events-none' : 'hover:bg-muted/40',
        )}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4 text-emerald-600" />}
          CSV-Rechnungen importieren (Transgourmet/Prodega)
          <input type="file" accept=".csv,text/csv" className="hidden" disabled={busy}
            data-testid="input-waren-csv"
            onChange={e => { void handleFile(e.target.files?.[0] ?? null); e.target.value = ''; }} />
        </label>
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          Warn-Schwelle ±
          <Input value={schwelleText.pct} onChange={e => setSchwelleText(t => ({ ...t, pct: e.target.value }))}
            onBlur={speichereSchwelle} className="h-6 w-12 px-1 text-[11px] text-right tabular-nums" data-testid="preis-schwelle-pct" />
          % · min. CHF
          <Input value={schwelleText.minChf} onChange={e => setSchwelleText(t => ({ ...t, minChf: e.target.value }))}
            onBlur={speichereSchwelle} className="h-6 w-14 px-1 text-[11px] text-right tabular-nums" data-testid="preis-schwelle-chf" />
        </span>
      </div>

      {ergebnis && ergebnis.rechnungen.length > 0 && (
        <div className="rounded-lg border border-border bg-muted/20 px-4 py-3 text-xs space-y-3" data-testid="csv-import-vorschau">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-medium">{ergebnis.rechnungen.length} Rechnungen · {ergebnis.debug.zeilenVerwendet} Positionen</span>
            <span className="inline-flex items-center gap-1">
              Lieferant:
              <Input value={lieferant} onChange={e => setLieferant(e.target.value)} list="csv-lieferanten"
                className="h-6 w-40 px-1.5 text-[11px]" data-testid="csv-lieferant" />
              <datalist id="csv-lieferanten">
                {suppliers.filter(s => s.active).map(s => <option key={s.id} value={s.name} />)}
              </datalist>
            </span>
            <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[11px]" onClick={() => setErgebnis(null)}>
              <X className="h-3 w-3 mr-0.5" /> Verwerfen
            </Button>
          </div>

          {/* Rechnungsliste */}
          <div className="max-h-48 overflow-y-auto space-y-0.5">
            {ergebnis.rechnungen.map(r => (
              <label key={r.docKey} className="flex items-center gap-2 tabular-nums cursor-pointer hover:bg-muted/40 rounded px-1 py-0.5">
                <input type="checkbox" className="h-3.5 w-3.5 accent-emerald-600"
                  checked={ausgewaehlt.has(r.docKey)} onChange={() => toggleRechnung(r.docKey)} />
                <span className="w-20">{fmtDatumCH(r.datum)}</span>
                <span className="w-24 truncate" title={r.rechnungsNr}>Nr. {r.rechnungsNr}</span>
                <span className="text-muted-foreground">{r.positionen.length} Pos.</span>
                <span className="ml-auto">CHF {fmt(r.nettoTotal)} netto</span>
                {(vorschau?.proRechnung.get(r.docKey)?.length ?? 0) > 0 && (
                  <span className="text-amber-600 dark:text-amber-400 inline-flex items-center gap-0.5">
                    <AlertTriangle className="h-3 w-3" />{vorschau!.proRechnung.get(r.docKey)!.length}
                  </span>
                )}
              </label>
            ))}
          </div>

          {/* Unbekannte Warengruppen — «Konto offen», nie raten */}
          {(() => {
            const offen = offeneWarengruppen(ergebnis.rechnungen.filter(r => ausgewaehlt.has(r.docKey)), mapping);
            return offen.length > 0 ? (
              <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-400"
                data-testid="konto-offen-hinweis">
                <span className="font-medium">Konto offen ({offen.length}):</span> {offen.join(', ')} — Zuordnung
                unter Einstellungen → «Warengruppen → Konto» ergänzen; betroffene Positionen werden bis dahin
                als «offen» markiert (kein Konto geraten).
              </div>
            ) : null;
          })()}

          {/* Preisänderungen — VOR dem Schreiben sichtbar */}
          {vorschau && (
            <div className="border-t border-border/40 pt-2 space-y-1" data-testid="preisaenderungen-liste">
              <p className="font-medium">Preisänderungen ({vorschau.alle.length})</p>
              {vorschau.alle.length === 0 && <p className="text-muted-foreground">Keine Preisänderungen gegenüber der letzten Erfassung.</p>}
              <div className="max-h-56 overflow-y-auto space-y-0.5">
                {vorschau.alle.map((a, i) => (
                  <div key={`${a.key}-${i}`} className={cn('flex flex-wrap items-center gap-2 tabular-nums rounded px-1.5 py-0.5',
                    a.stark && a.erhoehung ? 'bg-red-500/10 text-red-700 dark:text-red-400 font-medium'
                      : a.stark ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                        : 'text-muted-foreground')}>
                    {a.erhoehung ? <TrendingUp className="h-3 w-3 shrink-0" /> : <TrendingDown className="h-3 w-3 shrink-0" />}
                    <span className="truncate max-w-[280px]" title={a.artNr ? `Art. ${a.artNr}` : undefined}>{a.artikel}</span>
                    <span className="ml-auto">CHF {fmt(a.alt)} → CHF {fmt(a.neu)}</span>
                    <span>({a.diffAbs > 0 ? '+' : ''}{fmt(a.diffAbs)}{a.diffPct !== null ? ` / ${a.diffPct > 0 ? '+' : ''}${a.diffPct.toFixed(1)} %` : ''})</span>
                    <span className="text-[10px]">seit {fmtDatumCH(a.seit)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <Button size="sm" className="h-7 px-3 text-xs" disabled={busy || ausgewaehlt.size === 0 || !lieferant.trim()}
            onClick={importieren} data-testid="csv-import-button">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
            {ausgewaehlt.size} Rechnung{ausgewaehlt.size === 1 ? '' : 'en'} importieren
          </Button>
        </div>
      )}
    </div>
  );
}
