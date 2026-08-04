/**
 * Feldschlösschen PDF-Import (Lieferscheine, Monats-Sammelrechnung, Historie)
 * ===========================================================================
 * Teil A — Lieferschein-/Einzelrechnungs-PDFs: Positionen mit MWST-Codes
 *   3C/4C/C0 → FS-Kategorie → Konto über die Warengruppen-Tabelle (FS-Standards:
 *   Bier→4030, Spirituosen→4040, Wein→4020, alkoholfrei→4050, Andere Güter /
 *   Zu-/Abschläge→4701 Betriebskosten, Leergut→Depot neutral). Preisüberwachung
 *   pro Material-Nr (gleiche Mechanik wie Transgourmet). Dublettensicher:
 *   Lieferant + Lieferung-Nr + Datum ersetzt den bestehenden Eintrag.
 * Teil B — Sammelrechnung = MASSGEBLICH: Fakturas werden über Datum (±7 Tage)
 *   + Betrag (±0.10) gegen die erfassten Einzel-Lieferungen gematcht;
 *   VORHANDENE gelten als bestätigt (Fakturas bündeln oft mehrere Lieferscheine
 *   — kein 1:1-Überschreiben möglich), FEHLENDE werden aus den eingebetteten
 *   Rechnungs-Seiten übernommen — quelle='monatsrechnung' + final: ein späterer
 *   Lieferschein-Upload verschlechtert die finalen Werte nicht mehr.
 * Teil C — Jahres-ZIP (Sammelrechnungen 2024/2025/…): bucht ALLE eingebetteten
 *   Lieferscheine mit ihrem Lieferdatum als Warenkosten (inkl. Preis-Historie)
 *   UND speichert die Monats-Zusammenfassungen als Historie; Upsert auf
 *   Lieferant+Lieferung-Nr+Datum (ersetzt, dupliziert nie); Jahr-Sperre wird
 *   frisch im Save-Pfad geprüft.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { AlertTriangle, Beer, CheckCircle2, Loader2, Lock, LockOpen, X } from 'lucide-react';
import { extractGnPdfTextItems } from '@/lib/gn-pdf-text';
import { reconstructGnPdfLines } from '@/lib/gn-pdf-lines';
import {
  toFsZeilen, detectFsPdfTyp, istFeldschloesschenPdf,
  parseFsLieferschein, parseFsSammelrechnung, fsLieferscheinAlsRechnung,
  fsAnhangAlsRechnung, matchFakturen, kategorienGegenprobe, findeNaheRechnung,
  sammelrechnungZuHistorie,
  type FsLieferschein, type FsSammelrechnung, type FakturaAbgleich,
} from '@/lib/feldschloesschen';
import {
  berechnePreisAenderungen, aktualisierePreisHistorie, DEFAULT_PREIS_SCHWELLE,
  type ParsedCsvRechnung, type PreisAenderung,
} from '@/lib/waren-positionen';
import {
  loadMonthInvoices, loadPreisHistorie,
  loadPreisSchwelle, loadRechnungsPositionen,
  loadFsHistorie, upsertFsHistorie, isFsHistorieLocked, setFsHistorieLock,
  erstelleWarenImportSnapshot, saveWarenImportUndo,
  type InvoiceEntry, type Supplier,
} from '@/lib/waren-db';
import { kernImportiereFsRechnungen } from '@/lib/fs-import';
import { fmtDatumCH } from '@/lib/waren-fibu-matches';
import type { TenantId } from '@/contexts/TenantContext';
import type { FsHistorienEintrag } from '@/lib/feldschloesschen';
import { WarenImportUndoButton } from '@/components/waren/WarenCsvImport';

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
  /** Jahres-ZIP: geparste Sammelrechnungen — bucht Warenkosten UND Historie. */
  const [zipVorschau, setZipVorschau] = useState<FsSammelrechnung[] | null>(null);
  const [histAnalyse, setHistAnalyse] = useState<{ jahr: string; eintraege: FsHistorienEintrag[]; locked: boolean } | null>(null);
  const [analyseJahr, setAnalyseJahr] = useState(String(new Date().getFullYear() - 1));
  const [undoRefresh, setUndoRefresh] = useState(0);

  const lieferant = useMemo(
    () => suppliers.find(s => /feldschl/i.test(s.name))?.name ?? 'Feldschlösschen',
    [suppliers],
  );

  // ── Gemeinsame Import-Pipeline (Lieferschein & Anhang-Übernahme) ──────────
  // Kern in src/lib/fs-import.ts (testbar); hier nur die gebundene Variante.
  const kernImportiereRechnungen = (
    rechnungen: Array<{ r: ParsedCsvRechnung; nettoOffiziell?: number | null; bruttoOffiziell?: number | null }>,
    opts?: { quelle?: 'monatsrechnung' },
  ) => kernImportiereFsRechnungen(tenantId, lieferant, rechnungen, opts);

  /** Wie kern…, aber mit eigenem Undo-Datensatz (Typ «fs»). */
  const importiereRechnungen = async (
    rechnungen: Array<{ r: ParsedCsvRechnung; nettoOffiziell?: number | null; bruttoOffiziell?: number | null }>,
    undoLabel = 'Feldschlösschen-PDF',
    opts?: { quelle?: 'monatsrechnung' },
  ) => {
    // Undo-Snapshot VOR dem Schreiben: betroffene Monate (±Nachbarmonate wegen
    // möglicher Ersetzung provisorischer Einträge) + Preis-Historie.
    const monate = [...new Set(rechnungen.flatMap(({ r }) => {
      const d = new Date(`${r.datum}T00:00:00Z`);
      const m = (off: number) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + off); return x.toISOString().slice(0, 7); };
      return [m(-1), m(0), m(1)];
    }))];
    const vorher = await erstelleWarenImportSnapshot(tenantId, { monate, mitPreisHistorie: true });
    const res = await kernImportiereRechnungen(rechnungen, opts);
    const nachher = await erstelleWarenImportSnapshot(tenantId, { monate, mitPreisHistorie: true });
    await saveWarenImportUndo(tenantId, {
      typ: 'fs', zeitpunkt: new Date().toISOString(),
      label: undoLabel, anzahlRechnungen: rechnungen.length,
      vorher, nachher,
    });
    setUndoRefresh(x => x + 1);
    return res;
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
        const sammelListe: FsSammelrechnung[] = [];
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
              sammelListe.push(s);
            } catch (e) {
              fehler.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
        if (fehler.length > 0) toast.error(`${fehler.length} Datei(en) übersprungen: ${fehler[0]}`);
        if (sammelListe.length === 0) { toast.error('Keine Sammelrechnungen im ZIP erkannt.'); return; }
        setZipVorschau(sammelListe.sort((a, b) => a.datum.localeCompare(b.datum)));
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
      setZipVorschau(null);
    } catch (e) {
      toast.error(`Lesen fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // ── Teil 1: Preisüberwachung in der Lieferschein-Vorschau ─────────────────
  // Gleiche Mechanik wie Transgourmet: pro Material-Nr gegen die gespeicherte
  // Preis-Historie; Pfand/Leergut (MWST-Code C0) ist ausgenommen (im Berechner).
  const [preisVorschau, setPreisVorschau] = useState<PreisAenderung[] | null>(null);
  const [preisFilter, setPreisFilter] = useState<'erhoehung' | 'senkung' | 'klein' | 'alle'>('erhoehung');
  useEffect(() => {
    let aktiv = true;
    if (!lieferscheine || lieferscheine.length === 0) { setPreisVorschau(null); return; }
    void (async () => {
      try {
        const [historie, schwelle] = await Promise.all([
          loadPreisHistorie(tenantId),
          loadPreisSchwelle(tenantId).catch(() => DEFAULT_PREIS_SCHWELLE),
        ]);
        let hist = historie;
        const alle: PreisAenderung[] = [];
        for (const ls of [...lieferscheine].sort((a, b) => a.lieferdatum.localeCompare(b.lieferdatum))) {
          const r = fsLieferscheinAlsRechnung(ls);
          alle.push(...berechnePreisAenderungen(r, lieferant, hist, schwelle));
          hist = aktualisierePreisHistorie(hist, [r], lieferant);
        }
        if (aktiv) setPreisVorschau(alle);
      } catch { if (aktiv) setPreisVorschau(null); }
    })();
    return () => { aktiv = false; };
  }, [lieferscheine, tenantId, lieferant]);

  const preisGefiltert = useMemo(() => {
    if (!preisVorschau) return [];
    const pct = (a: PreisAenderung) => a.diffPct ?? 0;
    switch (preisFilter) {
      case 'erhoehung': return preisVorschau.filter(a => a.stark && a.erhoehung).sort((a, b) => pct(b) - pct(a));
      case 'senkung': return preisVorschau.filter(a => a.stark && !a.erhoehung).sort((a, b) => pct(a) - pct(b));
      case 'klein': return preisVorschau.filter(a => !a.stark).sort((a, b) => Math.abs(pct(b)) - Math.abs(pct(a)));
      case 'alle': return [...preisVorschau].sort((a, b) => Math.abs(pct(b)) - Math.abs(pct(a)));
    }
  }, [preisVorschau, preisFilter]);

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
      })), 'Feldschlösschen-Lieferscheine');
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
      const res = await importiereRechnungen(
        zuImportieren.map(a => ({ r: fsAnhangAlsRechnung(a) })),
        'Monatsrechnung: fehlende Lieferungen ergänzt',
        { quelle: 'monatsrechnung' },
      );
      toast.success(`Faktura ${fakturaNr}: ${res.neu + res.ersetzt} Lieferung(en) aus der Monatsrechnung ergänzt (final — massgebliche Monatsrechnung)${res.offen > 0 ? ` · ${res.offen} «Konto offen»` : ''}`);
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

  // ── Teil C: Jahres-ZIP importieren (Warenkosten + Preis-Historie + Historie) ─
  const importiereZip = async () => {
    if (!zipVorschau) return;
    // Alle Lieferungen aus den eingebetteten Lieferschein-Seiten — mit LIEFERDATUM.
    const lieferungen = zipVorschau.flatMap(s => s.anhangLieferscheine.filter(a => a.positionen.length > 0));
    const histEintraege = zipVorschau.map(sammelrechnungZuHistorie);
    if (lieferungen.length === 0 && histEintraege.length === 0) return;
    setBusy(true);
    try {
      const proJahr = new Map<string, FsHistorienEintrag[]>();
      for (const e of histEintraege) proJahr.set(e.datum.slice(0, 4), [...(proJahr.get(e.datum.slice(0, 4)) ?? []), e]);
      const jahre = [...new Set([...proJahr.keys(), ...lieferungen.map(l => l.datum.slice(0, 4))])].sort();
      // Jahr-Sperre VOR jedem Schreiben frisch prüfen (gilt auch für die Warenkosten-Buchung).
      for (const j of jahre) {
        if (await isFsHistorieLocked(tenantId, j)) {
          toast.error(`Jahr ${j} ist gesperrt (abgeschlossen) — Import abgebrochen, nichts geschrieben.`);
          return;
        }
      }
      // EIN Undo-Datensatz für alles: betroffene Monate + Preis-Historie + Historien-Jahre.
      const monate = [...new Set(lieferungen.map(l => l.datum.slice(0, 7)))];
      const vorher = await erstelleWarenImportSnapshot(tenantId, { monate, mitPreisHistorie: true, jahre });
      const res = lieferungen.length > 0
        ? await kernImportiereRechnungen(lieferungen.map(a => ({ r: fsAnhangAlsRechnung(a) })))
        : { neu: 0, ersetzt: 0, offen: 0, provisorischErsetzt: 0, preisAenderungen: 0, monate: [] as string[], bereitsFinal: 0, ueberschrieben: 0 };
      const teile: string[] = [];
      for (const [jahr, eintraege] of proJahr) {
        const hres = await upsertFsHistorie(tenantId, jahr, eintraege); // Lock wird im Save-Pfad erneut geprüft
        teile.push(`${jahr}: ${hres.neu + hres.ersetzt} Monatsrechnungen`);
      }
      const nachher = await erstelleWarenImportSnapshot(tenantId, { monate, mitPreisHistorie: true, jahre });
      await saveWarenImportUndo(tenantId, {
        typ: 'fs_historie', zeitpunkt: new Date().toISOString(),
        label: `Jahres-ZIP (${jahre.join(', ')})`, anzahlRechnungen: lieferungen.length,
        vorher, nachher,
      });
      setUndoRefresh(x => x + 1);
      toast.success(
        `Jahres-Import: ${res.neu} Lieferung${res.neu === 1 ? '' : 'en'} gebucht${res.ersetzt > 0 ? `, ${res.ersetzt} ersetzt` : ''}`
        + `${res.preisAenderungen > 0 ? ` · ${res.preisAenderungen} Preisänderungen` : ''}`
        + ` · Historie ${teile.join(' · ')}`,
        { duration: 10000 },
      );
      setZipVorschau(null);
      onImported();
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

      <WarenImportUndoButton tenantId={tenantId} typ="fs" refresh={undoRefresh} onUndone={onImported} />
      <WarenImportUndoButton tenantId={tenantId} typ="fs_historie" refresh={undoRefresh}
        onUndone={() => { setHistAnalyse(null); setZipVorschau(null); onImported(); }} />

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
          {/* Preisüberwachung — VOR dem Schreiben sichtbar, gefiltert nach Relevanz */}
          {preisVorschau && preisVorschau.length > 0 && (() => {
            const erh = preisVorschau.filter(a => a.stark && a.erhoehung).length;
            const senk = preisVorschau.filter(a => a.stark && !a.erhoehung).length;
            const klein = preisVorschau.filter(a => !a.stark).length;
            const filterBtn = (id: typeof preisFilter, text: string) => (
              <button key={id} type="button" onClick={() => setPreisFilter(id)}
                className={cn('rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                  preisFilter === id ? 'bg-foreground text-background border-foreground font-medium' : 'border-border text-muted-foreground hover:bg-muted/40')}
                data-testid={`fs-preisfilter-${id}`}>
                {text}
              </button>
            );
            return (
              <div className="border-t border-border/40 pt-2 space-y-1" data-testid="fs-preis-vorschau">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-muted-foreground mr-1">Preisänderungen ({preisVorschau.length})</span>
                  {filterBtn('erhoehung', `Erhöhungen (${erh})`)}
                  {filterBtn('senkung', `Senkungen (${senk})`)}
                  {filterBtn('klein', `kleine (${klein})`)}
                  {filterBtn('alle', 'alle')}
                </div>
                <div className="max-h-40 overflow-y-auto space-y-0.5">
                  {preisGefiltert.map(a => (
                    <div key={a.key} className={cn('flex items-center gap-2 tabular-nums px-1 py-0.5 rounded',
                      a.stark && (a.erhoehung ? 'bg-red-500/10 text-red-700 dark:text-red-300' : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'))}>
                      <span className="w-16 text-muted-foreground">{a.artNr}</span>
                      <span className="flex-1 truncate" title={a.artikel}>{a.artikel}</span>
                      <span className="w-32 text-right">CHF {fmt(a.alt)} → {fmt(a.neu)}</span>
                      <span className="w-16 text-right font-medium">{a.diffPct === null ? '—' : `${a.diffPct > 0 ? '+' : ''}${a.diffPct.toFixed(1)} %`}</span>
                      <span className="w-20 text-right text-muted-foreground">seit {fmtDatumCH(a.seit)}</span>
                    </div>
                  ))}
                  {preisGefiltert.length === 0 && <div className="text-muted-foreground px-1">Keine Einträge in diesem Filter.</div>}
                </div>
              </div>
            );
          })()}
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
            <span className="text-[11px] text-muted-foreground tabular-nums" data-testid="fs-sammel-zaehler">
              bereits vorhanden, unverändert: {abgleich.vorhanden} · aus Monatsrechnung ergänzbar (fehlen): {abgleich.gesamt - abgleich.vorhanden}
            </span>
            <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[11px]"
              onClick={() => { setSammel(null); setAbgleich(null); setGegenprobeZeilen(null); }}>
              <X className="h-3 w-3 mr-0.5" /> Schliessen
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Die Monatsrechnung ist MASSGEBLICH. Vorhandene Lieferungen gelten als bestätigt (Fakturas bündeln oft mehrere
            Lieferscheine). Fehlende werden aus den eingebetteten Rechnungs-Seiten final übernommen (gekennzeichnet
            «aus Monatsrechnung»); ein späterer Lieferschein-Upload derselben Lieferung wird als «bereits final» übersprungen.
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

      {/* ── Teil C: Jahres-ZIP-Vorschau (bucht Warenkosten + Historie) ── */}
      {zipVorschau && (() => {
        const lieferungen = zipVorschau.flatMap(s => s.anhangLieferscheine.filter(a => a.positionen.length > 0));
        const ohnePositionen = zipVorschau.reduce((a, s) => a + s.anhangLieferscheine.filter(x => x.positionen.length === 0).length, 0);
        const jahre = [...new Set([...zipVorschau.map(s => s.datum.slice(0, 4)), ...lieferungen.map(l => l.datum.slice(0, 4))])].sort();
        return (
        <div className="rounded-lg border border-border bg-muted/20 px-4 py-3 text-xs space-y-2" data-testid="fs-historie-vorschau">
          <div className="flex items-center gap-3">
            <span className="font-medium">
              Jahres-ZIP {jahre.join(', ')} · {zipVorschau.length} Sammelrechnung{zipVorschau.length === 1 ? '' : 'en'} · {lieferungen.length} Lieferungen (Vorschau)
            </span>
            <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[11px]" onClick={() => setZipVorschau(null)}>
              <X className="h-3 w-3 mr-0.5" /> Verwerfen
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Bucht alle Lieferungen mit ihrem LIEFERDATUM aus den eingebetteten Lieferschein-Seiten (Warenkosten + Preis-Historie)
            und speichert die Monats-Zusammenfassungen für die Analyse. Erneuter Upload ersetzt, dupliziert nie.
            {ohnePositionen > 0 && ` ${ohnePositionen} Lieferung(en) ohne Positions-Seiten werden übersprungen.`}
          </p>
          <div className="max-h-48 overflow-y-auto space-y-0.5">
            {zipVorschau.map(s => (
              <div key={s.nr} className="flex items-center gap-2 tabular-nums px-1 py-0.5">
                <span className="w-20">{fmtDatumCH(s.datum)}</span>
                <span className="w-28">Nr. {s.nr}</span>
                <span className="text-muted-foreground">
                  {s.fakturen.length} Fakturas · {s.anhangLieferscheine.filter(a => a.positionen.length > 0).length} Lieferungen mit Positionen
                </span>
                <span className="ml-auto">CHF {s.endbetrag !== null ? fmt(s.endbetrag) : '—'}</span>
              </div>
            ))}
          </div>
          <div className="flex justify-end">
            <Button size="sm" className="h-7 px-3 text-xs" disabled={busy || (lieferungen.length === 0 && zipVorschau.length === 0)}
              onClick={() => void importiereZip()} data-testid="fs-historie-speichern">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              Jahr importieren: {lieferungen.length} Lieferungen buchen + Historie speichern
            </Button>
          </div>
        </div>
        );
      })()}

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
