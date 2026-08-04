/**
 * Feldschlösschen-Import — Kern-Pipeline (ohne Undo; Aufrufer macht Snapshots).
 * Bucht Rechnungen/Lieferscheine mit ihrem LIEFERDATUM, per-Monat gecacht
 * (jahresgrosse Läufe = wenige KV-Writes).
 * - Upsert auf (Mandant + Lieferant + Lieferung-Nr + Datum) — nie doppelt.
 * - Lieferschein ist FÜHREND: ohne exakten Treffer ersetzt er eine nahe
 *   PROVISORISCHE «aus Monatsrechnung»-Lieferung (gleiche Referenz oder
 *   ±7 Tage / ±0.10 CHF), auch über Nachbarmonatsgrenzen; deren Positionen
 *   und Preis-Hinweise werden mit aufgeräumt.
 * - opts.quelle='monatsrechnung' kennzeichnet Lückenfüller aus der Monatsrechnung.
 */
import {
  loadMonthInvoices, saveMonthInvoices, loadPreisHistorie, savePreisHistorie,
  loadPreisSchwelle, loadPreisHinweise, savePreisHinweise, loadWarengruppenMapping,
  loadRechnungsPositionen, saveRechnungsPositionen, kategorieFromKonto,
  type InvoiceEntry,
} from '@/lib/waren-db';
import {
  berechnePreisAenderungen, aktualisierePreisHistorie, DEFAULT_PREIS_SCHWELLE,
  positionenAusRechnung, kontoSplitsAusPositionen, uebernehmeManuelleKontierung,
  type ParsedCsvRechnung, type PreisAenderung,
} from '@/lib/waren-positionen';
import { mitFsDefaults } from '@/lib/feldschloesschen';
import type { TenantId } from '@/contexts/TenantContext';

export interface FsImportRechnung {
  r: ParsedCsvRechnung;
  nettoOffiziell?: number | null;
  bruttoOffiziell?: number | null;
}

export interface FsImportErgebnis {
  neu: number;
  ersetzt: number;
  offen: number;
  provisorischErsetzt: number;
  preisAenderungen: number;
  monate: string[];
  /** Nur quelle='monatsrechnung': übersprungen, weil bereits eine ECHTE
   *  (nicht-provisorische) Buchung existiert — die wird NIE überschrieben. */
  uebersprungen: number;
}

export async function kernImportiereFsRechnungen(
  tenantId: TenantId,
  lieferant: string,
  rechnungen: FsImportRechnung[],
  opts?: {
    quelle?: 'monatsrechnung';
    /** Notiz-Präfix (Default «Feldschlösschen-PDF») — z.B. «Lieferanten-PDF». */
    noteLabel?: string;
    /** ID-Präfix (Default 'fs') — z.B. 'lpdf' für Profil-PDF-Importe. */
    idPrefix?: string;
    /** Zusätzliche Warengruppe→Konto-Zuordnungen (z.B. Profil-Kategorie→Konto). */
    extraMapping?: Record<string, string>;
    /** Fallback-Hauptkonto wenn keine Splits ableitbar (Default '4030'). */
    defaultKonto?: string;
  },
): Promise<FsImportErgebnis> {
  const [mappingRoh, historie, schwelle] = await Promise.all([
    loadWarengruppenMapping(tenantId), loadPreisHistorie(tenantId),
    loadPreisSchwelle(tenantId).catch(() => DEFAULT_PREIS_SCHWELLE),
  ]);
  // extraMapping (Profil-Kategorie→Konto) hat Vorrang — daher VORNE einfügen.
  const extraRegeln = Object.entries(opts?.extraMapping ?? {}).map(([gruppe, konto]) => ({ gruppe, konto }));
  const mapping = [...extraRegeln, ...mitFsDefaults(mappingRoh)];
  let hist = historie;
  let neu = 0, ersetzt = 0, offen = 0, provisorischErsetzt = 0, uebersprungen = 0;
  const alleAenderungen: PreisAenderung[] = [];
  // Per-Monat-Caches: einmal lesen, am Ende einmal schreiben.
  const bestandCache = new Map<string, InvoiceEntry[]>();
  const posCache = new Map<string, Awaited<ReturnType<typeof loadRechnungsPositionen>>>();
  const hinweisCache = new Map<string, Awaited<ReturnType<typeof loadPreisHinweise>>>();
  const geaendert = new Set<string>();
  const holeMonat = async (month: string) => {
    if (!bestandCache.has(month)) {
      bestandCache.set(month, await loadMonthInvoices(tenantId, month));
      posCache.set(month, await loadRechnungsPositionen(tenantId, month));
      hinweisCache.set(month, await loadPreisHinweise(tenantId, month));
    }
    return { bestand: bestandCache.get(month)!, pos: posCache.get(month)!, hinweise: hinweisCache.get(month)! };
  };
  const tageDiff = (a: string, b: string) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);
  const nachbarMonate = (datum: string) => {
    const d = new Date(`${datum}T00:00:00Z`);
    const m = (off: number) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + off); return x.toISOString().slice(0, 7); };
    return [...new Set([m(-1), m(0), m(1)])];
  };
  // Sortiert nach Lieferdatum, damit die Preis-Historie chronologisch wächst.
  const sortiert = [...rechnungen].sort((a, b) => a.r.datum.localeCompare(b.r.datum));
  for (const { r, nettoOffiziell, bruttoOffiziell } of sortiert) {
    const month = r.datum.slice(0, 7);
    const { bestand } = await holeMonat(month);
    let vorhanden = bestand.find(e =>
      (e.reference ?? '').trim().toLowerCase() === r.rechnungsNr.toLowerCase()
      && e.date === r.datum
      && e.supplierName.trim().toLowerCase() === lieferant.trim().toLowerCase());
    let vorhandenMonat = month;
    // Monatsrechnung = Kontrolle + Lückenfüller: eine ECHTE (nicht-provisorische)
    // Buchung wird NIE überschrieben — nur eigene provisorische Einträge dürfen
    // per Upsert aktualisiert werden (z.B. erneuter Upload derselben Monatsrechnung).
    if (opts?.quelle === 'monatsrechnung' && vorhanden && vorhanden.quelle !== 'monatsrechnung') {
      uebersprungen++;
      continue;
    }
    // Lieferschein ersetzt eine nahe provisorische Monatsrechnungs-Lieferung.
    if (!vorhanden && opts?.quelle !== 'monatsrechnung') {
      const brutto = bruttoOffiziell ?? r.bruttoTotal;
      for (const nm of nachbarMonate(r.datum)) {
        const nb = (await holeMonat(nm)).bestand;
        const prov = nb.find(e => e.quelle === 'monatsrechnung'
          && e.supplierName.trim().toLowerCase() === lieferant.trim().toLowerCase()
          && ((e.reference ?? '').trim().toLowerCase() === r.rechnungsNr.toLowerCase()
            || (tageDiff(e.date, r.datum) <= 7 && Math.abs(e.amountGross - brutto) <= 0.10)));
        if (prov) { vorhanden = prov; vorhandenMonat = nm; provisorischErsetzt++; break; }
      }
    }
    const positionen = uebernehmeManuelleKontierung(
      positionenAusRechnung(r, mapping),
      vorhanden ? posCache.get(vorhandenMonat)?.[vorhanden.id] : undefined,
    );
    offen += positionen.filter(p => p.status === 'offen').length;
    const splits = kontoSplitsAusPositionen(positionen);
    const haupt = splits.find(s => /^\d+$/.test(s.warenkonto))?.warenkonto ?? splits[0]?.warenkonto ?? opts?.defaultKonto ?? '4030';
    const aenderungen = berechnePreisAenderungen(r, lieferant, hist, schwelle);
    alleAenderungen.push(...aenderungen);
    hist = aktualisierePreisHistorie(hist, [r], lieferant);
    const jetzt = new Date().toISOString();
    const id = vorhanden?.id ?? `${opts?.idPrefix ?? 'fs'}-${r.rechnungsNr}-${Date.now()}-${neu}`;
    const entry: InvoiceEntry = {
      id,
      date: r.datum, // LIEFERDATUM — führend für Wochen-Analyse und Cockpit
      supplierName: lieferant,
      amountGross: bruttoOffiziell ?? r.bruttoTotal,
      amountNet: nettoOffiziell ?? r.nettoTotal,
      vatIncluded: false,
      vatRate: r.nettoTotal > 0 ? Math.round((r.mwstTotal / r.nettoTotal) * 1000) / 10 : 0,
      reference: r.rechnungsNr,
      note: (() => {
        const label = opts?.noteLabel ?? 'Feldschlösschen-PDF';
        // Synthetische Ganz-Rechnungs-Position (Stufe 1, preis 0) nicht zählen.
        const echte = r.positionen.filter(p => p.artNr !== '' || p.preis > 0).length;
        const basis = echte > 0 ? `${label} · ${echte} Positionen` : label;
        return opts?.quelle === 'monatsrechnung'
          ? `Aus Monatsrechnung übernommen (provisorisch) · ${r.positionen.length} Positionen`
          : basis;
      })(),
      ...(splits.length > 1 ? { kontoSplits: splits } : { warenkonto: haupt }),
      kategorie: kategorieFromKonto(haupt),
      ...(vorhanden?.receiptPath ? { receiptPath: vorhanden.receiptPath } : {}),
      ...(opts?.quelle === 'monatsrechnung' ? { quelle: 'monatsrechnung' as const } : {}),
      createdAt: vorhanden?.createdAt ?? jetzt,
      updatedAt: jetzt,
    };
    // Alten Eintrag entfernen (auch wenn er in einem Nachbarmonat lag) —
    // Positionen UND Preis-Hinweise mit aufräumen (keine verwaisten IDs).
    if (vorhanden) {
      bestandCache.set(vorhandenMonat, bestandCache.get(vorhandenMonat)!.filter(e => e.id !== vorhanden!.id));
      if (vorhandenMonat !== month) {
        delete posCache.get(vorhandenMonat)![vorhanden.id];
        geaendert.add(vorhandenMonat);
      }
      delete hinweisCache.get(vorhandenMonat)![vorhanden.id];
    }
    bestandCache.get(month)!.push(entry);
    posCache.get(month)![id] = positionen;
    const hin = hinweisCache.get(month)!;
    if (aenderungen.length > 0) hin[id] = aenderungen; else delete hin[id];
    geaendert.add(month);
    if (vorhanden) ersetzt++; else neu++;
  }
  // Ein Schreibvorgang pro Monat.
  for (const m of geaendert) {
    await saveMonthInvoices(tenantId, m, bestandCache.get(m)!);
    await saveRechnungsPositionen(tenantId, m, posCache.get(m)!);
    await savePreisHinweise(tenantId, m, hinweisCache.get(m)!);
  }
  await savePreisHistorie(tenantId, hist);
  return { neu, ersetzt, offen, provisorischErsetzt, preisAenderungen: alleAenderungen.length, monate: [...geaendert], uebersprungen };
}
