/**
 * Feldschlösschen-Import — Kern-Pipeline (ohne Undo; Aufrufer macht Snapshots).
 * Bucht Rechnungen/Lieferscheine mit ihrem LIEFERDATUM, per-Monat gecacht
 * (jahresgrosse Läufe = wenige KV-Writes).
 * - Upsert auf (Mandant + Lieferant + Lieferung-Nr + Datum) — nie doppelt.
 * - RANGORDNUNG (Dual-Modell): Monatsrechnung (final) > Lieferschein/AB
 *   (provisorisch). opts.quelle='monatsrechnung' ist MASSGEBLICH: jede
 *   Lieferung matcht bestehende Buchungen (exakte Referenz, sonst Datum im
 *   Fenster + Brutto ±0.10, Monate ±1) und ÜBERSCHREIBT sie mit den finalen
 *   Rechnungswerten — Lieferdatum je EINZELNER Lieferung aus der Rechnung,
 *   nie das Belegdatum. Ohne Treffer wird frisch (final) gebucht; der
 *   Gesamtbetrag der Rechnung wird NIE zusätzlich gebucht.
 * - Lieferschein/AB nach Finalisierung: ein erneuter Upload derselben
 *   Lieferung überschreibt die finale Buchung NICHT (Zähler bereitsFinal).
 * - Lieferschein ersetzt weiterhin nahe provisorische Buchungen (Monats-
 *   rechnungs-Altdaten ohne final-Flag oder Auftragsbestätigungen).
 */
import {
  loadMonthInvoices, saveMonthInvoices, loadPreisHistorie, savePreisHistorie,
  loadPreisSchwelle, loadPreisHinweise, savePreisHinweise, loadWarengruppenMapping, loadArtikelKonten,
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
  /** Lieferschein/AB-Upload traf eine FINALE (Monatsrechnungs-)Buchung —
   *  die wird NIE verschlechtert; der Upload wurde übersprungen. */
  bereitsFinal: number;
  /** Nur quelle='monatsrechnung': bestehende provisorische Buchungen, die mit
   *  den finalen Rechnungswerten überschrieben wurden. */
  ueberschrieben: number;
}

export async function kernImportiereFsRechnungen(
  tenantId: TenantId,
  lieferant: string,
  rechnungen: FsImportRechnung[],
  opts?: {
    /** 'monatsrechnung' = MASSGEBLICH/final (überschreibt provisorische
     *  Buchungen); 'auftragsbestaetigung' = provisorisch (AB gilt als
     *  Lieferschein, z.B. Terravigna). */
    quelle?: 'monatsrechnung' | 'auftragsbestaetigung';
    /** Hinweis: bestehende provisorische 'kreditoren_uebernahme'-Buchungen
     *  (Kreditoren-Abgleich) dürfen von Lieferschein/MR ersetzt werden. */
    /** Datums-Fenster (Tage) für Matches ohne Referenz-Treffer.
     *  Lieferschein→provisorisch: Default 7. Monatsrechnung→Bestand:
     *  Default 0 (exaktes Datum); Terravigna Rechnung↔AB: 3. */
    ersatzFensterTage?: number;
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
  const [mappingRoh, historie, schwelle, artikelKonten] = await Promise.all([
    loadWarengruppenMapping(tenantId), loadPreisHistorie(tenantId),
    loadPreisSchwelle(tenantId).catch(() => DEFAULT_PREIS_SCHWELLE),
    loadArtikelKonten(tenantId),
  ]);
  // extraMapping (Profil-Kategorie→Konto) hat Vorrang — daher VORNE einfügen.
  const extraRegeln = Object.entries(opts?.extraMapping ?? {}).map(([gruppe, konto]) => ({ gruppe, konto }));
  const mapping = [...extraRegeln, ...mitFsDefaults(mappingRoh)];
  let hist = historie;
  let neu = 0, ersetzt = 0, offen = 0, provisorischErsetzt = 0, bereitsFinal = 0, ueberschrieben = 0;
  // Jede bestehende Buchung deckt höchstens EINE Lieferung dieses Laufs.
  const vergeben = new Set<string>();
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
    const lief = lieferant.trim().toLowerCase();
    let vorhanden = bestand.find(e => !vergeben.has(e.id)
      && (e.reference ?? '').trim().toLowerCase() === r.rechnungsNr.toLowerCase()
      && e.date === r.datum
      && e.supplierName.trim().toLowerCase() === lief);
    let vorhandenMonat = month;
    // Provisorisch = Lieferschein/AB oder Monatsrechnungs-ALTDATEN ohne
    // final-Flag; final = massgebliche Monatsrechnungs-Buchung.
    const istProv = (e: InvoiceEntry) => !e.final;
    const istMr = opts?.quelle === 'monatsrechnung';
    if (istMr) {
      // MASSGEBLICH: ohne exakten Treffer matcht die Lieferung JEDE bestehende
      // Buchung des Lieferanten — exakte Referenz (Monate ±1), sonst Datum im
      // Fenster (Default 0 = exakt) + Brutto ±0.10 — und überschreibt sie.
      const brutto = bruttoOffiziell ?? r.bruttoTotal;
      const fenster = opts?.ersatzFensterTage ?? 0;
      const refMatch = (e: InvoiceEntry) =>
        r.rechnungsNr.trim() !== '' && (e.reference ?? '').trim().toLowerCase() === r.rechnungsNr.toLowerCase();
      if (!vorhanden) {
        // ZWEI PÄSSE: erst exakte Referenz über ALLE Nachbarmonate, DANN erst
        // der Datum+Betrag-Fallback (wie monatsrechnung-abgleich). Ein OR im
        // selben Pass könnte bei zwei Lieferungen gleichen Tags/Betrags einen
        // Datum-Treffer VOR dem exakten Referenz-Treffer finden und die
        // Identitäten vertauschen.
        aussen:
        for (const pass of ['ref', 'fallback'] as const) {
          for (const nm of nachbarMonate(r.datum)) {
            const nb = (await holeMonat(nm)).bestand;
            const m = nb.find(e => !vergeben.has(e.id)
              && e.supplierName.trim().toLowerCase() === lief
              && (pass === 'ref'
                ? refMatch(e)
                : (tageDiff(e.date, r.datum) <= fenster && Math.abs(e.amountGross - brutto) <= 0.10)));
            if (m) { vorhanden = m; vorhandenMonat = nm; break aussen; }
          }
        }
      }
      // AB→Rechnung-Sonderfall (z.B. Terravigna): die Dokumente tragen KEINE
      // gemeinsame Referenz (Rechnung nennt die AB-Nr. nicht). Bleibt die
      // Lieferung ohne Treffer, darf sie GENAU EINE provisorische AB-Buchung
      // im Datumsfenster ersetzen — mit gelockerter Betragstoleranz
      // (max(0.10, 1 % vom Brutto)); bei MEHREREN Kandidaten wird NIE geraten
      // (dann normale Neu-Buchung, die AB bleibt sichtbar zur Prüfung).
      if (!vorhanden && fenster > 0) {
        const tol = Math.max(0.10, Math.round(brutto) * 0.01);
        const kandidaten: Array<{ e: InvoiceEntry; nm: string }> = [];
        for (const nm of nachbarMonate(r.datum)) {
          const nb = (await holeMonat(nm)).bestand;
          for (const e of nb) {
            if (!vergeben.has(e.id) && istProv(e) && e.quelle === 'auftragsbestaetigung'
              && e.supplierName.trim().toLowerCase() === lief
              && tageDiff(e.date, r.datum) <= fenster
              && Math.abs(e.amountGross - brutto) <= tol) kandidaten.push({ e, nm });
          }
        }
        if (kandidaten.length === 1) { vorhanden = kandidaten[0].e; vorhandenMonat = kandidaten[0].nm; }
      }
      // FINAL-WACHE: eine bereits finalisierte Buchung wird von einer weiteren
      // Monatsrechnung NUR bei exakter Referenz (= dieselbe Lieferung, idem-
      // potenter Re-Import) aktualisiert — ein blosser Datum/Betrag-Treffer
      // überschreibt sie NIE (falsche/zweite MR darf finale Daten nicht ändern).
      if (vorhanden && vorhanden.final === true && !refMatch(vorhanden)) {
        vergeben.add(vorhanden.id);
        bereitsFinal++;
        continue;
      }
      if (vorhanden && istProv(vorhanden)) ueberschrieben++;
    } else {
      // Lieferschein/AB: eine FINALE Buchung wird NIE verschlechtert —
      // Upload derselben Lieferung wird übersprungen («bereits final»).
      if (vorhanden?.final) { bereitsFinal++; continue; }
      if (opts?.quelle === 'auftragsbestaetigung' && vorhanden && vorhanden.quelle !== 'auftragsbestaetigung') {
        // AB upsertet nur die EIGENE provisorische Buchung, nie fremde.
        continue;
      }
      // Lieferschein ersetzt eine nahe provisorische Buchung (AB/MR-Altdaten).
      if (!vorhanden && !opts?.quelle) {
        const brutto = bruttoOffiziell ?? r.bruttoTotal;
        const fenster = opts?.ersatzFensterTage ?? 7;
        // Auch hier: exakte Referenz VOR dem Datum+Betrag-Fallback (nie im
        // selben Pass mischen — sonst Identitätstausch bei gleichen Beträgen).
        aussen2:
        for (const pass of ['ref', 'fallback'] as const) {
          for (const nm of nachbarMonate(r.datum)) {
            const nb = (await holeMonat(nm)).bestand;
            const kandidat = nb.find(e => !vergeben.has(e.id)
              && istProv(e) && (e.quelle === 'monatsrechnung' || e.quelle === 'auftragsbestaetigung' || e.quelle === 'kreditoren_uebernahme')
              && e.supplierName.trim().toLowerCase() === lief
              && (pass === 'ref'
                ? r.rechnungsNr.trim() !== '' && (e.reference ?? '').trim().toLowerCase() === r.rechnungsNr.toLowerCase()
                : (tageDiff(e.date, r.datum) <= fenster && Math.abs(e.amountGross - brutto) <= 0.10)));
            if (kandidat) { vorhanden = kandidat; vorhandenMonat = nm; provisorischErsetzt++; break aussen2; }
          }
        }
        // FINALE Buchung derselben Lieferung (Referenz, Monate ±1)? Dann ist
        // sie bereits finalisiert — Lieferschein überspringen («bereits final»).
        if (!vorhanden && r.rechnungsNr.trim() !== '') {
          let final = false;
          for (const nm of nachbarMonate(r.datum)) {
            const nb = (await holeMonat(nm)).bestand;
            if (nb.some(e => e.final === true
              && e.supplierName.trim().toLowerCase() === lief
              && (e.reference ?? '').trim().toLowerCase() === r.rechnungsNr.toLowerCase())) { final = true; break; }
          }
          if (final) { bereitsFinal++; continue; }
        }
      }
    }
    if (vorhanden) vergeben.add(vorhanden.id);
    const positionen = uebernehmeManuelleKontierung(
      positionenAusRechnung(r, mapping, { lieferant, konten: artikelKonten }),
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
          ? `Aus Monatsrechnung (final) · ${r.positionen.length} Positionen`
          : opts?.quelle === 'auftragsbestaetigung'
          ? `provisorisch (Auftragsbestätigung) · ${r.positionen.length} Positionen`
          : basis;
      })(),
      ...(splits.length > 1 ? { kontoSplits: splits } : { warenkonto: haupt }),
      kategorie: kategorieFromKonto(haupt),
      ...(vorhanden?.receiptPath ? { receiptPath: vorhanden.receiptPath } : {}),
      ...(opts?.quelle ? { quelle: opts.quelle } : {}),
      // Monatsrechnung finalisiert die Lieferung — spätere LS/AB-Uploads
      // dürfen diese Werte nicht mehr verschlechtern.
      ...(istMr ? { final: true } : {}),
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
  return { neu, ersetzt, offen, provisorischErsetzt, preisAenderungen: alleAenderungen.length, monate: [...geaendert], bereitsFinal, ueberschrieben };
}
