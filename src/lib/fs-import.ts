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
import { mitFsDefaults, kontoSplitsAusFsKategorien, type FsKategorieSumme } from '@/lib/feldschloesschen';
import { findeKreditorenUebernahme } from '@/lib/kreditoren-abgleich';
import { loadFibuMatchToleranz, bereinigeFibuMatchesFuerMonat } from '@/lib/waren-db';
import type { TenantId } from '@/contexts/TenantContext';

export interface FsImportRechnung {
  r: ParsedCsvRechnung;
  nettoOffiziell?: number | null;
  bruttoOffiziell?: number | null;
  /**
   * Kategorien der Rechnungs-eigenen «Zusammenfassung MwSt.» — wenn gesetzt,
   * ist SIE massgeblich für die Konto-Splits (statt der Positions-Klassifizierung).
   * Nur übergeben, wenn die Zusammenfassung genau diese eine Buchung deckt
   * (Faktura mit genau einem Lieferschein bzw. Ganz-Rechnung).
   */
  fsKategorien?: FsKategorieSumme[];
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
  /** Provisorische Kreditoren-Übernahmen, die dieser Detail-Import über die
   *  BELEGNUMMER finalisiert/ersetzt hat (echtes Lieferdatum + Positionen). */
  kreditorenFinalisiert: number;
  /** Nutzer-Hinweise (Betragsabweichung > Toleranz, mehrdeutige Fallbacks) —
   *  Aufrufer MUSS sie anzeigen, nie still verschlucken. */
  hinweise: string[];
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
    /** «Monatsrechnung: nein»-Lieferanten: jede Einzelrechnung bucht sofort
     *  FINAL (keine provisorische Stufe). Re-Import derselben Referenz bleibt
     *  idempotent (Upsert statt «bereits final»-Skip). */
    finalDirekt?: boolean;
  },
): Promise<FsImportErgebnis> {
  const [mappingRoh, historie, schwelle, artikelKonten, matchToleranz] = await Promise.all([
    loadWarengruppenMapping(tenantId), loadPreisHistorie(tenantId),
    loadPreisSchwelle(tenantId).catch(() => DEFAULT_PREIS_SCHWELLE),
    loadArtikelKonten(tenantId),
    loadFibuMatchToleranz(tenantId).catch(() => 1),
  ]);
  // extraMapping (Profil-Kategorie→Konto) hat Vorrang — daher VORNE einfügen.
  const extraRegeln = Object.entries(opts?.extraMapping ?? {}).map(([gruppe, konto]) => ({ gruppe, konto }));
  const mapping = [...extraRegeln, ...mitFsDefaults(mappingRoh)];
  let hist = historie;
  let neu = 0, ersetzt = 0, offen = 0, provisorischErsetzt = 0, bereitsFinal = 0, ueberschrieben = 0;
  let kreditorenFinalisiert = 0;
  const hinweise: string[] = [];
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
  for (const { r, nettoOffiziell, bruttoOffiziell, fsKategorien } of sortiert) {
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
    const bruttoDetail = bruttoOffiziell ?? r.bruttoTotal;
    // KREDITOREN-ÜBERNAHME finalisieren: provisorische Übernahme mit gleicher
    // BELEGNUMMER (+ Lieferant lose, Konzern-Gruppen) wird vom Detail-Import
    // ersetzt — echtes Lieferdatum + Positionen statt Monatsend-Platzhalter.
    // AB bleibt aussen vor (provisorisch ersetzt nicht provisorisch fremder Art).
    if (!vorhanden && opts?.quelle !== 'auftragsbestaetigung') {
      let mehrdeutigF = false;
      for (const nm of nachbarMonate(r.datum)) {
        const nb = (await holeMonat(nm)).bestand.filter(e => !vergeben.has(e.id));
        const res = findeKreditorenUebernahme(nb, r.rechnungsNr, lieferant, bruttoDetail);
        if (res.entry) { vorhanden = res.entry; vorhandenMonat = nm; break; }
        if (res.mehrdeutig) mehrdeutigF = true;
      }
      if (!vorhanden && mehrdeutigF) {
        hinweise.push(`${lieferant} ${r.rechnungsNr || r.datum}: mehrere Kreditoren-Übernahmen ohne Belegnummer passen zum Betrag — bitte manuell prüfen (nichts automatisch ersetzt).`);
      }
    }
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
      // AUSNAHME finalDirekt (Einzelrechnungs-Lieferant ohne Monatsrechnung):
      // exakter Referenz-Treffer = dieselbe Rechnung ⇒ idempotenter Upsert —
      // aber NUR bei nachweislich EIGENER Herkunft (gleicher idPrefix, keine
      // Monatsrechnung); manuelle/MR-Finalbuchungen bleiben unantastbar.
      const eigeneHerkunft = (e: InvoiceEntry) =>
        e.id.startsWith(`${opts?.idPrefix ?? 'fs'}-`) && e.quelle !== 'monatsrechnung';
      if (vorhanden?.final && !(opts?.finalDirekt && eigeneHerkunft(vorhanden))) { bereitsFinal++; continue; }
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
        // finalDirekt: derselbe Referenz-Treffer ist die EIGENE Rechnung
        // (z.B. Datum korrigiert) ⇒ Upsert statt Skip — nur eigene Herkunft.
        if (!vorhanden && r.rechnungsNr.trim() !== '') {
          let finalTreffer: { e: InvoiceEntry; nm: string } | null = null;
          for (const nm of nachbarMonate(r.datum)) {
            const nb = (await holeMonat(nm)).bestand;
            const e = nb.find(e => e.final === true && !vergeben.has(e.id)
              && e.supplierName.trim().toLowerCase() === lief
              && (e.reference ?? '').trim().toLowerCase() === r.rechnungsNr.toLowerCase());
            if (e) { finalTreffer = { e, nm }; break; }
          }
          if (finalTreffer) {
            if (opts?.finalDirekt && eigeneHerkunft(finalTreffer.e)) { vorhanden = finalTreffer.e; vorhandenMonat = finalTreffer.nm; }
            else { bereitsFinal++; continue; }
          }
        }
      }
    }
    // Klassifizieren NACH allen Match-Pfaden (auch strikter Gleich-Datum- oder
    // Datum+Betrag-Treffer kann einen Kreditoren-Platzhalter erwischen):
    // Finalisierung wird separat gezählt (nicht als «ersetzt») und prüft die
    // Betragsabweichung gegen die FIBU-Toleranz.
    const warKredUebernahme = !!vorhanden && vorhanden.quelle === 'kreditoren_uebernahme' && !vorhanden.final;
    if (warKredUebernahme) {
      kreditorenFinalisiert++;
      if (Math.abs(vorhanden!.amountGross - bruttoDetail) > matchToleranz) {
        hinweise.push(`${lieferant} ${r.rechnungsNr || r.datum}: Betrag weicht ab — Kreditor ${vorhanden!.amountGross.toFixed(2)} ↔ Detail ${bruttoDetail.toFixed(2)}; Detail-Betrag übernommen.`);
      }
    }
    if (vorhanden) vergeben.add(vorhanden.id);
    const positionen = uebernehmeManuelleKontierung(
      positionenAusRechnung(r, mapping, { lieferant, konten: artikelKonten }),
      vorhanden ? posCache.get(vorhandenMonat)?.[vorhanden.id] : undefined,
    );
    offen += positionen.filter(p => p.status === 'offen').length;
    // Konto-Splits: die Rechnungs-eigene «Zusammenfassung MwSt.» ist massgeblich,
    // wenn übergeben; sonst Positions-Klassifizierung. Weicht die Zusammenfassung
    // vom Buchungs-Netto ab (>0.10), fällt der Import SICHTBAR auf Positionen zurück.
    let splits = kontoSplitsAusPositionen(positionen);
    if (fsKategorien && fsKategorien.length > 0) {
      const ausZsf = kontoSplitsAusFsKategorien(fsKategorien, mapping);
      const zielNetto = nettoOffiziell ?? r.nettoTotal;
      const zsfNetto = ausZsf.splits.reduce((a, s) => a + s.amountNet, 0);
      if (Math.abs(zsfNetto - zielNetto) <= 0.10) {
        splits = ausZsf.splits;
        // Warnsignal (ohne die massgebliche ZSF-Kontierung zu ändern): weicht
        // das aus den POSITIONEN gelesene Netto von der Zusammenfassung ab,
        // stimmt Parser oder PDF nicht — sichtbar machen.
        if (Math.abs(zsfNetto - r.nettoTotal) > 0.10) {
          hinweise.push(`${lieferant} ${r.rechnungsNr || r.datum}: Positions-Netto (${r.nettoTotal.toFixed(2)}) weicht von der Zusammenfassung MwSt. (${zsfNetto.toFixed(2)}) ab — Zusammenfassung bleibt massgeblich, bitte PDF prüfen.`);
        }
        if (ausZsf.offen.length > 0) {
          hinweise.push(`${lieferant} ${r.rechnungsNr || r.datum}: unbekannte Kategorie(n) «${ausZsf.offen.join('», «')}» in der Zusammenfassung MwSt. — als «offen» kontiert, bitte Zuordnung ergänzen.`);
        }
      } else {
        hinweise.push(`${lieferant} ${r.rechnungsNr || r.datum}: Zusammenfassung MwSt. (${zsfNetto.toFixed(2)}) deckt das Buchungs-Netto (${zielNetto.toFixed(2)}) nicht — Kontierung aus Positionen übernommen.`);
      }
    }
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
      // dürfen diese Werte nicht mehr verschlechtern. finalDirekt: Lieferant
      // ohne Monatsrechnung ⇒ Einzelrechnung ist sofort final.
      ...(istMr || opts?.finalDirekt ? { final: true } : {}),
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
    if (vorhanden) { if (!warKredUebernahme) ersetzt++; } else neu++;
  }
  // Ein Schreibvorgang pro Monat.
  for (const m of geaendert) {
    await saveMonthInvoices(tenantId, m, bestandCache.get(m)!);
    await saveRechnungsPositionen(tenantId, m, posCache.get(m)!);
    await savePreisHinweise(tenantId, m, hinweisCache.get(m)!);
    // FIBU-Match-Zuordnungen des Monats mitbereinigen: cross-Monat verschobene
    // IDs (z.B. finalisierte Kreditoren-Platzhalter) dürfen im alten Monat
    // keine «gematcht»-Leichen hinterlassen (best-effort, wirft nie).
    await bereinigeFibuMatchesFuerMonat(tenantId, m, new Set(bestandCache.get(m)!.map(e => e.id)));
  }
  await savePreisHistorie(tenantId, hist);
  return { neu, ersetzt, offen, provisorischErsetzt, preisAenderungen: alleAenderungen.length, monate: [...geaendert], bereitsFinal, ueberschrieben, kreditorenFinalisiert, hinweise };
}
