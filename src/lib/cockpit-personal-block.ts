/**
 * cockpit-personal-block.ts — optionaler Personal-Block für den Cockpit-PDF-Export.
 * ==================================================================================
 * Zwei zusätzliche Seiten (je eigene Seite) für den GEWÄHLTEN Monat/Stichtag —
 * gleiches Report-Design wie der Waren-Block (Kopfband, KPI-Zeile, Zebra,
 * Chips/Ampel; Fusszeile zentral via zeichneFusszeilen):
 *
 *  A) Überstunden – Wochensaldo (letzte 4 Wochen) — IMMER die letzten 4
 *     Kalenderwochen bis zum Stichtag (rollierend). Je Fix-MA: Name · Pensum ·
 *     Wochen-Saldo je KW (Kopf mit KW + Datumsbereich) · Laufend; Total-Zeile
 *     je KW + Laufend. Saldi ROH aus der Lib (Rundung erst beim Formatieren),
 *     MA ohne Eintritt wie die Ansicht ausgeschlossen — Export = zahlengleich
 *     zur Überstunden-Seite. FARBLOGIK (Kosten): (+) = ROT · (−) = GRÜN.
 *     «Keine Zeiterfassung»-MA: «–» + Chip «ausgenommen – kein ÜStd-Konto»,
 *     NICHT im Total. Quelle: ueberstunden.ts (SSOT, leer statt 0).
 *
 *  B) Flex-Auswertung Plan vs. Ist — VERSCHACHTELT je Woche & Mitarbeiter
 *     (wie die Waren-Anomalie-Analyse): pro Woche eine fette Kopfzeile
 *     (Zeitraum · Plan Std · Ist Std · Flex Plan · Flex Ist · Diff. mit
 *     Diff-% und Status-Ampelpunkt), darunter je Mitarbeiter eine Zeile.
 *     NUR Wochen MIT hochgeladenem Mirus-Ist (offene Wochen weggelassen,
 *     nicht als 0); je MA nur bis zum abgerechneten Stand. KEINE AG/h-Spalte.
 *     Die MA-Zeilen einer Woche summieren exakt aufs Wochentotal (Totale =
 *     Summe der gerundeten MA-Werte). Quelle: flex-weekly-ssot.ts — identisch
 *     zur Live-Flex-Auswertung, inkl. externer Aushilfen und MIRUS-Stichtag.
 */
import type { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { TenantId } from '@/contexts/TenantContext';
import type { RestaurantBranding } from '@/lib/pl-branding';
import {
  bewertePeriode, ladeUeberstundenJahr, mondayOf, isoWeekOf, VOLLZEIT_WOCHE_H, UEBERSTUNDEN_START,
} from '@/lib/ueberstunden';
import { ladePersonalkostenDaten, type PersonalkostenDaten } from '@/lib/personalkosten';
import { loadSocialCostRates } from '@/lib/social-costs-db';
import { getEmployerCostRate } from '@/lib/employee-rate';
import { loadExtraCostPeople, extraCostPersonToEmployee } from '@/lib/extra-cost-people-db';
import { buildFlexWeeklyEvaluation } from '@/lib/flex-weekly-ssot';
import {
  M, INK2, MUTED, GRUEN_INK, AMBER_INK, ROT_INK, type Rgb,
  kopfband, folgeKopf, kpiZeileBoxen, abschnitt, tabellenStil,
  zeichneChip, zeichneAmpelPunktFarbe,
} from '@/lib/cockpit-block-stil';

// ─── Datenmodell ─────────────────────────────────────────────────────────────

export interface PbUeberstundenZeile {
  name: string;
  /** Pensum in % (weeklyHours ÷ 42). */
  pensumPct: number;
  /** Wochen-Saldo je angezeigter KW (Reihenfolge = kwLabels); null = leer.
   *  ROH (ungerundet) wie die Ansicht — Rundung erst bei der Formatierung. */
  saldi: Array<number | null>;
  /** Laufendes Konto (ab Juli 2026) bis zum Stichtag; null = leer. */
  laufend: number | null;
  /** «Keine Zeiterfassung erforderlich» → ausgenommen, nicht im Total. */
  ausgenommen: boolean;
  /** AG-Stundenkostensatz (CHF/h, Lohn-SSOT wie die Ansicht); null = Lohn fehlt
   *  → MA zählt nicht in die Kosten-Zeile (gleiches Prädikat wie ÜStd-Kosten). */
  satz: number | null;
}

/** Mitarbeiter-Detailzeile innerhalb einer abgerechneten Woche. */
export interface PbWocheMaZeile {
  name: string;
  /** true = ohne AG-Sozialkosten gerechnet (Flag pro Flex-MA). */
  agOff: boolean;
  planH: number;
  istH: number;    // nur hochgeladenes Ist (bis Stichtag)
  planChf: number;
  istChf: number;
  diffChf: number; // Ist − Plan
}

export interface PbWochenZeile {
  label: string;      // «KW 32»
  von: string;        // ISO (auf Monat geklemmt)
  bis: string;
  planH: number;
  istH: number;
  planChf: number;
  istChf: number;
  diffChf: number;    // Ist − Plan
  diffPct: number | null;
  /** MA-Zeilen; summieren exakt aufs Wochentotal. */
  mitarbeiter: PbWocheMaZeile[];
}

/** Optionen für den Überstunden-Teil (Export-Dialog: wählbares Wochenfenster). */
export interface PbUeberstundenOptionen {
  /** Anzahl abgeschlossener KWs vor der laufenden Woche (Standard 4); ignoriert, wenn kwBereich gesetzt. */
  abgeschlosseneWochen?: number;
  /** Freier KW-Bereich (von–bis, ISO-KWs des Stichtag-Wochenjahrs); nur abgeschlossene KWs. */
  kwBereich?: { von: number; bis: number } | null;
  /** Laufende Woche als eigene, letzte KW-Spalte anzeigen (Standard true). */
  mitLaufenderWoche?: boolean;
  /** Soll der laufenden Woche: false = anteilig bis Stichtag (Standard), true = volles Wochen-Soll. */
  laufendSollVoll?: boolean;
  /** ÜStd-Kosten (CHF) als zweite Total-Zeile zeigen (Standard false; wie
   *  «Kosten anzeigen» der Überstunden-Ansicht). */
  mitKosten?: boolean;
}

/** Max. KW-Spalten (A4 hoch bleibt lesbar). */
const MAX_KW_SPALTEN = 12;

export interface PersonalBlockDaten {
  monatLabel: string;
  /** Überstunden-Teil (letzte 4 KWs bis Stichtag). */
  kwLabels: string[];
  /** Datumsbereich je KW (Mo–So), Reihenfolge = kwLabels, z.B. «10.08.–16.08.». */
  kwBereiche: string[];
  /** Stichtag (ISO) der Überstunden-Rechnung. */
  stichtag: string;
  /** Soll-Modus der laufenden Woche (null = laufende Woche nicht im Fenster). */
  laufendSollModus: 'anteilig' | 'voll' | null;
  ueZeilen: PbUeberstundenZeile[];
  totalLaufend: number | null;
  /** ÜStd-Kosten-Total (CHF, SSOT wie die Ansicht: Σ max(0, laufend) × Satz);
   *  null = keine bewertbare Datenbasis ODER Kosten nicht angefordert. */
  totalUeKosten: number | null;
  /** true = Kosten-Zeile im Überstunden-Teil zeichnen. */
  ueMitKosten: boolean;
  /** Flex-Teil: nur Wochen MIT hochgeladenem Ist. */
  wochen: PbWochenZeile[];
  flexTotalPlanH: number;
  flexTotalIstH: number;
  flexTotalPlanChf: number;
  flexTotalIstChf: number;
  flexAgOffCount: number;
}

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli',
  'August', 'September', 'Oktober', 'November', 'Dezember'];

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const fmtChf = (n: number | null) =>
  n === null ? '–' : n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtH = (n: number | null) => (n === null ? '–' : `${r1(n).toFixed(1)} h`);
/** Saldo-Stunden mit Vorzeichen («leer statt 0» übernimmt der Aufrufer via null). */
const fmtSaldo = (n: number | null) =>
  n === null ? '–' : `${n > 0 ? '+' : ''}${r1(n).toFixed(1)}`;
const fmtDat = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;

function addTage(iso: string, tage: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + tage);
  return d.toISOString().slice(0, 10);
}

// ─── Datenladung ─────────────────────────────────────────────────────────────

/**
 * Lädt alle Personal-Block-Daten des gewählten Monats zum Stichtag `heuteIso`
 * (nur Tage ≤ Stichtag zählen als Ist; Zahlen 1:1 wie die Personal-Ansichten).
 */
export async function ladePersonalBlockDaten(
  tenantId: TenantId,
  tenantKey: (k: string) => string,
  year: number,
  month: number,
  heuteIso: string,
  ueOpts: PbUeberstundenOptionen = {},
): Promise<PersonalBlockDaten> {
  // ── A) Überstunden: wählbares KW-Fenster bis zum Stichtag ─────────────────
  const stichMonday = mondayOf(heuteIso);
  const mitLaufender = ueOpts.mitLaufenderWoche !== false;
  const sollVoll = ueOpts.laufendSollVoll === true;

  // Abgeschlossene Wochen: entweder freier KW-Bereich (ISO-KWs des Stichtag-
  // Wochenjahrs, nur Wochen VOR der laufenden) oder die letzten N Wochen.
  let abgeschlossen: string[];
  const bereich = ueOpts.kwBereich ?? null;
  if (bereich && bereich.von >= 1 && bereich.bis >= bereich.von) {
    const { kwYear } = isoWeekOf(stichMonday);
    const mon1 = mondayOf(`${kwYear}-01-04`);
    abgeschlossen = [];
    for (let kw = bereich.von; kw <= bereich.bis; kw++) {
      const mo = addTage(mon1, (kw - 1) * 7);
      if (mo < stichMonday) abgeschlossen.push(mo); // laufende KW nur via Schalter
    }
    abgeschlossen = abgeschlossen.slice(-MAX_KW_SPALTEN);
  } else {
    const n = Math.min(MAX_KW_SPALTEN, Math.max(1, Math.round(ueOpts.abgeschlosseneWochen ?? 4)));
    abgeschlossen = Array.from({ length: n }, (_, i) => addTage(stichMonday, (i - n) * 7));
  }
  const mondays = mitLaufender ? [...abgeschlossen, stichMonday] : abgeschlossen;
  // Laufende (unvollständige) Woche als eigene, klar markierte letzte Spalte.
  const kwLabels = mondays.map(mo => {
    const { kw } = isoWeekOf(mo);
    return mo === stichMonday && mitLaufender
      ? `KW ${kw} laufend (${sollVoll ? 'volles Soll' : 'anteilig'})`
      : `KW ${kw}`;
  });
  const kwBereiche = mondays.map(mo => `${fmtDat(mo)}–${fmtDat(addTage(mo, 6))}`);

  // Jahres-Ergebnisse laden: ALLE Konto-Jahre seit UEBERSTUNDEN_START bis zum
  // Stichtag-Jahr (Laufend = kumuliertes Konto über alle Jahre, wie die
  // Überstunden-Totale-SSOT) — plus die Jahre der 4 KW-Spalten (Jahreswechsel).
  const jahreSet = new Set(mondays.map(mo => Number(mo.slice(0, 4))));
  const startJahr = Number(UEBERSTUNDEN_START.slice(0, 4));
  for (let j = startJahr; j <= Number(heuteIso.slice(0, 4)); j++) jahreSet.add(j);
  // Aufsteigend sortieren: «Satz des jüngsten Jahres gilt» braucht eine
  // definierte Verarbeitungsreihenfolge (wie die Perioden-/Total-SSOT).
  const jahre = [...jahreSet].sort((a, b) => a - b);
  const jahresDaten = await Promise.all(
    jahre.map(j => ladeUeberstundenJahr(tenantId, tenantKey, j, heuteIso)),
  );
  type UeErg = NonNullable<Awaited<ReturnType<typeof ladeUeberstundenJahr>>>['ergebnis'];
  const ergebnisse: UeErg[] = [];
  for (const jd of jahresDaten) if (jd) ergebnisse.push(jd.ergebnis);

  // Pro MA (id-basiert über Jahre gemerged): Saldi je KW.
  const ueZeilen: PbUeberstundenZeile[] = [];
  type UeIntern = PbUeberstundenZeile & {
    _laufendJeJahr: Array<number | null>;
    /** Anteiliges Soll der laufenden Woche (über Jahresgrenzen summiert). */
    _laufendSoll: number | null;
    _wochenSollH: number;
  };
  const proId = new Map<string, UeIntern>();
  for (const erg of ergebnisse) {
    for (const ma of erg.mitarbeiter) {
      // Wie die Ansicht: MA ohne Eintrittsdatum werden nicht gerechnet und
      // erscheinen nicht in der Matrix (dort nur Hinweis-Liste).
      if (ma.ohneEintritt) continue;
      let z = proId.get(ma.id);
      if (!z) {
        z = {
          name: ma.name,
          pensumPct: Math.round((ma.wochenSollH / VOLLZEIT_WOCHE_H) * 100),
          saldi: mondays.map(() => null),
          laufend: null,
          ausgenommen: ma.ausgenommen,
          satz: ma.stundensatz,
          _laufendJeJahr: [],
          _laufendSoll: null,
          _wochenSollH: ma.wochenSollH,
        };
        proId.set(ma.id, z);
      }
      z.ausgenommen = z.ausgenommen || ma.ausgenommen;
      // Satz des JÜNGSTEN Jahres mit Datenbasis gilt (Jahre sind aufsteigend
      // sortiert) — wie die Perioden-/Total-SSOT bei Dez/Jan-Lohnwechseln.
      z.satz = ma.stundensatz ?? z.satz;
      z._laufendJeJahr.push(ma.laufend);
      for (const w of ma.wochen) {
        const idx = mondays.indexOf(w.monday);
        // ROH übernehmen (keine Zeilen-Rundung) — die KW-Totale summieren wie
        // die Ansicht die ungerundeten Saldi und runden erst am Schluss.
        if (idx < 0 || w.saldo === null) continue;
        // ADDITIV mergen: eine Dez/Jan-Woche liegt in BEIDEN Jahres-Ergebnissen
        // (je Kalenderjahr-Anteil) — überschreiben würde den Dez-Anteil verlieren.
        z.saldi[idx] = (z.saldi[idx] ?? 0) + w.saldo;
        if (w.monday === stichMonday && w.soll !== null) {
          z._laufendSoll = (z._laufendSoll ?? 0) + w.soll;
        }
      }
    }
  }
  // Total NICHT aus gerundeten Zeilen summieren — SSOT-Totale der Lib nutzen
  // (identisch zur Überstunden-Seite; Ausgenommene sind dort bereits draussen).
  let totalLaufend: number | null = null;
  for (const erg of ergebnisse) {
    if (erg.totalLaufend !== null) totalLaufend = (totalLaufend ?? 0) + erg.totalLaufend;
  }
  if (totalLaufend !== null) totalLaufend = r1(totalLaufend);
  // ÜStd-Kosten-Total (KONTO über Jahre, wie ladeUeberstundenTotals): erst je
  // MA alle Jahres-Laufend-Salden konsolidieren (negatives Altjahr verrechnet
  // sich mit positivem Folgejahr), Satz des jüngsten Jahres, DANN einmal
  // max(0, Saldo) × Satz bewerten — NIE Jahres-Kosten aufsummieren.
  const kontoProMa = new Map<string, { saldo: number | null; satz: number | null }>();
  for (const erg of ergebnisse) {
    for (const ma of erg.mitarbeiter) {
      if (ma.laufend === null) continue;
      const cur = kontoProMa.get(ma.id) ?? { saldo: null, satz: null };
      cur.saldo = (cur.saldo ?? 0) + ma.laufend;
      if (ma.stundensatz !== null) cur.satz = ma.stundensatz;
      kontoProMa.set(ma.id, cur);
    }
  }
  const totalUeKosten = bewertePeriode([...kontoProMa.values()]).kosten;
  const laufendIdx = mitLaufender ? mondays.indexOf(stichMonday) : -1;
  for (const z of proId.values()) {
    const werte = z._laufendJeJahr.filter((v): v is number => v !== null);
    z.laufend = z.ausgenommen ? null : werte.length > 0 ? r1(werte.reduce((s, v) => s + v, 0)) : null;
    // «Volles Wochen-Soll» für die laufende Woche: anteiliges Soll durch das
    // volle Pensum-Soll ersetzen (Saldo' = Saldo + anteiliges Soll − Pensum-
    // Soll). Gutschriften stecken bereits in Ist/Saldo der Lib — nie doppelt.
    // Nur wenn Datenbasis vorhanden (Saldo ≠ null); «–» bleibt «–».
    if (sollVoll && laufendIdx >= 0 && z.saldi[laufendIdx] !== null) {
      z.saldi[laufendIdx] = z.saldi[laufendIdx]! + (z._laufendSoll ?? 0) - z._wochenSollH;
    }
    const { _laufendJeJahr: _d1, _laufendSoll: _d2, _wochenSollH: _d3, ...zeile } = z;
    ueZeilen.push(zeile);
  }
  ueZeilen.sort((a, b) => a.name.localeCompare(b.name, 'de'));

  // ── B) Flex je Woche & Mitarbeiter: Personalkosten-SSOT ───────────────────
  const ratesBlob = await loadSocialCostRates(tenantId);
  const daten: PersonalkostenDaten = await ladePersonalkostenDaten(
    year, month, tenantId, tenantKey, ratesBlob.rates,
  );
  const extraEmployees = (await loadExtraCostPeople(tenantId)).map(extraCostPersonToEmployee);
  const existingIds = new Set(daten.flexEmployees.map(emp => String(emp.id)));
  const flexEmployees = [
    ...daten.flexEmployees,
    ...extraEmployees.filter(emp => !existingIds.has(String(emp.id))),
  ];
  const evaluation = buildFlexWeeklyEvaluation({
    year,
    month,
    keyFn: tenantKey,
    todayIso: heuteIso,
    employees: flexEmployees.map(emp => {
      const rate = getEmployerCostRate(emp, daten.rates);
      const id = String(emp.id);
      const isSplit = id.endsWith('::flexsplit');
      const baseId = isSplit ? id.slice(0, -'::flexsplit'.length) : id;
      const split = isSplit ? daten.wageSplits[baseId] : undefined;
      return {
        id,
        sourceId: isSplit ? baseId : id,
        name: isSplit ? `${emp.name} (Stundenlohn-Phase)` : (emp.name ?? String(emp.id)),
        wage: rate?.totalHourly ?? 0,
        agOff: rate?.agOff === true,
        activeFrom: split?.hourlyFrom,
        activeTo: split?.hourlyTo,
      };
    }),
  });

  const wochen: PbWochenZeile[] = [];
  const rohProWoche: Array<{ planH: number; istH: number }> = [];
  const agOffMitEinsatz = new Set<string>();
  for (const week of evaluation.weeks) {
    if (week.offen) continue;
    const maZeilen: PbWocheMaZeile[] = week.employees.map(row => {
      const planChf = r2(row.planCost);
      const istChf = r2(row.istCost);
      if (row.agOff) agOffMitEinsatz.add(row.id);
      return {
        name: row.name,
        agOff: row.agOff,
        planH: r1(row.planH),
        istH: r1(row.istH),
        planChf,
        istChf,
        diffChf: r2(istChf - planChf),
      };
    });
    const planHRoh = week.planH;
    const istHRoh = week.istH;
    for (const row of week.employees) {
      if (row.agOff) agOffMitEinsatz.add(row.id);
    }
    maZeilen.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    const planH = r1(planHRoh);
    const istH = r1(istHRoh);
    rohProWoche.push({ planH: planHRoh, istH: istHRoh });
    const planChf = r2(maZeilen.reduce((s, z) => s + z.planChf, 0));
    const istChf = r2(maZeilen.reduce((s, z) => s + z.istChf, 0));
    const diffChf = r2(istChf - planChf);
    wochen.push({
      label: week.label,
      von: week.von,
      bis: week.bis,
      planH,
      istH,
      planChf,
      istChf,
      diffChf,
      diffPct: planChf > 0 ? r1((diffChf / planChf) * 100) : null,
      mitarbeiter: maZeilen,
    });
  }

  return {
    monatLabel: `${MONATE[month - 1]} ${year}`,
    kwLabels, kwBereiche, stichtag: heuteIso,
    laufendSollModus: mitLaufender ? (sollVoll ? 'voll' : 'anteilig') : null,
    ueZeilen, totalLaufend,
    totalUeKosten: ueOpts.mitKosten === true ? totalUeKosten : null,
    ueMitKosten: ueOpts.mitKosten === true,
    wochen,
    flexTotalPlanH: r1(rohProWoche.reduce((s, w) => s + w.planH, 0)),
    flexTotalIstH: r1(rohProWoche.reduce((s, w) => s + w.istH, 0)),
    flexTotalPlanChf: r2(wochen.reduce((s, w) => s + w.planChf, 0)),
    flexTotalIstChf: r2(wochen.reduce((s, w) => s + w.istChf, 0)),
    flexAgOffCount: agOffMitEinsatz.size,
  };
}

// ─── PDF-Zeichnung ───────────────────────────────────────────────────────────

/** Status-Farbe Flex-Diff (Kosten): unter/im Plan = grün · bis 5 % darüber = amber · sonst rot. */
function flexStatusFarbe(diffPct: number | null, diffChf: number): Rgb {
  if (diffChf <= 0) return GRUEN_INK;
  if (diffPct !== null && diffPct <= 5) return AMBER_INK;
  return ROT_INK;
}

function kpiZeile(pdf: jsPDF, y: number, d: PersonalBlockDaten): number {
  const laufendFarbe: Rgb = (d.totalLaufend ?? 0) > 0 ? ROT_INK : GRUEN_INK;
  const flexDiff = r2(d.flexTotalIstChf - d.flexTotalPlanChf);
  return kpiZeileBoxen(pdf, y, [
    {
      label: 'Überstunden Total laufend',
      wert: d.totalLaufend === null ? '–' : `${fmtSaldo(d.totalLaufend)} h`,
      ampel: { dot: laufendFarbe, ink: laufendFarbe },
    },
    { label: 'Flex Plan (abger. Wochen)', wert: `CHF ${fmtChf(d.flexTotalPlanChf)}` },
    { label: 'Flex Ist (hochgeladen)', wert: `CHF ${fmtChf(d.flexTotalIstChf)}` },
    {
      label: 'Flex Diff Ist-Plan', wert: `CHF ${fmtChf(flexDiff)}`,
      ampel: (() => {
        const f = flexStatusFarbe(d.flexTotalPlanChf > 0 ? (flexDiff / d.flexTotalPlanChf) * 100 : null, flexDiff);
        return { dot: f, ink: f };
      })(),
    },
  ]);
}

/** Kleine graue Legende unterhalb der zuletzt gezeichneten Tabelle. */
function legende(pdf: jsPDF, text: string): void {
  const nachTabelle = (pdf as jsPDF & { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY;
  if (typeof nachTabelle !== 'number') return;
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7);
  pdf.setTextColor(...MUTED);
  pdf.text(text, M, Math.min(nachTabelle + 4, 285));
}

/** Fügt die beiden Personal-Seiten ans PDF an (gleiches Design wie Waren-Block). */
export function zeichnePersonalBlock(
  pdf: jsPDF, d: PersonalBlockDaten, branding: RestaurantBranding, heute: Date = new Date(),
): void {
  const rechts = { halign: 'right' as const };
  const stil = tabellenStil(branding);
  const accent = branding.accentColor;

  const mitFolgeKopf = (titel: string) => {
    let erste = true;
    return () => {
      if (!erste) folgeKopf(pdf, branding, titel);
      erste = false;
    };
  };

  // ── A) Überstunden – Wochensaldo (wählbares KW-Fenster) ──
  const ueTitel = 'Personal · Überstunden – Wochensaldo';
  pdf.addPage('a4', 'portrait');
  let y = kopfband(pdf, branding, ueTitel, d.monatLabel, heute);
  y = kpiZeile(pdf, y, d);
  const stichtagTxt = `${d.stichtag.slice(8, 10)}.${d.stichtag.slice(5, 7)}.${d.stichtag.slice(0, 4)}`;
  // Fenster-Titel: bei vielen Spalten kompakt «KW x – KW y», sonst alle KWs.
  const fensterTitel = d.kwLabels.length > 6
    ? `Kalenderwochen ${d.kwLabels[0]} – ${d.kwLabels[d.kwLabels.length - 1]}`
    : `Kalenderwochen (${d.kwLabels.join(' · ')})`;
  const sollModusTxt = d.laufendSollModus === null
    ? 'ohne laufende Woche'
    : d.laufendSollModus === 'voll'
      ? 'laufende Woche (unvollständig): volles Wochen-Soll'
      : 'laufende Woche (unvollständig): Soll anteilig bis Stichtag';
  y = abschnitt(pdf, y, accent, fensterTitel,
    `Stichtag ${stichtagTxt} · Saldo = Ist − Soll (Pensum × ${VOLLZEIT_WOCHE_H} h/Woche) · ${sollModusTxt} · leer statt 0`);
  const ausgenommenChip = 'ausgenommen – kein ÜStd-Konto';
  // Total-Zeile: Spaltensumme je KW über alle NICHT ausgenommenen MA
  // (Summe der angezeigten Wochen-Saldi; keine Werte = leer, nie 0).
  const kwTotals = d.kwLabels.map((_, i) => {
    const werte = d.ueZeilen
      .filter(z => !z.ausgenommen)
      .map(z => z.saldi[i])
      .filter((v): v is number => v !== null);
    return werte.length > 0 ? r1(werte.reduce((s, v) => s + v, 0)) : null;
  });
  const totalStil = { fontStyle: 'bold' as const, ...rechts };
  // Kosten-Zeile (optional, wie «Kosten anzeigen» der Ansicht): je KW-Spalte
  // dieselbe SSOT wie die ÜStd-Kosten (bewertePeriode: Σ max(0, Saldo) × Satz
  // je MA; Minus-Salden erzeugen keine Kosten; leer statt 0).
  const kwKosten = d.ueMitKosten
    ? d.kwLabels.map((_, i) => bewertePeriode(
        d.ueZeilen.filter(z => !z.ausgenommen).map(z => ({ saldo: z.saldi[i], satz: z.satz })),
      ).kosten)
    : [];
  const chfStil = { ...rechts, textColor: INK2 };
  const ueBody = [
    ...d.ueZeilen.map(z => [
      z.name,
      `${z.pensumPct} %`,
      ...(z.ausgenommen ? d.kwLabels.map(() => '–') : z.saldi.map(fmtSaldo)),
      z.ausgenommen ? ausgenommenChip : fmtSaldo(z.laufend),
    ]),
    [{ content: 'Total', styles: { fontStyle: 'bold' as const } }, '',
      ...kwTotals.map(t => ({ content: fmtSaldo(t), styles: totalStil })),
      { content: d.totalLaufend === null ? '–' : `${fmtSaldo(d.totalLaufend)} h`, styles: totalStil }],
    ...(d.ueMitKosten ? [[
      { content: 'Total CHF', styles: { textColor: INK2 } }, '',
      ...kwKosten.map(k => ({ content: fmtChf(k), styles: chfStil })),
      { content: fmtChf(d.totalUeKosten), styles: chfStil },
    ]] : []),
  ];
  const laufendCol = 2 + d.kwLabels.length;
  // Laufende KW-Spalte optisch dezent abheben (heller Grundton).
  const laufendKwCol = d.kwLabels.findIndex(l => l.includes('laufend'));
  autoTable(pdf, {
    ...stil,
    startY: y,
    head: [['Mitarbeiter', 'Pensum',
      ...d.kwLabels.map((l, i) => `${l}\n${d.kwBereiche[i]}`), 'Laufend']],
    body: ueBody as Parameters<typeof autoTable>[1]['body'],
    columnStyles: Object.fromEntries(
      Array.from({ length: laufendCol }, (_, i) => [i + 1, rechts]),
    ),
    didParseCell: data => {
      if (data.section === 'body' && data.column.index === laufendCol
          && data.cell.raw === ausgenommenChip) {
        data.cell.text = [''];
      }
      // Platz für den rechtsbündigen Chip: «–» der letzten KW-Spalte ausblenden
      if (data.section === 'body' && data.column.index === laufendCol - 1
          && data.row.raw && (data.row.raw as unknown[])[laufendCol] === ausgenommenChip) {
        data.cell.text = [''];
      }
      // Kosten-Farblogik: Überstunden (+) rot, Minusstunden (−) grün (nie Pensum).
      if (data.section === 'body' && data.column.index >= 2) {
        const t = typeof data.cell.raw === 'string' ? data.cell.raw
          : typeof (data.cell.raw as { content?: unknown })?.content === 'string'
            ? (data.cell.raw as { content: string }).content : '';
        if (t.startsWith('+')) data.cell.styles.textColor = ROT_INK;
        else if (t.startsWith('-') || t.startsWith('−')) data.cell.styles.textColor = GRUEN_INK;
      }
      // Laufende KW dezent abheben (heller Grundton, Farblogik unverändert).
      if (data.section === 'body' && laufendKwCol >= 0 && data.column.index === 2 + laufendKwCol) {
        data.cell.styles.fillColor = [246, 246, 248];
      }
    },
    didDrawCell: data => {
      if (data.section === 'body' && data.column.index === laufendCol
          && data.cell.raw === ausgenommenChip) {
        zeichneChip(pdf, data.cell, ausgenommenChip, 'grau', 'rechts');
      }
    },
    didDrawPage: mitFolgeKopf(ueTitel),
  });
  legende(pdf, 'Farblogik (Kosten): Überstunden (+) = rot · Minusstunden (-) = grün · 0/leer neutral');

  // ── B) Flex-Auswertung Plan vs. Ist je Woche & Mitarbeiter ──
  pdf.addPage('a4', 'portrait');
  y = kopfband(pdf, branding, 'Personal · Flex-Auswertung Plan vs. Ist', d.monatLabel, heute);
  y = kpiZeile(pdf, y, d);
  y = abschnitt(pdf, y, accent, 'Flex je Woche & Mitarbeiter — nur abgerechnete Wochen',
    'offene Wochen ohne hochgeladenes Ist werden weggelassen');
  const diffFarbe = (diff: number): Rgb => (diff < 0 ? GRUEN_INK : diff > 0 ? ROT_INK : INK2);
  const wBody: Parameters<typeof autoTable>[1]['body'] = [];
  const wochenKopfZeilen = new Map<number, Rgb>();
  let agOffSichtbar = false;
  for (const w of d.wochen) {
    const farbe = flexStatusFarbe(w.diffPct, w.diffChf);
    wochenKopfZeilen.set(wBody.length, farbe);
    const b = { fontStyle: 'bold' as const };
    wBody.push([
      { content: `${w.label}  (${fmtDat(w.von)}–${fmtDat(w.bis)})`, styles: b },
      { content: fmtH(w.planH), styles: { ...b, ...rechts } },
      { content: fmtH(w.istH), styles: { ...b, ...rechts } },
      { content: fmtChf(w.planChf), styles: { ...b, ...rechts } },
      { content: fmtChf(w.istChf), styles: { ...b, ...rechts } },
      {
        content: `${fmtChf(w.diffChf)}${w.diffPct === null ? '' : `  (${w.diffPct > 0 ? '+' : ''}${w.diffPct.toFixed(1)} %)`}`,
        styles: { ...b, ...rechts, textColor: farbe },
      },
    ]);
    for (const z of w.mitarbeiter) {
      if (z.agOff) agOffSichtbar = true;
      wBody.push([
        `   ${z.agOff ? `${z.name} *` : z.name}`,
        fmtH(z.planH), z.istH > 0 ? fmtH(z.istH) : '–',
        z.planChf > 0 ? fmtChf(z.planChf) : '–',
        z.istChf > 0 ? fmtChf(z.istChf) : '–',
        { content: fmtChf(z.diffChf), styles: { ...rechts, textColor: diffFarbe(z.diffChf) } },
      ]);
    }
  }
  if (d.wochen.length > 0) {
    const totalDiff = r2(d.flexTotalIstChf - d.flexTotalPlanChf);
    wBody.push([
      { content: 'Total (abgerechnete Wochen)', styles: { fontStyle: 'bold' as const } },
      { content: fmtH(d.flexTotalPlanH), styles: { fontStyle: 'bold' as const, ...rechts } },
      { content: fmtH(d.flexTotalIstH), styles: { fontStyle: 'bold' as const, ...rechts } },
      { content: fmtChf(d.flexTotalPlanChf), styles: { fontStyle: 'bold' as const, ...rechts } },
      { content: fmtChf(d.flexTotalIstChf), styles: { fontStyle: 'bold' as const, ...rechts } },
      { content: fmtChf(totalDiff), styles: { fontStyle: 'bold' as const, ...rechts, textColor: diffFarbe(totalDiff) } },
    ]);
  }
  autoTable(pdf, {
    ...stil,
    styles: { ...stil.styles, fontSize: 7.6, cellPadding: { top: 1.5, bottom: 1.5, left: 2.2, right: 2.2 } },
    startY: y,
    head: [['Woche / Mitarbeiter', 'Plan Std', 'Ist Std', 'Flex Plan', 'Flex Ist', 'Diff.']],
    body: wBody,
    columnStyles: { 1: rechts, 2: rechts, 3: rechts, 4: rechts, 5: rechts },
    didDrawCell: data => {
      if (data.section === 'body' && data.column.index === 5 && wochenKopfZeilen.has(data.row.index)) {
        zeichneAmpelPunktFarbe(pdf, data.cell, wochenKopfZeilen.get(data.row.index)!);
      }
    },
    didDrawPage: mitFolgeKopf('Personal · Flex-Auswertung Plan vs. Ist'),
  });
  if (d.wochen.length === 0) {
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5);
    pdf.setTextColor(...INK2);
    pdf.text('Noch keine Woche mit hochgeladenen Ist-Stunden in diesem Monat.', M, y + 6);
  } else {
    legende(pdf, 'Diff = Ist - Plan: unter Plan (Ersparnis) = grün · über Plan = rot'
      + ' · Plan = ganze Woche (Dienstplan), Ist = nur hochgeladene Ist-Stunden'
      + (agOffSichtbar ? ' · * = ohne AG-Sozialkosten gerechnet' : ''));
  }
}
