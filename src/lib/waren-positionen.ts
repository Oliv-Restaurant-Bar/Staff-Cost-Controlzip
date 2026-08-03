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
// ─── Warengruppe → Konto (konfigurierbare Zuordnungstabelle) ────────────────

/** Eine Zuordnungsregel: normalisierter Warengruppen-Name → Kontonummer. */
export interface WarengruppenRegel {
  /** Warengruppe wie im CSV (Anzeige-Schreibweise). */
  gruppe: string;
  /** Kontonummer, z.B. '4020'. */
  konto: string;
}
export type WarengruppenMapping = WarengruppenRegel[];

/** Vorbelegung gemäss Kontenplan (Restaurant). */
export const DEFAULT_WARENGRUPPEN_MAPPING: WarengruppenMapping = [
  { gruppe: 'Wein',                konto: '4020' },
  { gruppe: 'Bier',                konto: '4030' },
  { gruppe: 'Spirituosen',         konto: '4040' },
  { gruppe: 'Getränke',            konto: '4050' },
  { gruppe: 'Metzgerei',           konto: '4060' },
  { gruppe: 'Früchte + Gemüse',    konto: '4060' },
  { gruppe: 'Molkerei/Backwaren',  konto: '4060' },
  { gruppe: 'Food',                konto: '4060' },
  { gruppe: 'Nearfood',            konto: '4701' },
  { gruppe: 'Nonfood',             konto: '4701' },
];

const normGruppe = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Positions-Kontierung: zugeordnet / Pfand (neutral, kein Warenkonto) / offen (unbekannte Gruppe — NIE raten). */
export type PositionsKontoStatus = 'zugeordnet' | 'pfand' | 'offen';
export interface PositionsKonto {
  konto: string | null;      // null bei pfand/offen
  status: PositionsKontoStatus;
}

export function kontoFuerPosition(
  p: Pick<WarenPosition, 'warengruppe' | 'mwstCode'>,
  mapping: WarengruppenMapping,
): PositionsKonto {
  if (p.mwstCode === 0) return { konto: null, status: 'pfand' }; // Pfand/Gebinde → neutral/Depot
  const g = normGruppe(p.warengruppe);
  if (g) {
    const regel = mapping.find(r => normGruppe(r.gruppe) === g);
    if (regel && regel.konto.trim()) return { konto: regel.konto.trim(), status: 'zugeordnet' };
  }
  return { konto: null, status: 'offen' }; // unbekannt → nachfragen, nicht raten
}

/** Anzeige-Labels für nicht kontierte Positionen in Splits/Exporten. */
export const KONTO_LABEL_PFAND = 'Depot';
export const KONTO_LABEL_OFFEN = 'offen';

/**
 * Netto/MwSt je Konto aggregieren (für kontoSplits).
 * Pfand → Pseudo-Split «Depot», unbekannte Gruppen → «offen»
 * (nicht-numerische Splits zählen in der Kontoklassen-Logik wie bisher
 * als Legacy-Warenkosten — Totale/WKQ bleiben unverändert).
 */
export function kontoSplitsFuerRechnung(
  r: ParsedCsvRechnung,
  mapping: WarengruppenMapping = DEFAULT_WARENGRUPPEN_MAPPING,
  /** Optionale manuelle Overrides je Positions-Index. */
  overrides?: Record<number, string>,
): Array<{ warenkonto: string; amountNet: number; amountGross: number }> {
  const m = new Map<string, { net: number; gross: number }>();
  r.positionen.forEach((p, i) => {
    const ov = overrides?.[i]?.trim();
    const pk = ov ? { konto: ov, status: 'zugeordnet' as const } : kontoFuerPosition(p, mapping);
    const key = pk.status === 'zugeordnet' ? pk.konto! : pk.status === 'pfand' ? KONTO_LABEL_PFAND : KONTO_LABEL_OFFEN;
    const cur = m.get(key) ?? { net: 0, gross: 0 };
    cur.net += p.positionspreis;
    cur.gross += p.positionspreis + p.mwstBetrag;
    m.set(key, cur);
  });
  return [...m.entries()]
    .map(([warenkonto, v]) => ({ warenkonto, amountNet: Math.round(v.net * 100) / 100, amountGross: Math.round(v.gross * 100) / 100 }))
    .sort((a, b) => b.amountNet - a.amountNet);
}

/** Unbekannte Warengruppen einer Rechnungsliste (für den «Konto offen»-Hinweis vor dem Import). */
export function offeneWarengruppen(rechnungen: ParsedCsvRechnung[], mapping: WarengruppenMapping): string[] {
  const set = new Map<string, string>();
  for (const r of rechnungen) for (const p of r.positionen) {
    if (kontoFuerPosition(p, mapping).status === 'offen') {
      const key = normGruppe(p.warengruppe) || '(leer)';
      if (!set.has(key)) set.set(key, p.warengruppe.trim() || '(leer)');
    }
  }
  return [...set.values()].sort((a, b) => a.localeCompare(b, 'de-CH'));
}

export function normalizeWarengruppenMapping(raw: unknown): WarengruppenMapping {
  if (!Array.isArray(raw)) return DEFAULT_WARENGRUPPEN_MAPPING;
  const out: WarengruppenMapping = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const gruppe = typeof (r as WarengruppenRegel).gruppe === 'string' ? (r as WarengruppenRegel).gruppe.trim() : '';
    const konto = typeof (r as WarengruppenRegel).konto === 'string' ? (r as WarengruppenRegel).konto.trim() : '';
    if (gruppe && konto) out.push({ gruppe, konto });
  }
  return out.length > 0 ? out : DEFAULT_WARENGRUPPEN_MAPPING;
}

// ─── Persistierte Rechnungspositionen (pro InvoiceEntry) ─────────────────────

/** Eine gespeicherte Position inkl. Kontierung (manuell überschreibbar). */
export interface GespeichertePosition {
  artNr: string;
  bezeichnung: string;
  warengruppe: string;
  menge: number;
  einheit: string;
  preis: number;           // Einzelpreis netto
  positionspreis: number;  // Netto der Position
  mwstBetrag: number;
  mwstCode: number;
  konto: string | null;    // null = Pfand/offen
  status: PositionsKontoStatus;
  /** true, wenn das Konto manuell überschrieben wurde (Auto-Zuordnung fasst es nicht mehr an). */
  manuell?: boolean;
}
/** Record<invoiceId, Positionen> — pro Monat persistiert. */
export type PositionenProRechnung = Record<string, GespeichertePosition[]>;

export function positionenAusRechnung(r: ParsedCsvRechnung, mapping: WarengruppenMapping): GespeichertePosition[] {
  return r.positionen.map(p => {
    const pk = kontoFuerPosition(p, mapping);
    return {
      artNr: p.artNr, bezeichnung: p.bezeichnung, warengruppe: p.warengruppe,
      menge: p.menge, einheit: p.einheit, preis: p.preis,
      positionspreis: p.positionspreis, mwstBetrag: p.mwstBetrag, mwstCode: p.mwstCode,
      konto: pk.konto, status: pk.status,
    };
  });
}

/** kontoSplits aus GESPEICHERTEN Positionen (nach manuellen Overrides) neu ableiten. */
export function kontoSplitsAusPositionen(
  positionen: GespeichertePosition[],
): Array<{ warenkonto: string; amountNet: number; amountGross: number }> {
  const m = new Map<string, { net: number; gross: number }>();
  for (const p of positionen) {
    const key = p.konto && p.konto.trim()
      ? p.konto.trim()
      : p.status === 'pfand' ? KONTO_LABEL_PFAND : KONTO_LABEL_OFFEN;
    const cur = m.get(key) ?? { net: 0, gross: 0 };
    cur.net += p.positionspreis;
    cur.gross += p.positionspreis + p.mwstBetrag;
    m.set(key, cur);
  }
  return [...m.entries()]
    .map(([warenkonto, v]) => ({ warenkonto, amountNet: Math.round(v.net * 100) / 100, amountGross: Math.round(v.gross * 100) / 100 }))
    .sort((a, b) => b.amountNet - a.amountNet);
}

/**
 * Re-Import: manuelle Konto-Overrides aus dem Altbestand übernehmen.
 * Identität einer Position = Art.-Nr. (bevorzugt) bzw. normalisierte
 * Bezeichnung. Nur `manuell`-markierte Alt-Kontierungen überleben; alles
 * andere folgt der (ggf. aktualisierten) Zuordnungstabelle.
 */
export function uebernehmeManuelleKontierung(
  neu: GespeichertePosition[],
  alt: GespeichertePosition[] | undefined,
): GespeichertePosition[] {
  if (!alt || alt.length === 0) return neu;
  const posKey = (p: GespeichertePosition) =>
    p.artNr.trim() ? `nr:${p.artNr.trim().toLowerCase()}` : `name:${p.bezeichnung.trim().toLowerCase().replace(/\s+/g, ' ')}`;
  const manuelle = new Map<string, GespeichertePosition>();
  for (const p of alt) if (p.manuell) manuelle.set(posKey(p), p);
  if (manuelle.size === 0) return neu;
  return neu.map(p => {
    const m = manuelle.get(posKey(p));
    return m ? { ...p, konto: m.konto, status: m.status, manuell: true } : p;
  });
}

export function normalizePositionenProRechnung(raw: unknown): PositionenProRechnung {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: PositionenProRechnung = {};
  for (const [id, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(val)) continue;
    const liste = val.filter((p): p is GespeichertePosition =>
      !!p && typeof p === 'object'
      && typeof (p as GespeichertePosition).bezeichnung === 'string'
      && Number.isFinite((p as GespeichertePosition).positionspreis));
    if (liste.length > 0) out[id] = liste;
  }
  return out;
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
