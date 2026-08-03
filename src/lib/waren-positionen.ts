/**
 * Transgourmet/Prodega CSV-Positionsimport (Kundenportal-Format)
 * ==============================================================
 * Semikolon-getrennt, Kopfzeile u.a.: Kundennummer;Rechnungsnummer;Datum;
 * Markt;Warengruppe;Position;Art. Nr.;Menge;Gewicht;Einheit;
 * Artikelbezeichnung;Preis;Positionspreis;MwSt;EAN;Pfand;Aktion;MwSt. Code;…
 *
 * - `Preis`          = Einzelpreis pro Einheit, NETTO (Preisüberwachung!)
 * - `Positionspreis` = Menge × Preis (netto), kann negativ sein (Retouren)
 * - `MwSt`           = MwSt-BETRAG der Position (CHF)
 * - `MwSt. Code` 0   = Pfand/Gebinde → von der Preisüberwachung ausgenommen
 *
 * Rein parsen/aggregieren — keine Persistenz hier. Parser liefert IMMER ein
 * debug-Objekt + failureReason auf allen Fehlpfaden (nie blind raten).
 */

export interface WarenPosition {
  artNr: string;            // '' wenn fehlend
  bezeichnung: string;
  warengruppe: string;
  menge: number;
  einheit: string;
  /** Einzelpreis pro Einheit, netto (Spalte "Preis"). */
  preis: number;
  /** Positionstotal netto (Spalte "Positionspreis"). */
  positionspreis: number;
  /** MwSt-Betrag der Position (CHF). */
  mwstBetrag: number;
  /** MwSt. Code (0 = Pfand/Gebinde). */
  mwstCode: number;
}

export interface ParsedCsvRechnung {
  /**
   * Stabiler Dokumentschlüssel `rechnungsNr|datum` — Portal-Exporte
   * verwenden Rechnungsnummern (z.B. "58") über Monate hinweg wieder;
   * Gruppierung/Auswahl/Historie MÜSSEN daher Nummer+Datum kombinieren.
   */
  docKey: string;
  rechnungsNr: string;
  datum: string;            // YYYY-MM-DD
  markt: string;
  positionen: WarenPosition[];
  nettoTotal: number;       // Σ Positionspreis
  mwstTotal: number;        // Σ MwSt-Betrag
  bruttoTotal: number;      // netto + mwst
}

export interface CsvParseErgebnis {
  rechnungen: ParsedCsvRechnung[];
  failureReason: string | null;
  debug: {
    zeilenTotal: number;
    zeilenVerwendet: number;
    zeilenVerworfen: number;
    spalten: string[];
    beispielZeile?: string;
  };
}

const PFLICHT_SPALTEN = ['Rechnungsnummer', 'Datum', 'Artikelbezeichnung', 'Preis', 'Positionspreis'];

function parseNum(s: string | undefined): number {
  if (s === undefined || s.trim() === '') return 0;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

export function parseTransgourmetCsv(text: string): CsvParseErgebnis {
  const zeilen = text.split(/\r?\n/).filter(z => z.trim() !== '');
  const debugBasis = { zeilenTotal: zeilen.length, zeilenVerwendet: 0, zeilenVerworfen: 0, spalten: [] as string[] };
  if (zeilen.length < 2) {
    return { rechnungen: [], failureReason: 'Datei ist leer oder enthält nur die Kopfzeile.', debug: debugBasis };
  }
  const header = zeilen[0].split(';').map(h => h.trim());
  debugBasis.spalten = header;
  const idx = (name: string) => header.findIndex(h => h === name);
  const fehlend = PFLICHT_SPALTEN.filter(s => idx(s) < 0);
  if (fehlend.length > 0) {
    return {
      rechnungen: [], debug: { ...debugBasis, beispielZeile: zeilen[1]?.slice(0, 300) },
      failureReason: `Kein Transgourmet/Prodega-Format — fehlende Spalten: ${fehlend.join(', ')}. Gefundene Spalten: ${header.filter(Boolean).join(', ')}`,
    };
  }
  const iRech = idx('Rechnungsnummer'), iDat = idx('Datum'), iMarkt = idx('Markt'),
    iGrp = idx('Warengruppe'), iArt = idx('Art. Nr.'), iMenge = idx('Menge'),
    iEinh = idx('Einheit'), iBez = idx('Artikelbezeichnung'), iPreis = idx('Preis'),
    iPos = idx('Positionspreis'), iMwst = idx('MwSt'), iCode = idx('MwSt. Code');

  const proRechnung = new Map<string, ParsedCsvRechnung>();
  let verwendet = 0, verworfen = 0;
  for (let z = 1; z < zeilen.length; z++) {
    const c = zeilen[z].split(';');
    const rechnungsNr = (c[iRech] ?? '').trim();
    const datum = (c[iDat] ?? '').trim();
    const bez = (c[iBez] ?? '').trim();
    if (!rechnungsNr || !/^\d{4}-\d{2}-\d{2}$/.test(datum) || !bez) { verworfen++; continue; }
    const docKey = `${rechnungsNr}|${datum}`;
    let r = proRechnung.get(docKey);
    if (!r) {
      r = { docKey, rechnungsNr, datum, markt: (c[iMarkt] ?? '').trim(), positionen: [], nettoTotal: 0, mwstTotal: 0, bruttoTotal: 0 };
      proRechnung.set(docKey, r);
    }
    const pos: WarenPosition = {
      artNr: (c[iArt] ?? '').trim(),
      bezeichnung: bez,
      warengruppe: iGrp >= 0 ? (c[iGrp] ?? '').trim() : '',
      menge: parseNum(c[iMenge]),
      einheit: iEinh >= 0 ? (c[iEinh] ?? '').trim() : '',
      preis: parseNum(c[iPreis]),
      positionspreis: parseNum(c[iPos]),
      mwstBetrag: iMwst >= 0 ? parseNum(c[iMwst]) : 0,
      mwstCode: iCode >= 0 ? parseNum(c[iCode]) : -1,
    };
    r.positionen.push(pos);
    r.nettoTotal += pos.positionspreis;
    r.mwstTotal += pos.mwstBetrag;
    verwendet++;
  }
  const rechnungen = [...proRechnung.values()].map(r => ({
    ...r,
    nettoTotal: Math.round(r.nettoTotal * 100) / 100,
    mwstTotal: Math.round(r.mwstTotal * 100) / 100,
    bruttoTotal: Math.round((r.nettoTotal + r.mwstTotal) * 100) / 100,
  })).sort((a, b) => a.datum.localeCompare(b.datum) || a.rechnungsNr.localeCompare(b.rechnungsNr));
  return {
    rechnungen,
    failureReason: rechnungen.length === 0 ? 'Keine gültigen Positionszeilen gefunden (Rechnungsnummer/Datum/Artikel fehlen).' : null,
    debug: { ...debugBasis, zeilenVerwendet: verwendet, zeilenVerworfen: verworfen },
  };
}

// ─── Warengruppe → Warenkonto (Kategorie folgt via kategorieFromKonto) ───────

/** Default-Zuordnung; unbekannte Gruppen → Lebensmittel 4000 (F&B-Portal). */
export function kontoFuerWarengruppe(warengruppe: string): string {
  const g = warengruppe.toLowerCase();
  if (g.includes('getränk') || g.includes('wein') || g.includes('bier') || g.includes('spirituos')) return '4020';
  if (g.includes('tiefkühl') || g.includes('tk')) return '4030';
  if (g.includes('reinigung') || g.includes('hygiene')) return '4050';
  if (g.includes('nonfood') || g.includes('non-food') || g.includes('non food')) return '4060';
  return '4000';
}

/** Netto/MwSt je Konto aggregieren (für kontoSplits; 1 Konto → einfache Zuweisung). */
export function kontoSplitsFuerRechnung(r: ParsedCsvRechnung): Array<{ warenkonto: string; amountNet: number; amountGross: number }> {
  const m = new Map<string, { net: number; gross: number }>();
  for (const p of r.positionen) {
    const konto = kontoFuerWarengruppe(p.warengruppe);
    const cur = m.get(konto) ?? { net: 0, gross: 0 };
    cur.net += p.positionspreis;
    cur.gross += p.positionspreis + p.mwstBetrag;
    m.set(konto, cur);
  }
  return [...m.entries()]
    .map(([warenkonto, v]) => ({ warenkonto, amountNet: Math.round(v.net * 100) / 100, amountGross: Math.round(v.gross * 100) / 100 }))
    .sort((a, b) => b.amountNet - a.amountNet);
}

// ─── Preis-Historie & Preisänderungs-Hinweise ────────────────────────────────

/** Letzter erfasster Einzelpreis pro (Lieferant + Artikel-Identität). */
export interface PreisEintrag {
  preis: number;         // Einzelpreis netto
  datum: string;         // YYYY-MM-DD der Rechnung
  name: string;          // Artikelbezeichnung (Anzeige)
  /** Quell-DOKUMENT (docKey `rechnungsNr|datum`) — Re-Import derselben Rechnung vergleicht NICHT neu. */
  rechnungsNr: string;
}
export type PreisHistorie = Record<string, PreisEintrag>;

export interface PreisSchwelle {
  /** Prozent-Schwelle für deutliche Warnung (Default 10). */
  pct: number;
  /** Mindest-Franken-Differenz, darunter kein Hinweis (Default 0.20). */
  minChf: number;
}
export const DEFAULT_PREIS_SCHWELLE: PreisSchwelle = { pct: 10, minChf: 0.2 };

/**
 * Artikel-Identität: Art.-Nr. wenn vorhanden, sonst normalisierte Bezeichnung;
 * beides fehlend → null (kein Hinweis möglich — kein Fehlalarm, Spez. 8).
 */
export function artikelKey(lieferant: string, pos: { artNr: string; bezeichnung: string }): string | null {
  const l = lieferant.trim().toLowerCase();
  if (pos.artNr.trim() !== '') return `${l}|nr:${pos.artNr.trim()}`;
  const name = pos.bezeichnung.trim().toLowerCase().replace(/\s+/g, ' ');
  return name ? `${l}|name:${name}` : null;
}

export interface PreisAenderung {
  key: string;
  artikel: string;
  artNr: string;
  alt: number;
  neu: number;
  diffAbs: number;          // neu − alt
  /** Prozent-Änderung; null wenn alter Preis ≤ 0 (nie durch 0 teilen). */
  diffPct: number | null;
  /** true = |Δ%| ≥ Schwelle → deutliche Warnung. */
  stark: boolean;
  erhoehung: boolean;
  /** Datum des alten Preises ("seit wann"). */
  seit: string;
}

/**
 * Vergleicht die Positionen einer Rechnung mit der Historie.
 * - Pfand/Gebinde (MwSt-Code 0) ausgenommen.
 * - Re-Import derselben Rechnung (gleiche rechnungsNr in der Historie) → kein Vergleich.
 * - Rundungs-Schutz: |Δ CHF| < minChf → kein Hinweis.
 * - Pro Artikel nur EIN Hinweis (erste abweichende Position zählt).
 */
export function berechnePreisAenderungen(
  rechnung: ParsedCsvRechnung,
  lieferant: string,
  historie: PreisHistorie,
  schwelle: PreisSchwelle = DEFAULT_PREIS_SCHWELLE,
): PreisAenderung[] {
  const out: PreisAenderung[] = [];
  const gesehen = new Set<string>();
  for (const p of rechnung.positionen) {
    if (p.mwstCode === 0) continue;             // Pfand/Gebinde
    if (!(p.preis > 0)) continue;               // Gutschriften/0-Preise nicht bewerten
    const key = artikelKey(lieferant, p);
    if (!key || gesehen.has(key)) continue;
    gesehen.add(key);
    const alt = historie[key];
    if (!alt || alt.rechnungsNr === rechnung.docKey) continue; // neu bzw. Re-Import desselben Dokuments
    const diffAbs = Math.round((p.preis - alt.preis) * 100) / 100;
    if (Math.abs(diffAbs) < schwelle.minChf) continue;
    const diffPct = alt.preis > 0 ? Math.round(((p.preis - alt.preis) / alt.preis) * 1000) / 10 : null;
    out.push({
      key, artikel: p.bezeichnung, artNr: p.artNr,
      alt: alt.preis, neu: p.preis, diffAbs, diffPct,
      stark: diffPct !== null && Math.abs(diffPct) >= schwelle.pct,
      erhoehung: diffAbs > 0,
      seit: alt.datum,
    });
  }
  // Deutliche zuerst, Erhöhungen vor Senkungen, dann grösste Abweichung.
  return out.sort((a, b) =>
    Number(b.stark) - Number(a.stark)
    || Number(b.erhoehung) - Number(a.erhoehung)
    || Math.abs(b.diffAbs) - Math.abs(a.diffAbs));
}

/**
 * Historie nach Import fortschreiben (immutable). Dublettensicher:
 * - Gleiche rechnungsNr → Eintrag ERSETZEN (Re-Import verfälscht nichts).
 * - Sonst gewinnt nur ein neueres/gleiches Datum (alte Dateien überschreiben
 *   keinen aktuelleren Preis).
 */
export function aktualisierePreisHistorie(
  historie: PreisHistorie,
  rechnungen: ParsedCsvRechnung[],
  lieferant: string,
): PreisHistorie {
  const next: PreisHistorie = { ...historie };
  for (const r of rechnungen) {
    for (const p of r.positionen) {
      if (p.mwstCode === 0 || !(p.preis > 0)) continue;
      const key = artikelKey(lieferant, p);
      if (!key) continue;
      const alt = next[key];
      if (alt && alt.rechnungsNr !== r.docKey && alt.datum > r.datum) continue;
      next[key] = { preis: p.preis, datum: r.datum, name: p.bezeichnung, rechnungsNr: r.docKey };
    }
  }
  return next;
}

/** Tolerante Normalisierung gespeicherter Blobs (nie werfen). */
export function normalizePreisHistorie(raw: unknown): PreisHistorie {
  if (!raw || typeof raw !== 'object') return {};
  const out: PreisHistorie = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    const preis = Number(o.preis);
    if (!Number.isFinite(preis) || preis <= 0) continue;
    out[k] = {
      preis,
      datum: typeof o.datum === 'string' ? o.datum : '',
      name: typeof o.name === 'string' ? o.name : '',
      rechnungsNr: typeof o.rechnungsNr === 'string' ? o.rechnungsNr : '',
    };
  }
  return out;
}

export function normalizePreisSchwelle(raw: unknown): PreisSchwelle {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pct = Number(o.pct), minChf = Number(o.minChf);
  return {
    pct: Number.isFinite(pct) && pct >= 0 ? pct : DEFAULT_PREIS_SCHWELLE.pct,
    minChf: Number.isFinite(minChf) && minChf >= 0 ? minChf : DEFAULT_PREIS_SCHWELLE.minChf,
  };
}
