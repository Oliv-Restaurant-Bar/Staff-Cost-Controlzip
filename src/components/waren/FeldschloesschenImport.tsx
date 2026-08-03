/**
 * Feldschlösschen PDF-Import (Lieferscheine, Monats-Sammelrechnung, Historie)
 * ===========================================================================
 * Teil A — Lieferschein-/Einzelrechnungs-PDFs: Positionen mit MWST-Codes
 *   3C/4C/C0 → FS-Kategorie → Konto über die Warengruppen-Tabelle (FS-Standards:
 *   Bier→4030, Spirituosen→4040, Wein→4020, alkoholfrei→4050, Andere Güter /
 *   Zu-/Abschläge→4701 Betriebskosten, Leergut→Depot neutral). Preisüberwachung
 *   pro Material-Nr (gleiche Mechanik wie Transgourmet). Dublettensicher:
 *   Lieferant + Lieferung-Nr + Datum ersetzt den bestehenden Eintrag.
 * Teil B — Sammelrechnung = KONTROLLE (bucht NIE selbst): Fakturas werden über
 *   Datum (±7 Tage) + Betrag (±0.10) gegen die erfassten Einzel-Lieferungen
 *   gematcht; fehlende rot mit Komfort-Übernahme aus den eingebetteten
 *   Rechnungs-Seiten; «Zusammenfassung MwSt.» als Kategorien-Gegenprobe.
 * Teil C — Historie (ZIP mit Sammelrechnungen 2024/2025): pro Jahr+Mandant als
 *   Hardzahlen (Kategorien/Monat + Materialpreise), dublettensicher auf
 *   Sammelrechnung-Nr, Jahr-Sperre (im Save-Pfad frisch geprüft).
 */
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { AlertTriangle, Beer, CheckCircle2, Loader2, Lock, LockOpen, X } from 'lucide-react';
import { extractGnPdfTextItems } from '@/lib/gn-pdf-text';
import { reconstructGnPdfLines } from '@/lib/gn-pdf-lines';
import {
  toFsZeilen, detectFsPdfTyp, istFeldschloesschenPdf,
  parseFsLieferschein, parseFsSammelrechnung, fsLieferscheinAlsRechnung,
  fsAnhangAlsRechnung, matchFakturen, kategorienGegenprobe, mitFsDefaults, findeNaheRechnung,
  sammelrechnungZuHistorie,
  type FsLieferschein, type FsSammelrechnung, type FakturaAbgleich,
} from '@/lib/feldschloesschen';
import {
  berechnePreisAenderungen, aktualisierePreisHistorie, DEFAULT_PREIS_SCHWELLE,
  positionenAusRechnung, kontoSplitsAusPositionen, uebernehmeManuelleKontierung,
  type ParsedCsvRechnung, type PreisAenderung,
} from '@/lib/waren-positionen';
import {
  loadMonthInvoices, saveInvoiceEntry, loadPreisHistorie, savePreisHistorie,
  loadPreisSchwelle, loadPreisHinweise, savePreisHinweise, loadWarengruppenMapping,
  loadRechnungsPositionen, saveRechnungsPositionen, kategorieFromKonto,
  loadFsHistorie, upsertFsHistorie, isFsHistorieLocked, setFsHistorieLock,
  type InvoiceEntry, type Supplier,
} from '@/lib/waren-db';
import { fmtDatumCH } from '@/lib/waren-fibu-matches';
import type { TenantId } from '@/contexts/TenantContext';
import type { FsHistorienEintrag } from '@/lib/feldschloesschen';

const fmt = (n: number) => n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function pdfZuZeilen(file: File | Blob, name: string) {
  const f = file instanceof File ? file : new File([file], name, { type: 'application/pdf' });
  const res = await extractGnPdfTextItems(f);
  if (!res.hasTextLayer) throw new Error(`${name}: PDF hat keinen Text-Layer (Scan?) — bitte Original-PDF verwenden.`);
  return toFsZeilen(reconstructGnPdfLines(res.pages));
}

export function FeldschloesschenImport({ tenantId, suppliers, onImported }: {
  tenantId: TenantId;
  suppliers: Supplier[];
  onImported: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [lieferscheine, setLieferscheine] = useState<FsLieferschein[] | null>(null);
  const [ausgewaehlt, setAusgewaehlt] = useState<Set<string>>(new Set());
  const [sammel, setSammel] = useState<FsSammelrechnung | null>(null);
  const [abgleich, setAbgleich] = useState<FakturaAbgleich | null>(null);
  const [monatsInvoices, setMonatsInvoices] = useState<InvoiceEntry[]>([]);
  const [uebernommen, setUebernommen] = useState<Set<string>>(new Set());
  const [histVorschau, setHistVorschau] = useState<FsHistorienEintrag[] | null>(null);
  const [histAnalyse, setHistAnalyse] = useState<{ jahr: string; eintraege: FsHistorienEintrag[]; locked: boolean } | null>(null);
  const [analyseJahr, setAnalyseJahr] = useState(String(new Date().getFullYear() - 1));

  const lieferant = useMemo(
    () => suppliers.find(s => /feldschl/i.test(s.name))?.name ?? 'Feldschlösschen',
    [suppliers],
  );

  // ── Gemeinsame Import-Pipeline (Lieferschein & Anhang-Übernahme) ──────────
  const importiereRechnungen = async (
    rechnungen: Array<{ r: ParsedCsvRechnung; nettoOffiziell?: number | null; bruttoOffiziell?: number | null }>,
  ) => {
    const [mappingRoh, historie, schwelle] = await Promise.all([
      loadWarengruppenMapping(tenantId), loadPreisHistorie(tenantId),
      loadPreisSchwelle(tenantId).catch(() => DEFAULT_PREIS_SCHWELLE),
    ]);
    const mapping = mitFsDefaults(mappingRoh);
    let hist = historie;
    let neu = 0, ersetzt = 0, offen = 0;
    const alleAenderungen: PreisAenderung[] = [];
    for (const { r, nettoOffiziell, bruttoOffiziell } of rechnungen) {
      const month = r.datum.slice(0, 7);
      const bestand = await loadMonthInvoices(tenantId, month);
      const vorhanden = bestand.find(e =>
        (e.reference ?? '').trim().toLowerCase() === r.rechnungsNr.toLowerCase()
        && e.date === r.datum
        && e.supplierName.trim().toLowerCase() === lieferant.trim().toLowerCase());
      const bestehendePos = await loadRechnungsPositionen(tenantId, month);
      const positionen = uebernehmeManuelleKontierung(
        positionenAusRechnung(r, mapping),
        vorhanden ? bestehendePos[vorhanden.id] : undefined,
      );
      offen += positionen.filter(p => p.status === 'offen').length;
      const splits = kontoSplitsAusPositionen(positionen);
      const haupt = splits.find(s => /^\d+$/.test(s.warenkonto))?.warenkonto ?? splits[0]?.warenkonto ?? '4030';
      const aenderungen = berechnePreisAenderungen(r, lieferant, hist, schwelle);
      alleAenderungen.push(...aenderungen);
      hist = aktualisierePreisHistorie(hist, [r], lieferant);
      const jetzt = new Date().toISOString();
      const id = vorhanden?.id ?? `fs-${r.rechnungsNr}-${Date.now()}`;
      const entry: InvoiceEntry = {
        id,
        date: r.datum,
        supplierName: lieferant,
        amountGross: bruttoOffiziell ?? r.bruttoTotal,
        amountNet: nettoOffiziell ?? r.nettoTotal,
        vatIncluded: false,
        vatRate: r.nettoTotal > 0 ? Math.round((r.mwstTotal / r.nettoTotal) * 1000) / 10 : 0,
        reference: r.rechnungsNr,
        note: `Feldschlösschen-PDF · ${r.positionen.length} Positionen`,
        ...(splits.length > 1 ? { kontoSplits: splits } : { warenkonto: haupt }),
        kategorie: kategorieFromKonto(haupt),
        ...(vorhanden?.receiptPath ? { receiptPath: vorhanden.receiptPath } : {}),
        createdAt: vorhanden?.createdAt ?? jetzt,
        updatedAt: jetzt,
      };
      await saveInvoiceEntry(tenantId, entry);
      if (vorhanden) ersetzt++; else neu++;
      const posMonat = await loadRechnungsPositionen(tenantId, month);
      await saveRechnungsPositionen(tenantId, month, { ...posMonat, [id]: positionen });
      if (aenderungen.length > 0) {
        const hinweise = await loadPreisHinweise(tenantId, month);
        await savePreisHinweise(tenantId, month, { ...hinweise, [id]: aenderungen });
      }
    }
    await savePreisHistorie(tenantId, hist);
    return { neu, ersetzt, offen, preisAenderungen: alleAenderungen.length };
  };

  // ── Datei-Handling: PDFs (Lieferschein/Sammelrechnung) oder ZIP (Historie) ─
  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      const pdfs = Array.from(files).filter(f => /\.pdf$/i.test(f.name));
      const zips = Array.from(files).filter(f => /\.zip$/i.test(f.name));

      if (zips.length > 0) {
        const { default: JSZip } = await import('jszip');
        const eintraege: FsHistorienEintrag[] = [];
        const fehler: string[] = [];
        for (const zf of zips) {
          const zip = await JSZip.loadAsync(await zf.arrayBuffer());
          const pdfNamen = Object.keys(zip.files).filter(n => /\.pdf$/i.test(n) && !zip.files[n].dir);
          for (const name of pdfNamen) {
            try {
              const blob = await zip.files[name].async('blob');
              const zeilen = await pdfZuZeilen(blob, name);
              if (detectFsPdfTyp(zeilen) !== 'sammelrechnung') { fehler.push(`${name}: keine Sammelrechnung`); continue; }
              const s = parseFsSammelrechnung(zeilen);
              if (s.failureReason) { fehler.push(`${name}: ${s.failureReason}`); continue; }
              eintraege.push(sammelrechnungZuHistorie(s));
            } catch (e) {
              fehler.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
        if (fehler.length > 0) toast.error(`${fehler.length} Datei(en) übersprungen: ${fehler[0]}`);
        if (eintraege.length === 0) { toast.error('Keine Sammelrechnungen im ZIP erkannt.'); return; }
        setHistVorschau(eintraege.sort((a, b) => a.datum.localeCompare(b.datum)));
        setLieferscheine(null); setSammel(null);
        return;
      }

      const neueLs: FsLieferschein[] = [];
      let neueSammel: FsSammelrechnung | null = null;
      for (const f of pdfs) {
        const zeilen = await pdfZuZeilen(f, f.name);
        if (!istFeldschloesschenPdf(zeilen)) { toast.error(`${f.name}: kein Feldschlösschen-PDF.`); continue; }
        const typ = detectFsPdfTyp(zeilen);
        if (typ === 'lieferschein') {
          const ls = parseFsLieferschein(zeilen);
          if (ls.failureReason) { toast.error(`${f.name}: ${ls.failureReason}`); continue; }
          neueLs.push(ls);
        } else if (typ === 'sammelrechnung') {
          const s = parseFsSammelrechnung(zeilen);
          if (s.failureReason) { toast.error(`${f.name}: ${s.failureReason}`); continue; }
          neueSammel = s;
        } else {
          toast.error(`${f.name}: weder Lieferschein noch Sammelrechnung erkannt.`);
        }
      }
      if (neueLs.length > 0) {
        setLieferscheine(neueLs);
        setAusgewaehlt(new Set(neueLs.map(l => l.lieferungNr)));
      }
      if (neueSammel) {
        setSammel(neueSammel);
        setUebernommen(new Set());
        // Erfasste FS-Rechnungen der betroffenen Monate laden und matchen
        const monate = [...new Set(neueSammel.fakturen.map(f => f.datum.slice(0, 7)).filter(Boolean))];
        const invoices = (await Promise.all(monate.map(m => loadMonthInvoices(tenantId, m)))).flat()
          .filter(iv => /feldschl/i.test(iv.supplierName));
        setMonatsInvoices(invoices);
        setAbgleich(matchFakturen(neueSammel.fakturen, invoices));
      }
      setHistVorschau(null);
    } catch (e) {
      toast.error(`Lesen fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // ── Teil A: ausgewählte Lieferscheine importieren ─────────────────────────
  const importiereLieferscheine = async () => {
    if (!lieferscheine) return;
    const zu = lieferscheine.filter(l => ausgewaehlt.has(l.lieferungNr));
    if (zu.length === 0) return;
    setBusy(true);
    try {
      const res = await importiereRechnungen(zu.map(ls => ({
        r: fsLieferscheinAlsRechnung(ls),
        nettoOffiziell: ls.totalNetto,
        bruttoOffiziell: ls.totalLieferung,
      })));
      toast.success(`${res.neu} Lieferung${res.neu === 1 ? '' : 'en'} importiert${res.ersetzt > 0 ? `, ${res.ersetzt} ersetzt` : ''}`
        + `${res.preisAenderungen > 0 ? ` · ${res.preisAenderungen} Preisänderungen` : ''}`
        + `${res.offen > 0 ? ` · ${res.offen} Positionen «Konto offen»` : ''}`);
      setLieferscheine(null);
      onImported();
    } catch (e) {
      toast.error(`Import fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // ── Teil B: fehlende Faktura aus dem Anhang übernehmen ────────────────────
  const uebernehmeFaktura = async (fakturaNr: string) => {
    if (!sammel) return;
    const anhang = sammel.anhangLieferscheine.filter(a => a.fakturaNr === fakturaNr && a.positionen.length > 0);
    if (anhang.length === 0) {
      toast.error(`Für Faktura ${fakturaNr} sind im PDF keine Positions-Seiten enthalten.`);
      return;
    }
    setBusy(true);
    try {
      // Duplikat-Wache: kein Lieferschein wird übernommen, wenn eine noch keiner
      // Faktura zugeordnete bestehende Rechnung ihm nach den Kontroll-Kriterien
      // (Datum ±7 Tage, Betrag ±0.10) nahekommt — sonst droht eine Doppelbuchung.
      const zugeordnet = new Set(abgleich?.matches.flatMap(m => m.invoiceIds) ?? []);
      const zuImportieren: typeof anhang = [];
      const blockiert: string[] = [];
      for (const a of anhang) {
        const r = fsAnhangAlsRechnung(a);
        const nahe = findeNaheRechnung(monatsInvoices, { lieferscheinNr: a.lieferscheinNr, datum: a.datum, brutto: r.bruttoTotal }, zugeordnet);
        if (nahe) blockiert.push(`Lieferschein ${a.lieferscheinNr} (CHF ${fmt(r.bruttoTotal)}) ≈ erfasste Rechnung vom ${fmtDatumCH(nahe.date)} (CHF ${fmt(nahe.amountGross)})`);
        else zuImportieren.push(a);
      }
      if (blockiert.length > 0) {
        toast.error(`Nicht übernommen (mögliches Duplikat — bitte manuell prüfen): ${blockiert.join(' · ')}`, { duration: 12000 });
      }
      if (zuImportieren.length === 0) return;
      const res = await importiereRechnungen(zuImportieren.map(a => ({ r: fsAnhangAlsRechnung(a) })));
      toast.success(`Faktura ${fakturaNr}: ${res.neu + res.ersetzt} Lieferschein(e) übernommen${res.offen > 0 ? ` · ${res.offen} «Konto offen»` : ''}`);
      setUebernommen(prev => new Set([...prev, fakturaNr]));
      // Abgleich mit frischem Bestand aktualisieren
      const monate = [...new Set(sammel.fakturen.map(f => f.datum.slice(0, 7)).filter(Boolean))];
      const invoices = (await Promise.all(monate.map(m => loadMonthInvoices(tenantId, m)))).flat()
        .filter(iv => /feldschl/i.test(iv.supplierName));
      setMonatsInvoices(invoices);
      setAbgleich(matchFakturen(sammel.fakturen, invoices));
      onImported();
    } catch (e) {
      toast.error(`Übernahme fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // ── Teil C: Historie speichern / Analyse ──────────────────────────────────
  const speichereHistorie = async () => {
    if (!histVorschau) return;
    setBusy(true);
    try {
      const proJahr = new Map<string, FsHistorienEintrag[]>();
      for (const e of histVorschau) {
        const jahr = e.datum.slice(0, 4);
        proJahr.set(jahr, [...(proJahr.get(jahr) ?? []), e]);
      }
      const teile: string[] = [];
      for (const [jahr, eintraege] of proJahr) {
        const res = await upsertFsHistorie(tenantId, jahr, eintraege); // Lock wird im Save-Pfad frisch geprüft
        teile.push(`${jahr}: ${res.neu} neu${res.ersetzt > 0 ? `, ${res.ersetzt} ersetzt` : ''}`);
      }
      toast.success(`Historie gespeichert — ${teile.join(' · ')}`);
      setHistVorschau(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const ladeAnalyse = async () => {
    const jahr = analyseJahr.trim();
    if (!/^\d{4}$/.test(jahr)) { toast.error('Jahr als JJJJ angeben.'); return; }
    setBusy(true);
    try {
      const [daten, locked] = await Promise.all([loadFsHistorie(tenantId, jahr), isFsHistorieLocked(tenantId, jahr)]);
      const eintraege = Object.values(daten).sort((a, b) => a.datum.localeCompare(b.datum));
      if (eintraege.length === 0) toast.info(`Keine Feldschlösschen-Historie für ${jahr}.`);
      setHistAnalyse({ jahr, eintraege, locked });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleLock = async () => {
    if (!histAnalyse) return;
    try {
      await setFsHistorieLock(tenantId, histAnalyse.jahr, !histAnalyse.locked);
      setHistAnalyse({ ...histAnalyse, locked: !histAnalyse.locked });
      toast.success(`Jahr ${histAnalyse.jahr} ${histAnalyse.locked ? 'entsperrt' : 'gesperrt'}.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  // ── Analyse-Aggregate ─────────────────────────────────────────────────────
  const analyse = useMemo(() => {
    if (!histAnalyse || histAnalyse.eintraege.length === 0) return null;
    const kategorien = [...new Set(histAnalyse.eintraege.flatMap(e => Object.keys(e.kategorien)))];
    const monate = [...new Set(histAnalyse.eintraege.map(e => e.monat))].sort();
    const wert = (monat: string, kat: string) =>
      histAnalyse.eintraege.filter(e => e.monat === monat).reduce((a, e) => a + (e.kategorien[kat] ?? 0), 0);
    // Preisentwicklung: Material mit mehreren unterschiedlichen Preisen zuerst
    const matPreise = new Map<string, { bezeichnung: string; punkte: Array<{ monat: string; preis: number }>; wert: number }>();
    for (const e of histAnalyse.eintraege) {
      for (const [nr, m] of Object.entries(e.material)) {
        const cur = matPreise.get(nr) ?? { bezeichnung: m.bezeichnung, punkte: [], wert: 0 };
        if (m.letzterPreis > 0) cur.punkte.push({ monat: e.monat, preis: m.letzterPreis });
        cur.wert += m.wert;
        if (m.bezeichnung.length > cur.bezeichnung.length) cur.bezeichnung = m.bezeichnung;
        matPreise.set(nr, cur);
      }
    }
    const preisTop = [...matPreise.entries()]
      .map(([nr, m]) => {
        const preise = m.punkte.map(p => p.preis);
        return { nr, ...m, min: Math.min(...preise), max: Math.max(...preise), letzter: preise[preise.length - 1] };
      })
      .filter(m => m.punkte.length > 0)
      .sort((a, b) => b.wert - a.wert)
      .slice(0, 15);
    return { kategorien, monate, wert, preisTop };
  }, [histAnalyse]);

  const [gegenprobeZeilen, setGegenprobeZeilen] = useState<ReturnType<typeof kategorienGegenprobe> | null>(null);
  const ladeGegenprobe = async () => {
    if (!sammel || !abgleich) return;
    setBusy(true);
    try {
      const ids = new Set(abgleich.matches.flatMap(m => m.invoiceIds));
      const monate = [...new Set(monatsInvoices.filter(iv => ids.has(iv.id)).map(iv => iv.date.slice(0, 7)))];
      const positionen = [];
      for (const m of monate) {
        const pos = await loadRechnungsPositionen(tenantId, m);
        for (const id of Object.keys(pos)) if (ids.has(id)) positionen.push(...pos[id]);
      }
      if (positionen.length === 0) {
        toast.info('Keine gespeicherten Positionen zu den gematchten Rechnungen — Gegenprobe nicht möglich.');
        return;
      }
      setGegenprobeZeilen(kategorienGegenprobe(sammel.kategorien, positionen));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3" data-testid="fs-import">
      <div className="flex flex-wrap items-center gap-3">
        <label className={cn(
          'inline-flex items-center gap-2 text-xs font-medium rounded-lg border border-dashed px-3 py-2 cursor-pointer transition-colors',
          busy ? 'opacity-60 pointer-events-none' : 'hover:bg-muted/40',
        )}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Beer className="h-4 w-4 text-amber-600" />}
          Feldschlösschen-PDF importieren (Lieferschein · Monatsrechnung · ZIP-Historie)
          <input type="file" accept=".pdf,.zip,application/pdf,application/zip" multiple className="hidden" disabled={busy}
            data-testid="input-fs-pdf"
            onChange={e => { void handleFiles(e.target.files); e.target.value = ''; }} />
        </label>
        <button type="button" className="text-[11px] text-muted-foreground underline decoration-dotted hover:text-foreground"
          onClick={() => { setHistAnalyse(null); void ladeAnalyse(); }} data-testid="fs-analyse-oeffnen">
          Historie/Analyse…
        </button>
        {histAnalyse !== null && (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            Jahr
            <input value={analyseJahr} onChange={e => setAnalyseJahr(e.target.value)}
              className="h-6 w-14 px-1 text-[11px] text-right tabular-nums border border-border rounded bg-background" />
            <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => void ladeAnalyse()}>Laden</Button>
          </span>
        )}
      </div>

      {/* ── Teil A: Lieferschein-Vorschau ── */}
      {lieferscheine && lieferscheine.length > 0 && (
        <div className="rounded-lg border border-border bg-muted/20 px-4 py-3 text-xs space-y-2" data-testid="fs-liefer-vorschau">
          <div className="flex items-center gap-3">
            <span className="font-medium">{lieferscheine.length} Lieferschein{lieferscheine.length === 1 ? '' : 'e'} · Lieferant: {lieferant}</span>
            <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[11px]" onClick={() => setLieferscheine(null)}>
              <X className="h-3 w-3 mr-0.5" /> Verwerfen
            </Button>
          </div>
          <div className="max-h-48 overflow-y-auto space-y-0.5">
            {lieferscheine.map(ls => {
              const offen = ls.positionen.filter(p => p.mwstCode !== 0 && p.warengruppe === '').length;
              return (
                <label key={ls.lieferungNr} className="flex items-center gap-2 tabular-nums cursor-pointer hover:bg-muted/40 rounded px-1 py-0.5">
                  <input type="checkbox" className="h-3.5 w-3.5 accent-amber-600"
                    checked={ausgewaehlt.has(ls.lieferungNr)}
                    onChange={() => setAusgewaehlt(prev => {
                      const next = new Set(prev);
                      if (next.has(ls.lieferungNr)) next.delete(ls.lieferungNr); else next.add(ls.lieferungNr);
                      return next;
                    })} />
                  <span className="w-20">{fmtDatumCH(ls.lieferdatum)}</span>
                  <span className="w-28 truncate">Lieferung {ls.lieferungNr}</span>
                  <span className="text-muted-foreground">{ls.positionen.length} Pos.</span>
                  {offen > 0 && (
                    <span className="text-amber-600 dark:text-amber-400 inline-flex items-center gap-0.5">
                      <AlertTriangle className="h-3 w-3" />{offen} offen
                    </span>
                  )}
                  <span className="ml-auto">CHF {ls.totalLieferung !== null ? fmt(ls.totalLieferung) : '—'}</span>
                </label>
              );
            })}
          </div>
          <div className="flex justify-end">
            <Button size="sm" className="h-7 px-3 text-xs" disabled={busy || ausgewaehlt.size === 0}
              onClick={() => void importiereLieferscheine()} data-testid="fs-liefer-import">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              {ausgewaehlt.size} Lieferung{ausgewaehlt.size === 1 ? '' : 'en'} importieren
            </Button>
          </div>
        </div>
      )}

      {/* ── Teil B: Sammelrechnung = Kontrolle ── */}
      {sammel && abgleich && (
        <div className="rounded-lg border border-border bg-muted/20 px-4 py-3 text-xs space-y-3" data-testid="fs-sammel-kontrolle">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-medium">
              Monatsrechnung {sammel.nr} · {fmtDatumCH(sammel.datum)} · CHF {sammel.endbetrag !== null ? fmt(sammel.endbetrag) : '—'}
            </span>
            <span className={cn('inline-flex items-center gap-1 font-medium',
              abgleich.vorhanden === abgleich.gesamt ? 'text-emerald-600' : 'text-red-600 dark:text-red-400')}>
              {abgleich.vorhanden === abgleich.gesamt ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
              {abgleich.vorhanden} von {abgleich.gesamt} Lieferungen erfasst
            </span>
            <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[11px]"
              onClick={() => { setSammel(null); setAbgleich(null); setGegenprobeZeilen(null); }}>
              <X className="h-3 w-3 mr-0.5" /> Schliessen
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Die Monatsrechnung dient NUR der Kontrolle — sie wird nie zusätzlich gebucht. Fehlende Lieferungen können aus den im PDF enthaltenen Rechnungs-Seiten übernommen werden.
          </p>
          <div className="space-y-0.5">
            {abgleich.matches.map(m => (
              <div key={m.faktura.nr} className={cn('flex items-center gap-2 tabular-nums rounded px-1 py-0.5',
                m.status === 'fehlt' && 'bg-red-500/10 text-red-700 dark:text-red-300')}
                data-testid={`fs-faktura-${m.faktura.nr}`}>
                <span className="w-24">Faktura {m.faktura.nr}</span>
                <span className="w-20">{fmtDatumCH(m.faktura.datum)}</span>
                <span className="w-24 text-right">CHF {fmt(m.faktura.endbetrag)}</span>
                {m.status === 'vorhanden' ? (
                  <span className="text-emerald-600 inline-flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> erfasst ({m.invoiceIds.length} Rechnung{m.invoiceIds.length === 1 ? '' : 'en'})
                  </span>
                ) : uebernommen.has(m.faktura.nr) ? (
                  <span className="text-muted-foreground">übernommen — Abgleich aktualisiert…</span>
                ) : (
                  <>
                    <span>fehlt</span>
                    <Button size="sm" variant="outline" className="ml-auto h-6 px-2 text-[11px]" disabled={busy}
                      onClick={() => void uebernehmeFaktura(m.faktura.nr)} data-testid={`fs-uebernehmen-${m.faktura.nr}`}>
                      Aus Monatsrechnung übernehmen
                    </Button>
                  </>
                )}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground border-t border-border/40 pt-2">
            <span>Σ erfasst (gematcht): CHF {fmt(abgleich.summeErfasst)}</span>
            <span>Σ Monatsrechnung: CHF {fmt(abgleich.summeMonatsrechnung)}</span>
            <Button size="sm" variant="outline" className="ml-auto h-6 px-2 text-[11px]" disabled={busy}
              onClick={() => void ladeGegenprobe()} data-testid="fs-gegenprobe">Kategorien-Gegenprobe</Button>
          </div>
          {gegenprobeZeilen && (
            <div className="space-y-0.5" data-testid="fs-gegenprobe-tabelle">
              <div className="flex items-center gap-2 font-medium text-muted-foreground">
                <span className="flex-1">Kategorie (netto)</span>
                <span className="w-24 text-right">Monatsrechnung</span>
                <span className="w-24 text-right">Erfasst</span>
                <span className="w-20 text-right">Diff</span>
              </div>
              {gegenprobeZeilen.map(z => (
                <div key={z.kategorie} className="flex items-center gap-2 tabular-nums">
                  <span className="flex-1">{z.kategorie}</span>
                  <span className="w-24 text-right">{fmt(z.monatsrechnung)}</span>
                  <span className="w-24 text-right">{z.erfasst === null ? '—' : fmt(z.erfasst)}</span>
                  <span className={cn('w-20 text-right', z.diff !== null && Math.abs(z.diff) > 0.05 && 'text-amber-600 dark:text-amber-400')}>
                    {z.diff === null ? '—' : fmt(z.diff)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Teil C: Historie-Vorschau (ZIP) ── */}
      {histVorschau && (
        <div className="rounded-lg border border-border bg-muted/20 px-4 py-3 text-xs space-y-2" data-testid="fs-historie-vorschau">
          <div className="flex items-center gap-3">
            <span className="font-medium">{histVorschau.length} Sammelrechnung{histVorschau.length === 1 ? '' : 'en'} aus ZIP (Vorschau)</span>
            <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[11px]" onClick={() => setHistVorschau(null)}>
              <X className="h-3 w-3 mr-0.5" /> Verwerfen
            </Button>
          </div>
          <div className="max-h-48 overflow-y-auto space-y-0.5">
            {histVorschau.map(e => (
              <div key={e.sammelNr} className="flex items-center gap-2 tabular-nums px-1 py-0.5">
                <span className="w-20">{fmtDatumCH(e.datum)}</span>
                <span className="w-28">Nr. {e.sammelNr}</span>
                <span className="text-muted-foreground">{e.fakturaAnzahl} Fakturas · {Object.keys(e.kategorien).length} Kategorien</span>
                <span className="ml-auto">CHF {e.endbetrag !== null ? fmt(e.endbetrag) : '—'}</span>
              </div>
            ))}
          </div>
          <div className="flex justify-end">
            <Button size="sm" className="h-7 px-3 text-xs" disabled={busy} onClick={() => void speichereHistorie()}
              data-testid="fs-historie-speichern">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              Historie speichern (dublettensicher, pro Jahr)
            </Button>
          </div>
        </div>
      )}

      {/* ── Teil C: Analyse ── */}
      {histAnalyse && (
        <div className="rounded-lg border border-border bg-muted/20 px-4 py-3 text-xs space-y-3" data-testid="fs-analyse">
          <div className="flex items-center gap-3">
            <span className="font-medium">Feldschlösschen-Historie {histAnalyse.jahr} · {histAnalyse.eintraege.length} Monatsrechnungen</span>
            <button type="button" className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => void toggleLock()} data-testid="fs-lock-toggle">
              {histAnalyse.locked ? <Lock className="h-3.5 w-3.5 text-red-500" /> : <LockOpen className="h-3.5 w-3.5" />}
              {histAnalyse.locked ? 'gesperrt' : 'offen'}
            </button>
            <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[11px]" onClick={() => setHistAnalyse(null)}>
              <X className="h-3 w-3 mr-0.5" /> Schliessen
            </Button>
          </div>
          {analyse && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] tabular-nums">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="text-left font-medium py-0.5">Kategorie (netto)</th>
                      {analyse.monate.map(m => <th key={m} className="text-right font-medium px-1.5">{m.slice(5)}</th>)}
                      <th className="text-right font-medium pl-2">Σ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analyse.kategorien.map(kat => {
                      const total = analyse.monate.reduce((a, m) => a + analyse.wert(m, kat), 0);
                      return (
                        <tr key={kat} className="border-t border-border/30">
                          <td className="py-0.5 pr-2">{kat}</td>
                          {analyse.monate.map(m => {
                            const v = analyse.wert(m, kat);
                            return <td key={m} className="text-right px-1.5">{Math.abs(v) < 0.005 ? '' : fmt(v)}</td>;
                          })}
                          <td className="text-right pl-2 font-medium">{fmt(total)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {analyse.preisTop.length > 0 && (
                <div className="space-y-0.5">
                  <div className="font-medium text-muted-foreground">Preisentwicklung (Top-Material nach Wert)</div>
                  {analyse.preisTop.map(m => (
                    <div key={m.nr} className="flex items-center gap-2 tabular-nums">
                      <span className="w-16 text-muted-foreground">{m.nr}</span>
                      <span className="flex-1 truncate" title={m.bezeichnung}>{m.bezeichnung}</span>
                      <span className="w-40 text-right">
                        {m.min === m.max ? `CHF ${fmt(m.min)}` : `CHF ${fmt(m.min)} – ${fmt(m.max)} · zuletzt ${fmt(m.letzter)}`}
                      </span>
                      <span className="w-24 text-right text-muted-foreground">Σ {fmt(m.wert)}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
