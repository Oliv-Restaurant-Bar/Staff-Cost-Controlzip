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
  parseTransgourmetCsv, kontoSplitsFuerRechnung, berechnePreisAenderungen,
  aktualisierePreisHistorie, DEFAULT_PREIS_SCHWELLE,
  type CsvParseErgebnis, type ParsedCsvRechnung, type PreisAenderung, type PreisHistorie, type PreisSchwelle,
} from '@/lib/waren-positionen';
import {
  loadMonthInvoices, saveInvoiceEntry, loadPreisHistorie, savePreisHistorie,
  loadPreisSchwelle, savePreisSchwelle, loadPreisHinweise, savePreisHinweise,
  kategorieFromKonto, type InvoiceEntry, type Supplier,
} from '@/lib/waren-db';
import { fmtDatumCH } from '@/lib/waren-fibu-matches';
import type { TenantId } from '@/contexts/TenantContext';

const fmt = (n: number) => n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
  const geladen = useRef(false);

  useEffect(() => {
    if (geladen.current) return;
    geladen.current = true;
    Promise.all([loadPreisHistorie(tenantId), loadPreisSchwelle(tenantId)]).then(([h, s]) => {
      setHistorie(h); setSchwelle(s);
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
      for (const r of zuImportieren) {
        const month = r.datum.slice(0, 7);
        const bestand = await loadMonthInvoices(tenantId, month);
        const vorhanden = bestand.find(e =>
          (e.reference ?? '').trim().toLowerCase() === r.rechnungsNr.toLowerCase()
          && e.date === r.datum // Portal-Nummern werden über Monate wiederverwendet
          && e.supplierName.trim().toLowerCase() === lieferant.trim().toLowerCase());
        const splits = kontoSplitsFuerRechnung(r);
        const haupt = splits[0]?.warenkonto ?? '4000';
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
