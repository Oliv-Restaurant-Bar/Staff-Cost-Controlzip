/**
 * cockpit-kpi-boxen.ts
 * ====================
 * Gemeinsame, PURE Datenaufbereitung der 5 grossen Cockpit-KPI-Boxen
 * (Netto-Umsatz · WKQ · PKQ · Produktivität · Gäste IN) — verwendet vom
 * Vektor-PDF (cockpit-monat-seite) UND der On-Screen-Monatsübersicht.
 *
 * WICHTIG: Reines Mapping auf bereits geladene Monatsreport-Zeilen (MrRow).
 * Es wird NICHTS neu berechnet — Spalte 'month' liest die Monats-Felder,
 * Spalte 'week' die Wochen-Felder derselben Zeilen (Ist der Woche vs.
 * Budget-Wochenanteil, identisch zur Wochenübersicht). «Leer statt 0»:
 * fehlt die Quelle, bleibt wert=null (Anzeige «–», keine Ampel, kein Δ).
 */

import type { MrRow } from '@/lib/monatsreport';

export type KpiSpalte = 'month' | 'week';

export interface CockpitKpiBoxDaten {
  id: 'netto_umsatz' | 'wkq' | 'pkq' | 'produktivitaet' | 'gaeste_in';
  /** Basis-Label ohne Δ-Zusatz (z.B. «WKQ (Ziel max. 24 %)»). */
  label: string;
  /** Formatierter Hauptwert; null = keine Datenquelle («leer statt 0»). */
  wert: string | null;
  /** Ampel (nur WKQ/PKQ): true = im Ziel (grün), false = über Ziel (rot). */
  ampelGut?: boolean;
  /** Δ % vs. Budget derselben Periode (nur Netto/Produktivität/Gäste). */
  delta?: { text: string; positiv: boolean } | null;
}

const fmtNum = (v: number, dec = 2) =>
  v.toLocaleString('de-CH', { minimumFractionDigits: dec, maximumFractionDigits: dec });

/** Δ% Ist vs. Budget (gleiche Regel wie ReportTable/kpiKarten): nur wenn
 *  beide vorhanden und Budget > 0 — sonst null («leer statt 0»). */
function deltaPct(ist: number | null, budget: number | null): CockpitKpiBoxDaten['delta'] {
  if (ist === null || budget === null || budget <= 0) return null;
  const dev = ((ist - budget) / budget) * 100;
  return { text: `${dev >= 0 ? '+' : ''}${dev.toFixed(1)} %`, positiv: dev >= 0 };
}

/**
 * Die 5 KPI-Boxen für eine Spalte (Monat oder Woche) aus den Report-Zeilen.
 * Liefert IMMER 5 Boxen in fester Reihenfolge (fehlende Quelle ⇒ wert=null),
 * damit Monats- und Wochen-Reihe deckungsgleich untereinander stehen.
 */
export function kpiBoxenDaten(rows: MrRow[], spalte: KpiSpalte): CockpitKpiBoxDaten[] {
  const byId = new Map<string, MrRow>();
  for (const r of rows) if (r.type === 'data' && r.id) byId.set(r.id, r);
  const ist = (r: MrRow | undefined): number | null =>
    (spalte === 'month' ? r?.month : r?.week) ?? null;
  const budget = (r: MrRow | undefined): number | null =>
    (spalte === 'month' ? r?.monthBudget : r?.weekBudget) ?? null;

  const netto = byId.get('netto_umsatz');
  const nettoIst = ist(netto);
  const waren = byId.get('warenkosten_total');
  const wkq = (spalte === 'month' ? waren?.wkqInline?.month : waren?.wkqInline?.week) ?? null;
  const pkqRow = byId.get('personalquote');
  const pkqIst = ist(pkqRow);
  const pkqGrenze = pkqRow?.warnAbove ?? null;
  const prod = byId.get('produktivitaet');
  const prodIst = ist(prod);
  const gaeste = byId.get('gaeste_in');
  const gaesteIst = ist(gaeste);

  return [
    {
      id: 'netto_umsatz',
      label: 'Netto-Umsatz',
      wert: nettoIst !== null ? `CHF ${fmtNum(nettoIst)}` : null,
      delta: nettoIst !== null ? deltaPct(nettoIst, budget(netto)) : null,
    },
    {
      id: 'wkq',
      label: wkq?.ziel != null ? `WKQ (Ziel max. ${wkq.ziel.toFixed(0)} %)` : 'WKQ',
      wert: wkq?.pct != null ? `${wkq.pct.toFixed(1)} %` : null,
      ampelGut: wkq?.pct != null && wkq.ziel != null ? wkq.pct <= wkq.ziel : undefined,
    },
    {
      id: 'pkq',
      label: pkqGrenze != null ? `PKQ (max. ${pkqGrenze.toFixed(0)} %)` : 'Personalquote',
      wert: pkqIst !== null ? `${pkqIst.toFixed(1)} %` : null,
      ampelGut: pkqIst !== null && pkqGrenze != null ? pkqIst <= pkqGrenze : undefined,
    },
    {
      id: 'produktivitaet',
      label: 'Produktivität',
      wert: prodIst !== null ? fmtNum(prodIst) : null,
      delta: prodIst !== null ? deltaPct(prodIst, budget(prod)) : null,
    },
    {
      id: 'gaeste_in',
      label: 'Gäste IN',
      wert: gaesteIst !== null ? fmtNum(gaesteIst, 0) : null,
      delta: gaesteIst !== null ? deltaPct(gaesteIst, budget(gaeste)) : null,
    },
  ];
}
