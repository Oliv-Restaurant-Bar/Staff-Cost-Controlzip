/**
 * waren-analyse.ts — pure Analyse-Helfer für Warenrechnungen (kein IO).
 * =====================================================================
 * Gruppierungen (Lieferant/Konto/Woche/Monat), Top-Einzelrechnungen und
 * Anomalie-Erkennung (> Faktor × eigener Schnitt der Vorwochen; Woche über
 * Ziel-WKQ). Basis: erfasste InvoiceEntry (NETTO-Beträge).
 */

import type { InvoiceEntry, Warenkonto } from './waren-db';
import { zaehleUnkontierte } from './warenkosten-quote';
import { PSEUDO_KONTO_PFAND } from './waren-klassen';
import { normalizeWarenKonto } from './warenaufwand-gruppierung';

export type AnalyseDim = 'supplier' | 'konto' | 'week' | 'month';

export interface AnalyseGroupRow {
  key: string;
  label: string;
  totalNet: number;
  count: number;
  /** true = deutlich über dem eigenen Schnitt der Vorwochen (Anomalie, rot). */
  flagged: boolean;
  /**
   * Abweichung der letzten Periode gegenüber dem eigenen Schnitt in Prozent
   * (z.B. 42 = «+42 % über Schnitt»); null wenn kein Schnitt berechenbar.
   */
  deltaPct: number | null;
}

/** Anomalie-Schwelle: > +30 % gegenüber dem eigenen Vorwochen-Schnitt. */
export const ANOMALIE_FAKTOR = 1.3;
/** Mindestanzahl Vorwochen mit Daten, damit ein Schnitt aussagekräftig ist. */
export const ANOMALIE_MIN_VORWOCHEN = 2;

// ─── ISO-Woche ────────────────────────────────────────────────────────────────

/** ISO-Wochen-Schlüssel 'GJJJ-Wnn' (ISO-Wochenjahr!) für ein ISO-Datum. */
export function isoWeekKeyOf(dateIso: string): string {
  const d = new Date(dateIso + 'T12:00:00Z');
  const day = (d.getUTCDay() + 6) % 7; // Mo=0
  d.setUTCDate(d.getUTCDate() - day + 3); // Donnerstag der Woche
  const isoYear = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** Anzeige-Label 'KW nn' aus einem Wochen-Schlüssel 'GJJJ-Wnn'. */
export function weekLabelOf(weekKey: string): string {
  return `KW ${Number(weekKey.slice(-2))}`;
}

// ─── Zuordnung Rechnung → Dimension ──────────────────────────────────────────

const OHNE_KONTO = '—';

/** Netto-Anteile einer Rechnung je Warenkonto (Split zählt pro Konto). */
export function kontoShares(e: InvoiceEntry): { konto: string; net: number }[] {
  if (e.kontoSplits && e.kontoSplits.length > 0) {
    return e.kontoSplits.map(s => ({ konto: s.warenkonto || OHNE_KONTO, net: s.amountNet }));
  }
  return [{ konto: e.warenkonto || OHNE_KONTO, net: e.amountNet }];
}

export function supplierKeyOf(e: InvoiceEntry): string {
  return e.supplierName.trim() || OHNE_KONTO;
}

// ─── Gruppierungen ────────────────────────────────────────────────────────────

/**
 * Summen je Dimension, absteigend nach Betrag (Top zuerst) — ausser
 * Woche/Monat: chronologisch. `flagged` wird hier noch nicht gesetzt
 * (siehe flagAnomalies).
 */
export function groupTotals(
  entries: InvoiceEntry[],
  dim: AnalyseDim,
  konten?: Warenkonto[],
): AnalyseGroupRow[] {
  const map = new Map<string, { totalNet: number; count: number }>();
  const add = (key: string, net: number) => {
    const cur = map.get(key) ?? { totalNet: 0, count: 0 };
    cur.totalNet += net;
    cur.count += 1;
    map.set(key, cur);
  };
  for (const e of entries) {
    if (dim === 'supplier') add(supplierKeyOf(e), e.amountNet);
    else if (dim === 'konto') for (const s of kontoShares(e)) add(s.konto, s.net);
    else if (dim === 'week') add(isoWeekKeyOf(e.date), e.amountNet);
    else add(e.date.slice(0, 7), e.amountNet);
  }
  const kontoLabel = (v: string): string =>
    konten?.find(k => k.value === v)?.label ?? (v === OHNE_KONTO ? 'Ohne Konto' : v);
  const rows: AnalyseGroupRow[] = [...map.entries()].map(([key, v]) => ({
    key,
    label: dim === 'konto' ? kontoLabel(key) : dim === 'week' ? weekLabelOf(key) : key,
    totalNet: Math.round(v.totalNet * 100) / 100,
    count: v.count,
    flagged: false,
    deltaPct: null,
  }));
  if (dim === 'week' || dim === 'month') rows.sort((a, b) => a.key.localeCompare(b.key));
  else rows.sort((a, b) => b.totalNet - a.totalNet);
  return rows;
}

/** Grösste Einzelrechnungen (netto) des Zeitraums, Top zuerst. */
export function topInvoices(entries: InvoiceEntry[], n = 10): InvoiceEntry[] {
  return [...entries].sort((a, b) => b.amountNet - a.amountNet).slice(0, n);
}

// ─── Anomalie-Erkennung ───────────────────────────────────────────────────────

/**
 * Wochen-Totale je Entität (Lieferant/Konto) bzw. gesamthaft ('*' bei week).
 * Rückgabe: Map<entityKey, Map<weekKey, totalNet>>.
 */
function perWeekTotals(entries: InvoiceEntry[], dim: AnalyseDim): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  const add = (entity: string, week: string, net: number) => {
    const m = out.get(entity) ?? new Map<string, number>();
    m.set(week, (m.get(week) ?? 0) + net);
    out.set(entity, m);
  };
  for (const e of entries) {
    const wk = isoWeekKeyOf(e.date);
    if (dim === 'konto') for (const s of kontoShares(e)) add(s.konto, wk, s.net);
    else if (dim === 'supplier') add(supplierKeyOf(e), wk, e.amountNet);
    else add('*', wk, e.amountNet);
  }
  return out;
}

/**
 * Markiert Zeilen, deren Kosten deutlich über dem eigenen Schnitt liegen:
 * - supplier/konto: letzte Woche mit Daten > Faktor × Schnitt der Vorwochen
 *   (mind. ANOMALIE_MIN_VORWOCHEN Vorwochen mit Daten).
 * - week: Wochen-Total > Faktor × Schnitt aller früheren Wochen im Zeitraum.
 * - month: keine Markierung (zu wenig Vergleichsbasis auf Monatsebene).
 * Gibt die MUTIERTE rows-Liste zurück (flagged gesetzt).
 */
export function flagAnomalies(
  rows: AnalyseGroupRow[],
  entries: InvoiceEntry[],
  dim: AnalyseDim,
  faktor: number = ANOMALIE_FAKTOR,
): AnalyseGroupRow[] {
  if (dim === 'month') return rows;
  const weekly = perWeekTotals(entries, dim);
  if (dim === 'week') {
    const series = [...(weekly.get('*') ?? new Map<string, number>()).entries()]
      .sort((a, b) => a[0].localeCompare(b[0]));
    for (const row of rows) {
      const idx = series.findIndex(([wk]) => wk === row.key);
      const prev = series.slice(0, idx).map(([, t]) => t);
      if (prev.length >= ANOMALIE_MIN_VORWOCHEN) {
        const avg = prev.reduce((s, t) => s + t, 0) / prev.length;
        if (avg > 0) {
          row.deltaPct = Math.round(((row.totalNet / avg) - 1) * 100);
          row.flagged = row.totalNet > avg * faktor;
        }
      }
    }
    return rows;
  }
  for (const row of rows) {
    const m = weekly.get(row.key);
    if (!m) continue;
    const series = [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (series.length < ANOMALIE_MIN_VORWOCHEN + 1) continue;
    const last = series[series.length - 1][1];
    const prev = series.slice(0, -1).map(([, t]) => t);
    const avg = prev.reduce((s, t) => s + t, 0) / prev.length;
    if (avg > 0) {
      row.deltaPct = Math.round(((last / avg) - 1) * 100);
      row.flagged = last > avg * faktor;
    }
  }
  return rows;
}

// ─── Direkter Warenaufwand (= Erfolgsrechnung, Konten 4020–4070) ─────────────

/**
 * EINZIGE Warenkosten-Definition der Analyse (Befehl 08/2026):
 * Direkter Warenaufwand = Konten 4020 Wein · 4030 Bier · 4040 Spirituosen ·
 * 4050 Mineral · 4060 Küche · 4070 Kaffee/Tee — identisch zur Position
 * «Direkter Warenaufwand» der Erfolgsrechnung. Betriebs-/übrige Konten
 * (4090, 4701, 4800/4801 …) und unkontierte Positionen zählen NICHT in die
 * Hauptzahl/WKQ — sie werden separat ausgewiesen (Transparenz-Hinweis).
 */
export const DIREKTE_WARENKONTEN = ['4020', '4030', '4040', '4050', '4060', '4070'] as const;
const DIREKT_SET = new Set<number>(DIREKTE_WARENKONTEN.map(Number));
const DIREKT_BEVERAGE = new Set([4020, 4030, 4040, 4050]);

export interface DirekterAufwand {
  /** Σ netto Konten 4020–4070 — die EINE Warenkosten-Zahl der Analyse. */
  direktNet: number;
  /** Netto je Konto (nur 4020–4070, normalisierte 4-stellige Nummer). */
  jeKonto: Record<string, number>;
  /** Food-Anteil (4060 Küche + 4070 Kaffee/Tee). */
  foodNet: number;
  /** Beverage-Anteil (4020–4050). */
  beverageNet: number;
  /** Übrige kontierte Konten (4090, 4701, 48xx, …) — NICHT in der Hauptzahl. */
  uebrigNet: number;
  /** Unkontierte Anteile (kein numerisches Konto, ohne Depot) — NICHT in der Hauptzahl. */
  unkontiertNet: number;
  unkontiertCount: number;
}

/** Direkter Warenaufwand über kontoShares (Splits zählen pro Konto, Depot neutral). */
export function direkterWarenaufwand(entries: InvoiceEntry[]): DirekterAufwand {
  const jeKonto: Record<string, number> = {};
  let direkt = 0, food = 0, bev = 0, uebrig = 0, unkNet = 0, unkCount = 0;
  for (const e of entries) {
    for (const s of kontoShares(e)) {
      const roh = (s.konto ?? '').trim();
      if (roh === PSEUDO_KONTO_PFAND) continue; // Depot/Pfand: neutral
      const n = normalizeWarenKonto(roh);
      if (n !== null && DIREKT_SET.has(n)) {
        const k = String(n);
        jeKonto[k] = (jeKonto[k] ?? 0) + s.net;
        direkt += s.net;
        if (DIREKT_BEVERAGE.has(n)) bev += s.net; else food += s.net;
      } else if (n !== null) {
        uebrig += s.net;
      } else {
        unkNet += s.net;
        unkCount += 1;
      }
    }
  }
  const r2 = (x: number) => Math.round(x * 100) / 100;
  for (const k of Object.keys(jeKonto)) jeKonto[k] = r2(jeKonto[k]);
  return {
    direktNet: r2(direkt), jeKonto, foodNet: r2(food), beverageNet: r2(bev),
    uebrigNet: r2(uebrig), unkontiertNet: r2(unkNet), unkontiertCount: unkCount,
  };
}

/** Netto-Anteil einer einzelnen Rechnung am direkten Warenaufwand. */
export function direktAnteilNet(e: InvoiceEntry): number {
  return direkterWarenaufwand([e]).direktNet;
}

function istDirektKonto(konto: string | undefined): boolean {
  const roh = (konto ?? '').trim();
  if (roh === PSEUDO_KONTO_PFAND) return false;
  const n = normalizeWarenKonto(roh);
  return n !== null && DIREKT_SET.has(n);
}

/**
 * Rechnungen auf ihren DIREKTEN Warenaufwand-Anteil (4020–4070) projiziert:
 * amountNet/amountGross anteilig, Split-Listen auf direkte Konten gefiltert,
 * Einträge ohne direkten Anteil entfernt. Damit rechnen ALLE Analyse-Sichten
 * (Lieferanten/Konto/Wochen-Gruppen, Anomalien, Top-Rechnungen) auf derselben
 * einen Definition wie KPI-Box und WKQ.
 */
export function nurDirektAnteil(entries: InvoiceEntry[]): InvoiceEntry[] {
  const out: InvoiceEntry[] = [];
  for (const e of entries) {
    if (e.kontoSplits && e.kontoSplits.length > 0) {
      const direkt = e.kontoSplits.filter(s => istDirektKonto(s.warenkonto));
      if (direkt.length === 0) continue;
      if (direkt.length === e.kontoSplits.length) { out.push(e); continue; }
      out.push({
        ...e,
        kontoSplits: direkt,
        amountNet: direkt.reduce((s, x) => s + (Number.isFinite(x.amountNet) ? x.amountNet : 0), 0),
        amountGross: direkt.reduce((s, x) => s + (Number.isFinite(x.amountGross) ? x.amountGross : 0), 0),
      });
      continue;
    }
    if (istDirektKonto(e.warenkonto)) out.push(e);
  }
  return out;
}

// ─── Gegenüberstellung Erfolgsrechnung je Konto ──────────────────────────────

export interface DirektKontoZeile {
  konto: string;         // '4020' … '4070'
  label: string;         // Kontobezeichnung
  erfasst: number;       // Σ netto aus der App (Rechnungen/Splits)
  er: number | null;     // Erfolgsrechnung/Buchhaltung — null ohne ER-Daten
  diff: number | null;   // er − erfasst
}

export interface DirektKontoVergleich {
  zeilen: DirektKontoZeile[];
  totalErfasst: number;
  totalEr: number | null;
  totalDiff: number | null;
}

/**
 * Tabelle je Konto 4020–4070: Erfasst (App) | Erfolgsrechnung | Differenz,
 * plus Summenzeile «Direkter Warenaufwand». `erJeKonto` = ER-Beträge je
 * Konto (null = keine ER-Daten im Zeitraum → keine Differenzen, nie stille 0;
 * fehlendes Konto bei vorhandener ER = 0, dort wurde nichts gebucht).
 */
export function buildDirektKontoVergleich(
  entries: InvoiceEntry[],
  erJeKonto: Record<string, number> | null,
  kontoNamen?: Record<string, string>,
): DirektKontoVergleich {
  const d = direkterWarenaufwand(entries);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const zeilen: DirektKontoZeile[] = DIREKTE_WARENKONTEN.map(k => {
    const erfasst = d.jeKonto[k] ?? 0;
    const er = erJeKonto ? r2(erJeKonto[k] ?? 0) : null;
    return {
      konto: k,
      label: kontoNamen?.[k] ?? k,
      erfasst,
      er,
      diff: er === null ? null : r2(er - erfasst),
    };
  });
  const totalEr = erJeKonto ? r2(zeilen.reduce((s, z) => s + (z.er ?? 0), 0)) : null;
  return {
    zeilen,
    totalErfasst: d.direktNet,
    totalEr,
    totalDiff: totalEr === null ? null : r2(totalEr - d.direktNet),
  };
}

// ─── WKQ je Woche ─────────────────────────────────────────────────────────────

export interface WochenWkqRow {
  weekKey: string;
  label: string;
  warenNet: number;
  umsatzNet: number | null; // null = kein Umsatz erfasst → keine WKQ
  wkqPct: number | null;
  /** 'red' über Ziel, 'green' unter/gleich Ziel, null ohne WKQ. */
  ampel: 'green' | 'red' | null;
}

/**
 * WKQ je ISO-Woche: DIREKTER Warenaufwand (Konten 4020–4070, netto) ÷
 * Netto-Umsatz derselben Woche — dieselbe Basis wie alle Analyse-KPIs.
 * revenueByDate: ISO-Datum → Netto-Umsatz. Wochen ohne Umsatz → wkq null.
 */
export function wochenWkq(
  entries: InvoiceEntry[],
  revenueByDate: Record<string, number>,
  zielPct: number,
): WochenWkqRow[] {
  const proWoche = new Map<string, InvoiceEntry[]>();
  for (const e of entries) {
    const wk = isoWeekKeyOf(e.date);
    (proWoche.get(wk) ?? proWoche.set(wk, []).get(wk)!).push(e);
  }
  const waren = new Map<string, number>();
  for (const [wk, list] of proWoche) {
    waren.set(wk, direkterWarenaufwand(list).direktNet);
  }
  const umsatz = new Map<string, number>();
  for (const [date, rev] of Object.entries(revenueByDate)) {
    if (!Number.isFinite(rev) || rev <= 0) continue;
    const wk = isoWeekKeyOf(date);
    umsatz.set(wk, (umsatz.get(wk) ?? 0) + rev);
  }
  return [...waren.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([weekKey, warenNet]) => {
      const u = umsatz.get(weekKey) ?? null;
      const wkq = u !== null && u > 0 ? Math.round((warenNet / u) * 1000) / 10 : null;
      return {
        weekKey,
        label: weekLabelOf(weekKey),
        warenNet: Math.round(warenNet * 100) / 100,
        umsatzNet: u,
        wkqPct: wkq,
        ampel: wkq === null ? null : wkq > zielPct ? 'red' : 'green',
      };
    });
}

// ─── Kennzahlen-Kopf ─────────────────────────────────────────────────────────

export interface AnalyseKpis {
  /** Hauptzahl = DIREKTER Warenaufwand (Konten 4020–4070) — eine Definition für alles. */
  totalNet: number;
  foodNet: number;      // 4060 + 4070
  beverageNet: number;  // 4020–4050
  /** WKQ-Basis — identisch mit totalNet (direkter Warenaufwand). */
  relevantNet: number;
  /** Übrige kontierte Konten (4090/4701/48xx …) — NICHT in Hauptzahl/Quote. */
  uebrigNet: number;
  /** Unkontierte Anteile — NICHT in Hauptzahl/Quote (nur Hinweis). */
  unkontiertNet: number;
  /** Unkontierte Einträge/Splits (Transparenz-Hinweis). */
  unkontiert: number;
  /** Anteil Food/Beverage am direkten Warenaufwand in % (null wenn 0). */
  foodSharePct: number | null;
  beverageSharePct: number | null;
  top3: { label: string; totalNet: number }[];
}

export function analyseKpis(entries: InvoiceEntry[]): AnalyseKpis {
  // EINE Definition für alle Analyse-Zahlen: direkter Warenaufwand 4020–4070.
  const d = direkterWarenaufwand(entries);
  // Top-3-Kostentreiber auf derselben Basis (direkt-Anteil je Lieferant).
  const proLieferant = new Map<string, number>();
  for (const e of entries) {
    const anteil = direktAnteilNet(e);
    if (anteil <= 0) continue;
    const k = supplierKeyOf(e);
    proLieferant.set(k, (proLieferant.get(k) ?? 0) + anteil);
  }
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const top3 = [...proLieferant.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([label, totalNet]) => ({ label, totalNet: r2(totalNet) }));
  return {
    totalNet: d.direktNet, foodNet: d.foodNet, beverageNet: d.beverageNet,
    relevantNet: d.direktNet,
    uebrigNet: d.uebrigNet, unkontiertNet: d.unkontiertNet,
    unkontiert: zaehleUnkontierte(entries),
    foodSharePct: d.direktNet > 0 ? Math.round((d.foodNet / d.direktNet) * 1000) / 10 : null,
    beverageSharePct: d.direktNet > 0 ? Math.round((d.beverageNet / d.direktNet) * 1000) / 10 : null,
    top3,
  };
}
