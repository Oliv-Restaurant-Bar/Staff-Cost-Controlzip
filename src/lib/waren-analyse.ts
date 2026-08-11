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
import type { SageJournalEntry } from '@/types/reporting';
import { barausgabenLieferant, barausgabenAliasGruppen, buchungsBetrag } from './waren-abgleich';
import { findSupplierInText, type SupplierAliasMap } from './waren-pdf-erkennung';
import { buildAliasResolver, type AliasGruppe } from './waren-alias-gruppen';

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
/** Non-Food-/Betriebskonten für den Kontierungs-Check (App bucht hier, FIBU fälschlich auf Warenkonto). */
export const NONFOOD_KONTEN = ['4090', '4701'] as const;
const NONFOOD_SET = new Set<number>(NONFOOD_KONTEN.map(Number));
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

// ─── Konto-Drilldown: Woraus besteht die Differenz? ──────────────────────────

export interface KontoDrilldownZeile {
  lieferant: string;
  /** App-Netto auf DIESEM Konto (kontoShares, alias-kanonisiert). */
  app: number;
  /** FIBU (Soll−Haben) auf diesem Konto; null ohne Journal-Daten. */
  fibu: number | null;
  /** fibu − app (nur mit Journal). */
  diff: number | null;
  /**
   * Konto-Split-Hinweis: gesetzt, wenn die Differenz auf diesem Konto
   * (grösstenteils) eine ZUORDNUNGS-Differenz ist — der Lieferant wird in App
   * und FIBU auf UNTERSCHIEDLICHE direkte Konten verteilt, das Total über
   * alle 4020–4070 stimmt aber (annähernd) überein. Enthält beide
   * Verteilungen für die Anzeige «+X hier, gegengleich −Y auf …».
   */
  splitHinweis: {
    appJeKonto: Record<string, number>;
    fibuJeKonto: Record<string, number>;
    /** Gesamt-Differenz des Lieferanten über ALLE direkten Konten. */
    totalDiff: number;
    /**
     * true = Total gleicht sich (bis Rundung) aus → REINE Zuordnung, kein
     * Fehlbetrag. false = nur teilweiser Ausgleich — es bleibt ein echter
     * Restbetrag (totalDiff), der separat auszuweisen ist.
     */
    reineZuordnung: boolean;
  } | null;
  /**
   * Kontierungs-Check: die App bucht bei diesem Lieferanten Non-Food auf
   * 4701/4090, die FIBU hat (annähernd) diesen Betrag zusätzlich auf DIESEM
   * Warenkonto → vermutlicher Kontierungs-Fehler, Umbuchung vorschlagen.
   */
  kontierungsHinweis: {
    /** Vermutlich falsch kontierter Betrag (auf diesem Warenkonto). */
    betrag: number;
    vonKonto: string;  // dieses Warenkonto (z.B. '4060')
    nachKonto: string; // Non-Food-Zielkonto der App (z.B. '4701')
    /** App-Betrag auf dem Non-Food-Konto (Kontext für den Hinweis). */
    appNonfood: number;
    /** FIBU-Betrag auf den Non-Food-Konten (0 wenn dort nichts gebucht). */
    fibuNonfood: number;
  } | null;
  /**
   * Klassifikation der Differenz:
   * 'ok' — exakt (±0.05); 'kontierung' — Umbuchung in FIBU nötig;
   * 'zuordnung' — Konto-Split, Total stimmt, keine Korrektur;
   * 'fehlende_rechnung' — FIBU > App, in App nachtragen;
   * 'unklar' — App > FIBU (periodenfremd? in FIBU prüfen); null ohne Journal.
   */
  typ: 'ok' | 'kontierung' | 'zuordnung' | 'fehlende_rechnung' | 'unklar' | null;
}

export interface KontoDrilldown {
  konto: string;
  zeilen: KontoDrilldownZeile[];
  appTotal: number;
  fibuTotal: number | null;
  diffTotal: number | null;
  /** FIBU-Buchungen auf diesem Konto ohne Lieferanten-Zuordnung (Summe). */
  nichtZugeordnet: number | null;
  hatJournal: boolean;
}

/**
 * Drilldown einer Konto-Differenz (Gegenüberstellung Erfasst vs. ER):
 * je Lieferant App-Betrag vs. FIBU-Betrag auf DIESEM Konto, inkl.
 * Konto-Split-Erkennung (z.B. Feldschlösschen: FIBU alles auf 4030,
 * App gesplittet auf 4030/4040/4050 → Zuordnung, kein Fehlbetrag).
 * Ohne Journal (nur ER-Totale) degradiert: nur App-Seite je Lieferant.
 */
export function buildKontoDrilldown(input: {
  entries: InvoiceEntry[];
  journal: SageJournalEntry[] | null;
  konto: string;
  supplierNames: string[];
  aliases: SupplierAliasMap;
  aliasGruppen?: AliasGruppe[];
}): KontoDrilldown {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const kontoNorm = String(normalizeWarenKonto(input.konto) ?? input.konto);

  // ── Journal auf direkte Konten filtern (alle 6 — für Split-Verteilungen) ──
  const direktJournal = (input.journal ?? []).filter(e => {
    const n = normalizeWarenKonto(String(e.accountNumber ?? ''));
    return n !== null && DIREKT_SET.has(n);
  });
  // Non-Food-Konten (4090/4701) separat — nur für den Kontierungs-Check.
  const nonfoodJournal = (input.journal ?? []).filter(e => {
    const n = normalizeWarenKonto(String(e.accountNumber ?? ''));
    return n !== null && NONFOOD_SET.has(n);
  });
  const hatJournal = direktJournal.length > 0;

  const effektiveGruppen = [
    ...barausgabenAliasGruppen(direktJournal),
    ...(input.aliasGruppen ?? []),
  ];
  const resolve = buildAliasResolver(effektiveGruppen);

  // ── App-Seite: Lieferant → Konto → Netto (direkte + Non-Food-Konten) ──
  const appMap = new Map<string, Record<string, number>>();
  const appNonfoodMap = new Map<string, Record<string, number>>();
  for (const e of input.entries) {
    const canon = resolve(e.supplierName);
    for (const s of kontoShares(e)) {
      const roh = (s.konto ?? '').trim();
      if (roh === PSEUDO_KONTO_PFAND) continue;
      const n = normalizeWarenKonto(roh);
      if (n === null) continue;
      const k = String(n);
      if (DIREKT_SET.has(n)) {
        const rec = appMap.get(canon) ?? {};
        rec[k] = (rec[k] ?? 0) + s.net;
        appMap.set(canon, rec);
      } else if (NONFOOD_SET.has(n)) {
        const rec = appNonfoodMap.get(canon) ?? {};
        rec[k] = (rec[k] ?? 0) + s.net;
        appNonfoodMap.set(canon, rec);
      }
    }
  }

  // ── FIBU-Seite: Lieferant → Konto → Betrag (Soll−Haben) ──
  const fibuMap = new Map<string, Record<string, number>>();
  const fibuNonfoodMap = new Map<string, Record<string, number>>();
  let nichtZugeordnet = 0;
  if (hatJournal) {
    const gruppenAliasNamen = (input.aliasGruppen ?? []).flatMap(g => [...g.aliases, g.name]);
    const erfassteNamen = input.entries.map(e => e.supplierName);
    const matchNamen = [...new Set([...input.supplierNames, ...gruppenAliasNamen, ...erfassteNamen])];
    for (const e of direktJournal) {
      const k = String(normalizeWarenKonto(String(e.accountNumber ?? '')));
      const hit = barausgabenLieferant(e.text) ?? findSupplierInText(e.text ?? '', matchNamen, input.aliases, resolve);
      if (hit) {
        const canon = resolve(hit);
        const rec = fibuMap.get(canon) ?? {};
        rec[k] = (rec[k] ?? 0) + buchungsBetrag(e);
        fibuMap.set(canon, rec);
      } else if (k === kontoNorm) {
        nichtZugeordnet += buchungsBetrag(e);
      }
    }
    for (const e of nonfoodJournal) {
      const k = String(normalizeWarenKonto(String(e.accountNumber ?? '')));
      const hit = barausgabenLieferant(e.text) ?? findSupplierInText(e.text ?? '', matchNamen, input.aliases, resolve);
      if (hit) {
        const canon = resolve(hit);
        const rec = fibuNonfoodMap.get(canon) ?? {};
        rec[k] = (rec[k] ?? 0) + buchungsBetrag(e);
        fibuNonfoodMap.set(canon, rec);
      }
    }
  }

  // ── Zeilen: Union der Lieferanten mit Betrag auf DIESEM Konto ──
  const namen = new Set<string>();
  for (const [name, rec] of appMap) if (Math.abs(rec[kontoNorm] ?? 0) > 0.005) namen.add(name);
  for (const [name, rec] of fibuMap) if (Math.abs(rec[kontoNorm] ?? 0) > 0.005) namen.add(name);

  const zeilen: KontoDrilldownZeile[] = [...namen].map(name => {
    const appJeKonto = appMap.get(name) ?? {};
    const fibuJeKonto = fibuMap.get(name) ?? {};
    const app = r2(appJeKonto[kontoNorm] ?? 0);
    const fibu = hatJournal ? r2(fibuJeKonto[kontoNorm] ?? 0) : null;
    const diff = fibu === null ? null : r2(fibu - app);

    // Split-Erkennung: Konto-Differenz vorhanden, aber Lieferanten-Total
    // über alle direkten Konten (annähernd) ausgeglichen → reine Zuordnung.
    let splitHinweis: KontoDrilldownZeile['splitHinweis'] = null;
    if (hatJournal && diff !== null && Math.abs(diff) > 0.05) {
      const appTotal = Object.values(appJeKonto).reduce((a, b) => a + b, 0);
      const fibuTotal = Object.values(fibuJeKonto).reduce((a, b) => a + b, 0);
      const totalDiff = r2(fibuTotal - appTotal);
      if (Math.abs(totalDiff) < Math.abs(diff) - 0.05) {
        const clean = (rec: Record<string, number>) => {
          const out: Record<string, number> = {};
          for (const [k, v] of Object.entries(rec)) if (Math.abs(v) > 0.005) out[k] = r2(v);
          return out;
        };
        splitHinweis = {
          appJeKonto: clean(appJeKonto), fibuJeKonto: clean(fibuJeKonto), totalDiff,
          reineZuordnung: Math.abs(totalDiff) <= 0.05,
        };
      }
    }
    // Kontierungs-Check: FIBU hat MEHR auf diesem Warenkonto, und der App
    // fehlt (annähernd) derselbe Betrag auf ihren Non-Food-Konten in der FIBU
    // → Non-Food vermutlich falsch aufs Warenkonto gebucht (Umbuchung nötig).
    // Defizit wird PRO Non-Food-Konto ermittelt (richtiges Zielkonto) und
    // über die positiven Konto-Differenzen nur EINMAL zugeteilt — die Summe
    // der Vorschläge über alle 6 Konten kann das Defizit nie übersteigen.
    let kontierungsHinweis: KontoDrilldownZeile['kontierungsHinweis'] = null;
    const appNonfoodRec = appNonfoodMap.get(name) ?? {};
    const fibuNonfoodRec = fibuNonfoodMap.get(name) ?? {};
    const appNonfood = r2(Object.values(appNonfoodRec).reduce((a, b) => a + b, 0));
    if (hatJournal && diff !== null && diff > 0.05 && appNonfood > 0.05 && !(splitHinweis?.reineZuordnung)) {
      const fibuNonfood = r2(Object.values(fibuNonfoodRec).reduce((a, b) => a + b, 0));
      // Defizit je Non-Food-Konto: App gebucht, in FIBU (teilweise) fehlend.
      const defizite = Object.entries(appNonfoodRec)
        .map(([k, v]) => [k, r2(v - (fibuNonfoodRec[k] ?? 0))] as const)
        .filter(([, d]) => d > 0.05)
        .sort((a, b) => b[1] - a[1]);
      const nonfoodFehlt = r2(defizite.reduce((s, [, d]) => s + d, 0));
      if (nonfoodFehlt > 0.05) {
        // Zuteilung: Defizit sequenziell auf die positiven Differenzen ALLER
        // direkten Konten verteilen (grösste zuerst, dann Kontonummer) —
        // deterministisch identisch für jeden buildKontoDrilldown-Aufruf.
        const direktDiffs = DIREKTE_WARENKONTEN
          .map(k => [k, r2((fibuJeKonto[k] ?? 0) - (appJeKonto[k] ?? 0))] as const)
          .filter(([, d]) => d > 0.05)
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        let rest = nonfoodFehlt;
        let zugeteilt = 0;
        for (const [k, d] of direktDiffs) {
          const take = Math.min(d, rest);
          rest = r2(rest - take);
          if (k === kontoNorm) { zugeteilt = r2(take); break; }
          if (rest <= 0) break;
        }
        // Nur wenn der zugeteilte Betrag die Konto-Differenz grösstenteils erklärt.
        if (zugeteilt > 0.05 && zugeteilt >= diff * 0.5) {
          kontierungsHinweis = {
            betrag: zugeteilt,
            vonKonto: kontoNorm,
            nachKonto: defizite[0][0],
            appNonfood,
            fibuNonfood,
          };
        }
      }
    }

    let typ: KontoDrilldownZeile['typ'] = null;
    if (diff !== null) {
      if (Math.abs(diff) <= 0.05) typ = 'ok';
      else if (kontierungsHinweis) typ = 'kontierung';
      else if (splitHinweis?.reineZuordnung) typ = 'zuordnung';
      else if (diff > 0) typ = 'fehlende_rechnung';
      else typ = 'unklar';
    }
    return { lieferant: name, app, fibu, diff, splitHinweis, kontierungsHinweis, typ };
  }).sort((a, b) => Math.abs(b.diff ?? b.app) - Math.abs(a.diff ?? a.app));

  const appTotal = r2(zeilen.reduce((s, z) => s + z.app, 0));
  const fibuTotal = hatJournal
    ? r2(zeilen.reduce((s, z) => s + (z.fibu ?? 0), 0) + nichtZugeordnet)
    : null;
  return {
    konto: kontoNorm,
    zeilen,
    appTotal,
    fibuTotal,
    diffTotal: fibuTotal === null ? null : r2(fibuTotal - appTotal),
    nichtZugeordnet: hatJournal ? r2(nichtZugeordnet) : null,
    hatJournal,
  };
}

// ─── Korrektur-Vorschläge (für die Buchhaltung / den Treuhänder) ─────────────

export interface KorrekturVorschlag {
  typ: 'kontierung' | 'fehlende_rechnung' | 'zuordnung' | 'unklar';
  lieferant: string;
  konto: string;
  betrag: number;
  /** Kopierbarer Ein-Zeilen-Text für die Buchhaltung. */
  text: string;
}

/** CHF-Betrag im de-CH-Format (1'852.39) für kopierbare Texte. */
export function fmtChfText(x: number): string {
  // de-CH liefert U+2019 (’) als Tausendertrenner — für kopierbare Texte den
  // geraden Apostroph verwenden (Buchhaltungs-Software-tauglich).
  return x.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/\u2019/g, "'");
}

/**
 * Alle offenen Korrektur-Vorschläge des Monats über ALLE direkten Konten
 * (4020–4070): pro abweichendem Lieferant×Konto ein konkreter, kopierbarer
 * Vorschlag, klassifiziert als KONTIERUNG (Umbuchung in FIBU) |
 * FEHLENDE RECHNUNG (in App nachtragen) | ZUORDNUNG (Konto-Split, Total
 * stimmt — nur Hinweis) | UNKLAR (App > FIBU, prüfen). Zuordnungs-Fälle
 * werden pro Lieferant nur EINMAL gelistet. Ohne Journal: leere Liste.
 */
export function buildKorrekturVorschlaege(input: {
  entries: InvoiceEntry[];
  journal: SageJournalEntry[] | null;
  supplierNames: string[];
  aliases: SupplierAliasMap;
  aliasGruppen?: AliasGruppe[];
  kontoNamen?: Record<string, string>;
}): KorrekturVorschlag[] {
  const lbl = (k: string) => {
    const name = input.kontoNamen?.[k];
    return name && name !== k ? `${k} ${name.replace(/^\d{4}\s*/, '')}` : k;
  };
  const out: KorrekturVorschlag[] = [];
  const zuordnungGesehen = new Set<string>();
  for (const konto of DIREKTE_WARENKONTEN) {
    const d = buildKontoDrilldown({ ...input, konto });
    if (!d.hatJournal) return [];
    for (const z of d.zeilen) {
      if (z.typ === 'kontierung' && z.kontierungsHinweis) {
        const h = z.kontierungsHinweis;
        out.push({
          typ: 'kontierung', lieferant: z.lieferant, konto, betrag: h.betrag,
          text: `Umbuchung ${z.lieferant}: CHF ${fmtChfText(h.betrag)} von ${lbl(h.vonKonto)} -> ${lbl(h.nachKonto)}`,
        });
      } else if (z.typ === 'fehlende_rechnung' && z.diff !== null) {
        out.push({
          typ: 'fehlende_rechnung', lieferant: z.lieferant, konto, betrag: z.diff,
          text: `Fehlende Rechnung ${z.lieferant}: CHF ${fmtChfText(z.diff)} auf ${lbl(konto)} — Beleg in der App nachtragen`,
        });
      } else if (z.typ === 'zuordnung') {
        if (zuordnungGesehen.has(z.lieferant)) continue;
        zuordnungGesehen.add(z.lieferant);
        out.push({
          typ: 'zuordnung', lieferant: z.lieferant, konto, betrag: 0,
          text: `Zuordnung ${z.lieferant}: Kontenverteilung weicht ab, Total im direkten Warenaufwand stimmt — keine Korrektur nötig`,
        });
      } else if (z.typ === 'unklar' && z.diff !== null) {
        out.push({
          typ: 'unklar', lieferant: z.lieferant, konto, betrag: z.diff,
          text: `Prüfen ${z.lieferant}: CHF ${fmtChfText(Math.abs(z.diff))} auf ${lbl(konto)} in der App erfasst, in der FIBU (noch) nicht gebucht — periodenfremd?`,
        });
      }
    }
  }
  // Sortierung: Kontierung zuerst, dann fehlende Rechnungen, dann Rest; je Betrag absteigend.
  const rang: Record<KorrekturVorschlag['typ'], number> = { kontierung: 0, fehlende_rechnung: 1, unklar: 2, zuordnung: 3 };
  return out.sort((a, b) => rang[a.typ] - rang[b.typ] || Math.abs(b.betrag) - Math.abs(a.betrag));
}
