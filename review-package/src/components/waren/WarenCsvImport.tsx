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
  DEFAULT_MARKT_LIEFERANTEN, lieferantFuerMarkt, marktNummernWarnung,
  type ArtikelKontenMapping, type CsvParseErgebnis, type PreisAenderung, type PreisHistorie, type PreisSchwelle,
  type WarengruppenMapping, type MarktLieferantenMapping,
} from '@/lib/waren-positionen';
import {
  PositionenKontierungListe, effektiveArtikelKonten, offeneAnzahl,
} from '@/components/waren/PositionenKontierungVorschau';
import { loadArtikelKonten, saveArtikelKonten } from '@/lib/waren-db';
import {
  loadMonthInvoices, saveInvoiceEntry, loadPreisHistorie, savePreisHistorie,
  loadPreisSchwelle, savePreisSchwelle, loadPreisHinweise, savePreisHinweise,
  loadWarengruppenMapping, saveWarengruppenMapping, loadRechnungsPositionen, saveRechnungsPositionen,
  loadMarktLieferantenMapping, saveMarktLieferantenMapping,
  erstelleWarenImportSnapshot, saveWarenImportUndo, loadWarenImportUndo, undoWarenImport,
  kategorieFromKonto, type InvoiceEntry, type Supplier, type WarenImportTyp,
} from '@/lib/waren-db';
import { fmtDatumCH } from '@/lib/waren-fibu-matches';
import type { TenantId } from '@/contexts/TenantContext';

const fmt = (n: number) => n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * «Letzter Import rückgängig machen» — pro Mandant und Import-Typ genau ein Slot.
 * Zeigt Typ, Zeitpunkt und Anzahl Rechnungen des rückgängig machbaren Imports.
 * Konfliktschutz und Jahr-Sperre werden in undoWarenImport (Datenschicht) geprüft.
 */
export function WarenImportUndoButton({ tenantId, typ, refresh, onUndone }: {
  tenantId: TenantId; typ: WarenImportTyp; refresh: number; onUndone: () => void;
}) {
  const [rec, setRec] = useState<Awaited<ReturnType<typeof loadWarenImportUndo>>>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    loadWarenImportUndo(tenantId, typ).then(r => { if (alive) setRec(r); });
    return () => { alive = false; };
  }, [tenantId, typ, refresh]);
  if (!rec) return null;
  const zeit = new Date(rec.zeitpunkt).toLocaleString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return (
    <div className="flex items-center gap-2 text-xs border border-border/50 rounded-md px-2 py-1.5 bg-muted/20" data-testid={`waren-undo-${typ}`}>
      <span className="text-muted-foreground truncate">
        Letzter Import: <span className="text-foreground">{rec.label}</span> · {zeit} · {rec.anzahlRechnungen} Rechnung{rec.anzahlRechnungen === 1 ? '' : 'en'}
      </span>
      <Button size="sm" variant="outline" className="h-6 px-2 text-[11px] shrink-0" disabled={busy}
        data-testid={`waren-undo-button-${typ}`}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await undoWarenImport(tenantId, typ);
            toast.success(`Import rückgängig gemacht: ${r.label} (${r.anzahlRechnungen} Rechnung${r.anzahlRechnungen === 1 ? '' : 'en'}) — Stand vor dem Import wiederhergestellt.`);
            setRec(null);
            onUndone();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
          } finally { setBusy(false); }
        }}>
        {busy ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
        Letzter Import rückgängig machen
      </Button>
    </div>
  );
}

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

/**
 * Einstellungen-Editor «Markt → Lieferant» (CSV-Import, mandantengetrennt).
 * Standard: BGH → Transgourmet, Bern/Moosseedorf → Prodega. Unbekannte Märkte
 * werden beim Import als «Lieferant offen» blockiert, nie geraten.
 */
export function MarktLieferantenEditor({ tenantId, canEdit }: { tenantId: TenantId; canEdit: boolean }) {
  const [mapping, setMapping] = useState<MarktLieferantenMapping | null>(null);
  const [neuMarkt, setNeuMarkt] = useState('');
  const [neuLieferant, setNeuLieferant] = useState('');
  const mappingRef = useRef<MarktLieferantenMapping | null>(null);
  useEffect(() => { mappingRef.current = mapping; }, [mapping]);
  const saveKette = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let alive = true;
    loadMarktLieferantenMapping(tenantId).then(m => { if (alive) setMapping(m); })
      .catch(() => { if (alive) setMapping(DEFAULT_MARKT_LIEFERANTEN); });
    return () => { alive = false; };
  }, [tenantId]);

  const speichern = (neu: MarktLieferantenMapping) => {
    setMapping(neu);
    mappingRef.current = neu;
    saveKette.current = saveKette.current.then(async () => {
      const cur = mappingRef.current;
      if (!cur || !cur.every(r => r.markt.trim() && r.lieferant.trim())) return;
      try { await saveMarktLieferantenMapping(tenantId, cur); }
      catch (e) { toast.error(`Speichern fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`); }
    });
  };

  if (!mapping) return <div className="text-xs text-muted-foreground">Lädt…</div>;
  return (
    <div className="space-y-1.5 text-xs" data-testid="markt-lieferanten-editor">
      <p className="text-muted-foreground">
        Lieferant pro Rechnung aus der Markt-Spalte des Portal-Exports — Transgourmet und Prodega erscheinen getrennt in Erfassung, Analyse und FIBU-Abgleich (Alias-Gruppe bleibt dort als Option).
      </p>
      <div className="space-y-1">
        {mapping.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input value={r.markt} disabled={!canEdit}
              onChange={e => speichern(mapping.map((x, xi) => xi === i ? { ...x, markt: e.target.value } : x))}
              className="h-7 text-xs w-36" data-testid={`markt-${i}`} />
            <span className="text-muted-foreground">→</span>
            <Input value={r.lieferant} disabled={!canEdit}
              onChange={e => speichern(mapping.map((x, xi) => xi === i ? { ...x, lieferant: e.target.value } : x))}
              className="h-7 text-xs flex-1" data-testid={`markt-lieferant-${i}`} />
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
          <Input placeholder="Markt (z.B. Zürich)" value={neuMarkt}
            onChange={e => setNeuMarkt(e.target.value)} className="h-7 text-xs w-36" data-testid="neu-markt" />
          <span className="text-muted-foreground">→</span>
          <Input placeholder="Lieferant" value={neuLieferant} onChange={e => setNeuLieferant(e.target.value)}
            className="h-7 text-xs flex-1" data-testid="neu-markt-lieferant" />
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs"
            disabled={!neuMarkt.trim() || !neuLieferant.trim()}
            onClick={() => {
              speichern([...(mappingRef.current ?? mapping), { markt: neuMarkt.trim(), lieferant: neuLieferant.trim() }]);
              setNeuMarkt(''); setNeuLieferant('');
            }} data-testid="neu-markt-add">Hinzufügen</Button>
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
  const [historie, setHistorie] = useState<PreisHistorie | null>(null);
  const [schwelle, setSchwelle] = useState<PreisSchwelle>(DEFAULT_PREIS_SCHWELLE);
  const [schwelleText, setSchwelleText] = useState({ pct: '10', minChf: '0.20' });
  const [mapping, setMapping] = useState<WarengruppenMapping>(DEFAULT_WARENGRUPPEN_MAPPING);
  const [marktMap, setMarktMap] = useState<MarktLieferantenMapping>(DEFAULT_MARKT_LIEFERANTEN);
  // Offene Märkte: Eingabefelder für die Sofort-Zuordnung (Markt → Lieferant)
  const [marktZuordnung, setMarktZuordnung] = useState<Record<string, string>>({});
  const [preisFilter, setPreisFilter] = useState<'erhoehung' | 'senkung' | 'klein' | 'alle'>('erhoehung');
  const [undoRefresh, setUndoRefresh] = useState(0);
  // Positions-Kontierung direkt in der Vorschau: gelernte Artikel-Zuordnungen
  // + Overrides dieser Sitzung (werden beim Import gemerkt), aufgeklappte Rechnungen.
  const [artikelKonten, setArtikelKonten] = useState<ArtikelKontenMapping>({});
  const [kontoOverrides, setKontoOverrides] = useState<ArtikelKontenMapping>({});
  const [aufgeklappt, setAufgeklappt] = useState<Set<string>>(new Set());
  const geladen = useRef(false);

  useEffect(() => {
    if (geladen.current) return;
    geladen.current = true;
    Promise.all([
      loadPreisHistorie(tenantId), loadPreisSchwelle(tenantId), loadWarengruppenMapping(tenantId),
      loadMarktLieferantenMapping(tenantId), loadArtikelKonten(tenantId),
    ]).then(([h, s, m, mm, ak]) => {
      setHistorie(h); setSchwelle(s); setMapping(m); setMarktMap(mm); setArtikelKonten(ak);
      setSchwelleText({ pct: String(s.pct), minChf: s.minChf.toFixed(2) });
    }).catch(() => setHistorie({}));
  }, [tenantId]);

  const handleFile = async (file: File | null) => {
    if (!file) return;
    const text = await file.text();
    const res = parseTransgourmetCsv(text);
    setErgebnis(res);
    setAusgewaehlt(new Set(res.rechnungen.map(r => r.docKey)));
    setMarktZuordnung({});
    setKontoOverrides({}); setAufgeklappt(new Set());
    if (res.failureReason) toast.error(res.failureReason);
  };

  /** Lieferant pro Rechnung aus der Markt-Spalte; null = «Lieferant offen». */
  const lieferantFuer = (markt: string) => lieferantFuerMarkt(markt, marktMap);

  // Preisänderungen je Rechnung — sequenziell gegen die fortgeschriebene
  // Historie (Datei-interne Änderungen werden ebenfalls erkannt).
  // Preis-Historie ist pro LIEFERANT geführt → getrennte Verläufe TG/Prodega.
  const vorschau = useMemo(() => {
    if (!ergebnis || historie === null) return null;
    let hist = historie;
    const proRechnung = new Map<string, PreisAenderung[]>();
    const alle: PreisAenderung[] = [];
    for (const r of ergebnis.rechnungen) {
      if (!ausgewaehlt.has(r.docKey)) continue;
      const lf = lieferantFuer(r.markt);
      if (!lf) continue; // «Lieferant offen» — wird nicht importiert, nicht bewertet
      const aen = berechnePreisAenderungen(r, lf, hist, schwelle);
      proRechnung.set(r.docKey, aen);
      alle.push(...aen);
      hist = aktualisierePreisHistorie(hist, [r], lf);
    }
    return { proRechnung, alle, histNachImport: hist };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ergebnis, historie, ausgewaehlt, schwelle, marktMap]);

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

  /** Offenen Markt einem Lieferanten zuordnen (persistiert, sofort wirksam). */
  const ordneMarktZu = async (markt: string) => {
    const lf = (marktZuordnung[markt] ?? '').trim();
    if (!lf) return;
    const neu = [...marktMap.filter(r => r.markt.trim().toLowerCase() !== markt.trim().toLowerCase()), { markt, lieferant: lf }];
    setMarktMap(neu);
    try { await saveMarktLieferantenMapping(tenantId, neu); toast.success(`Markt «${markt}» → ${lf} gespeichert.`); }
    catch (e) { toast.error(`Zuordnung speichern fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`); }
  };

  const importieren = async () => {
    if (!ergebnis || !vorschau) return;
    // Rechnungen ohne Lieferanten-Zuordnung («Lieferant offen») werden NIE importiert.
    const zuImportieren = ergebnis.rechnungen.filter(r => ausgewaehlt.has(r.docKey) && lieferantFuer(r.markt) !== null);
    const offen = ergebnis.rechnungen.filter(r => ausgewaehlt.has(r.docKey) && lieferantFuer(r.markt) === null);
    if (offen.length > 0) {
      toast.error(`${offen.length} Rechnung${offen.length === 1 ? '' : 'en'} mit unbekanntem Markt übersprungen — bitte Markt zuordnen.`);
    }
    if (zuImportieren.length === 0) return;
    setBusy(true);
    try {
      // In der Vorschau gesetzte Kontierungen MERKEN (Artikel→Konto, pro Mandant)
      // — gilt sofort für diesen Import und automatisch für künftige Importe.
      const effektiv = effektiveArtikelKonten(artikelKonten, kontoOverrides);
      if (Object.keys(kontoOverrides).length > 0) {
        await saveArtikelKonten(tenantId, kontoOverrides);
        setArtikelKonten(effektiv); setKontoOverrides({});
      }
      // Undo-Snapshot VOR dem Schreiben: alle betroffenen Monate + Preis-Historie.
      const monate = [...new Set(zuImportieren.map(r => r.datum.slice(0, 7)))];
      const vorher = await erstelleWarenImportSnapshot(tenantId, { monate, mitPreisHistorie: true });
      let ersetzt = 0, neu = 0;
      const hinweiseProMonat = new Map<string, Record<string, PreisAenderung[]>>();
      const positionenProMonat = new Map<string, Record<string, ReturnType<typeof positionenAusRechnung>>>();
      for (const r of zuImportieren) {
        const lieferant = lieferantFuer(r.markt)!; // oben gefiltert
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
          positionenAusRechnung(r, mapping, { lieferant, konten: effektiv }),
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
      // Undo-Datensatz (nur der letzte Import ist rückgängig machbar).
      const nachher = await erstelleWarenImportSnapshot(tenantId, { monate, mitPreisHistorie: true });
      await saveWarenImportUndo(tenantId, {
        typ: 'csv', zeitpunkt: new Date().toISOString(),
        label: 'CSV Transgourmet/Prodega', anzahlRechnungen: zuImportieren.length,
        vorher, nachher,
      });
      setUndoRefresh(x => x + 1);
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

      <WarenImportUndoButton tenantId={tenantId} typ="csv" refresh={undoRefresh}
        onUndone={() => { setHistorie(null); geladen.current = false; void loadPreisHistorie(tenantId).then(setHistorie).finally(() => { geladen.current = true; }); onImported(); }} />

      {ergebnis && ergebnis.rechnungen.length > 0 && (
        <div className="rounded-lg border border-border bg-muted/20 px-4 py-3 text-xs space-y-3" data-testid="csv-import-vorschau">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-medium">{ergebnis.rechnungen.length} Rechnungen · {ergebnis.debug.zeilenVerwendet} Positionen</span>
            <span className="text-muted-foreground">Lieferant je Rechnung aus der Markt-Spalte (BGH → Transgourmet, Prodega-Märkte → Prodega)</span>
            <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[11px]" onClick={() => setErgebnis(null)}>
              <X className="h-3 w-3 mr-0.5" /> Verwerfen
            </Button>
          </div>

          {/* Rechnungsliste — Lieferant pro Rechnung aus Markt abgeleitet */}
          <div className="max-h-48 overflow-y-auto space-y-0.5">
            {ergebnis.rechnungen.map(r => {
              const lf = lieferantFuer(r.markt);
              const warnung = marktNummernWarnung(lf, r.rechnungsNr);
              const effektiv = effektiveArtikelKonten(artikelKonten, kontoOverrides);
              const offen = lf ? offeneAnzahl(lf, r.positionen, mapping, effektiv) : 0;
              const auf = aufgeklappt.has(r.docKey);
              const toggleAuf = () => setAufgeklappt(prev => {
                const next = new Set(prev);
                if (next.has(r.docKey)) next.delete(r.docKey); else next.add(r.docKey);
                return next;
              });
              return (
                <div key={r.docKey}>
                  <label className="flex items-center gap-2 tabular-nums cursor-pointer hover:bg-muted/40 rounded px-1 py-0.5">
                    <input type="checkbox" className="h-3.5 w-3.5 accent-emerald-600"
                      checked={ausgewaehlt.has(r.docKey)} onChange={() => toggleRechnung(r.docKey)} />
                    <span className="w-20">{fmtDatumCH(r.datum)}</span>
                    <span className="w-24 truncate" title={r.rechnungsNr}>Nr. {r.rechnungsNr}</span>
                    <span className="w-24 truncate text-muted-foreground" title={`Markt: ${r.markt || '—'}`}>{r.markt || '— Markt fehlt'}</span>
                    {lf ? (
                      <span className={cn('font-medium', /prodega/i.test(lf) ? 'text-sky-700 dark:text-sky-400' : 'text-emerald-700 dark:text-emerald-400')}>{lf}</span>
                    ) : (
                      <span className="text-red-600 dark:text-red-400 font-medium">Lieferant offen</span>
                    )}
                    {warnung && (
                      <span className="text-amber-600 dark:text-amber-400 inline-flex items-center gap-0.5" title={warnung}>
                        <AlertTriangle className="h-3 w-3" /> Nr./Markt?
                      </span>
                    )}
                    {lf && (
                      <button type="button"
                        className={cn('inline-flex items-center gap-0.5 rounded px-1 hover:underline',
                          offen > 0 ? 'text-amber-600 dark:text-amber-400 font-medium' : 'text-muted-foreground')}
                        title={offen > 0 ? `${offen} Position(en) ohne Konto — klicken zum Zuordnen` : 'Positionen anzeigen/kontieren'}
                        onClick={e => { e.preventDefault(); e.stopPropagation(); toggleAuf(); }}
                        data-testid={`csv-offen-${r.docKey}`}>
                        {offen > 0 && <AlertTriangle className="h-3 w-3" />}
                        {offen > 0 ? `${offen} offen` : `${r.positionen.length} Pos.`}
                      </button>
                    )}
                    {!lf && <span className="text-muted-foreground">{r.positionen.length} Pos.</span>}
                    <span className="ml-auto">CHF {fmt(r.nettoTotal)} netto</span>
                    {(vorschau?.proRechnung.get(r.docKey)?.length ?? 0) > 0 && (
                      <span className="text-amber-600 dark:text-amber-400 inline-flex items-center gap-0.5">
                        <AlertTriangle className="h-3 w-3" />{vorschau!.proRechnung.get(r.docKey)!.length}
                      </span>
                    )}
                  </label>
                  {auf && lf && (
                    <PositionenKontierungListe lieferant={lf} positionen={r.positionen}
                      mapping={mapping} artikelKonten={effektiv}
                      onKonto={(key, konto) => setKontoOverrides(o => ({ ...o, [key]: konto }))}
                      testidPrefix={`csv-${r.docKey}`} />
                  )}
                </div>
              );
            })}
          </div>

          {/* Unbekannte Märkte — «Lieferant offen», Zuordnung direkt hier speichern */}
          {(() => {
            const offeneMaerkte = [...new Set(ergebnis.rechnungen.map(r => r.markt.trim()).filter(m => m && lieferantFuer(m) === null))];
            return offeneMaerkte.length > 0 ? (
              <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 space-y-1.5" data-testid="markt-offen-hinweis">
                <p className="text-red-700 dark:text-red-400 font-medium">
                  Unbekannte Märkte ({offeneMaerkte.length}) — betroffene Rechnungen werden NICHT importiert, bis der Lieferant zugeordnet ist:
                </p>
                {offeneMaerkte.map(m => (
                  <div key={m} className="flex items-center gap-2">
                    <span className="w-28 truncate">Markt «{m}» →</span>
                    <Input value={marktZuordnung[m] ?? ''} list="markt-lieferanten"
                      onChange={e => setMarktZuordnung(z => ({ ...z, [m]: e.target.value }))}
                      placeholder="Lieferant (z.B. Prodega)" className="h-6 w-44 px-1.5 text-[11px]"
                      data-testid={`markt-zuordnung-${m}`} />
                    <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]"
                      disabled={!(marktZuordnung[m] ?? '').trim()} onClick={() => void ordneMarktZu(m)}>Zuordnen</Button>
                  </div>
                ))}
                <datalist id="markt-lieferanten">
                  {suppliers.filter(s => s.active).map(s => <option key={s.id} value={s.name} />)}
                  <option value="Transgourmet" /><option value="Prodega" />
                </datalist>
              </div>
            ) : null;
          })()}

          {/* Unbekannte Warengruppen — «Konto offen», nie raten */}
          {(() => {
            const offen = offeneWarengruppen(ergebnis.rechnungen.filter(r => ausgewaehlt.has(r.docKey)), mapping);
            return offen.length > 0 ? (
              <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-400"
                data-testid="konto-offen-hinweis">
                <span className="font-medium">Konto offen ({offen.length}):</span> {offen.join(', ')} — «⚠ offen»
                bei der Rechnung anklicken und das Konto direkt in der Positionsliste wählen (wird für den
                Artikel gemerkt), oder die Warengruppe unter Einstellungen → «Warengruppen → Konto» zuordnen.
              </div>
            ) : null;
          })()}

          {/* Preisänderungen — VOR dem Schreiben sichtbar, gefiltert nach Relevanz */}
          {vorschau && (() => {
            // Schwelle = die eingestellte Warn-Schwelle (a.stark); kein zweiter Wert.
            const erhoehungen = vorschau.alle.filter(a => a.stark && a.erhoehung)
              .sort((a, b) => (b.diffPct ?? 0) - (a.diffPct ?? 0)); // grösste %-Erhöhung zuerst
            const senkungen = vorschau.alle.filter(a => a.stark && !a.erhoehung);
            const kleine = vorschau.alle.filter(a => !a.stark);
            const sichtbar = preisFilter === 'erhoehung' ? erhoehungen
              : preisFilter === 'senkung' ? senkungen
                : preisFilter === 'klein' ? kleine : vorschau.alle;
            const filterBtn = (id: typeof preisFilter, text: string) => (
              <button type="button" key={id}
                className={cn('px-2 py-0.5 rounded-full border text-[11px] transition-colors',
                  preisFilter === id ? 'bg-foreground text-background border-foreground font-medium' : 'border-border text-muted-foreground hover:bg-muted/40')}
                onClick={() => setPreisFilter(id)} data-testid={`preisfilter-${id}`}>{text}</button>
            );
            return (
            <div className="border-t border-border/40 pt-2 space-y-1" data-testid="preisaenderungen-liste">
              <div className="flex flex-wrap items-center gap-1.5">
                <p className="font-medium mr-1">Preisänderungen ({vorschau.alle.length})</p>
                {filterBtn('erhoehung', `Erhöhungen ≥${schwelle.pct} %: ${erhoehungen.length}`)}
                {filterBtn('senkung', `Senkungen ≥${schwelle.pct} %: ${senkungen.length}`)}
                {filterBtn('klein', `kleine (<${schwelle.pct} %): ${kleine.length}`)}
                {filterBtn('alle', `alle: ${vorschau.alle.length}`)}
              </div>
              {vorschau.alle.length === 0 && <p className="text-muted-foreground">Keine Preisänderungen gegenüber der letzten Erfassung.</p>}
              {vorschau.alle.length > 0 && sichtbar.length === 0 && <p className="text-muted-foreground">Keine Einträge in diesem Filter.</p>}
              <div className="max-h-56 overflow-y-auto space-y-0.5">
                {sichtbar.map((a, i) => (
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
            );
          })()}

          {(() => {
            const effektiv = effektiveArtikelKonten(artikelKonten, kontoOverrides);
            const offenTotal = ergebnis.rechnungen
              .filter(r => ausgewaehlt.has(r.docKey) && lieferantFuer(r.markt) !== null)
              .reduce((s, r) => s + offeneAnzahl(lieferantFuer(r.markt)!, r.positionen, mapping, effektiv), 0);
            return (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" className="h-7 px-3 text-xs" disabled={busy || ausgewaehlt.size === 0}
                  onClick={importieren} data-testid="csv-import-button">
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                  {ausgewaehlt.size} Rechnung{ausgewaehlt.size === 1 ? '' : 'en'} importieren
                </Button>
                {offenTotal > 0 && (
                  <span className="text-amber-600 dark:text-amber-400 inline-flex items-center gap-1" data-testid="csv-offen-total">
                    <AlertTriangle className="h-3 w-3" />
                    {offenTotal} Position{offenTotal === 1 ? '' : 'en'} noch ohne Konto — Import möglich (provisorisch als Warenkosten)
                  </span>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
