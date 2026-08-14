/**
 * zeitraum — gemeinsame Zeitraum-/Granularitäts-Logik (Woche/Monat/Quartal/Jahr)
 * ===========================================================================
 * Single Source für die einheitliche Perioden-Steuerung (FIBU-Abgleich-Muster):
 * ISO-Wochen (Mo–So, über Monatsgrenzen), Labels, Blättern (< >), Zukunfts-
 * Sperre und Granularitäts-Wechsel. Pure Logik — UI in
 * `src/components/ZeitraumSteuerung.tsx`.
 */

export type Granularitaet = 'woche' | 'monat' | 'quartal' | 'jahr';

export interface Zeitraum {
  granular: Granularitaet;
  /** Anzeige-Jahr (bei Woche: Kalenderjahr des Montags). */
  year: number;
  /** 1–12 (bei Woche: Monat des Montags — Daten-Ladeanker). */
  month: number;
  /** 1–4, nur bei granular === 'quartal' relevant. */
  quartal: number;
  /** ISO-Montag YYYY-MM-DD, nur bei granular === 'woche' relevant. */
  wochenStart: string;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export function ymdLocal(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ── ISO-Kalenderwoche (Mo–So) ───────────────────────────────────────────────

export function getIsoWeek(dateStr: string): { week: number; isoYear: number; weekLabel: string } {
  const d = new Date(dateStr + 'T12:00:00');
  const tmp = new Date(d);
  tmp.setHours(0, 0, 0, 0);
  tmp.setDate(tmp.getDate() + 3 - ((tmp.getDay() + 6) % 7));
  const jan4 = new Date(tmp.getFullYear(), 0, 4);
  const week = 1 + Math.round(((tmp.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  return { week, isoYear: tmp.getFullYear(), weekLabel: `KW ${pad2(week)}` };
}

/** Montag und Sonntag einer ISO-Woche als lokale Datumsstrings. */
export function isoWeekRange(isoYear: number, week: number): { from: string; to: string } {
  const jan4 = new Date(isoYear, 0, 4);
  const dayOfWeek = (jan4.getDay() + 6) % 7; // 0 = Mo
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - dayOfWeek + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { from: ymdLocal(monday), to: ymdLocal(sunday) };
}

export function wochenEndeVon(wochenStart: string): string {
  const d = new Date(wochenStart + 'T12:00:00');
  d.setDate(d.getDate() + 6);
  return ymdLocal(d);
}

/** Alle ISO-Wochen eines Jahres (fürs Perioden-Dropdown). */
export function wochenDesJahres(jahr: number): Array<{ week: number; from: string; to: string }> {
  const max = getIsoWeek(`${jahr}-12-28`).week;
  return Array.from({ length: max }, (_, i) => {
    const r = isoWeekRange(jahr, i + 1);
    return { week: i + 1, from: r.from, to: r.to };
  });
}

// ── Zeitraum-Grenzen / Labels ───────────────────────────────────────────────

export function quartalMonate(quartal: number): [number, number, number] {
  const start = (quartal - 1) * 3 + 1;
  return [start, start + 1, start + 2];
}

/** Erster/letzter Tag des Zeitraums (inklusive) als YYYY-MM-DD. */
export function zeitraumGrenzen(z: Zeitraum): { from: string; to: string } {
  if (z.granular === 'woche') return { from: z.wochenStart, to: wochenEndeVon(z.wochenStart) };
  if (z.granular === 'jahr') return { from: `${z.year}-01-01`, to: `${z.year}-12-31` };
  if (z.granular === 'quartal') {
    const [m1, , m3] = quartalMonate(z.quartal);
    const last = new Date(z.year, m3, 0).getDate();
    return { from: `${z.year}-${pad2(m1)}-01`, to: `${z.year}-${pad2(m3)}-${pad2(last)}` };
  }
  const last = new Date(z.year, z.month, 0).getDate();
  return { from: `${z.year}-${pad2(z.month)}-01`, to: `${z.year}-${pad2(z.month)}-${pad2(last)}` };
}

const fmtKurzDatum = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.`;

export function zeitraumLabel(z: Zeitraum): string {
  if (z.granular === 'woche') {
    const ende = wochenEndeVon(z.wochenStart);
    return `KW ${pad2(getIsoWeek(z.wochenStart).week)} · ${fmtKurzDatum(z.wochenStart)}–${fmtKurzDatum(ende)}${ende.slice(0, 4)}`;
  }
  if (z.granular === 'jahr') return `Jahr ${z.year}`;
  if (z.granular === 'quartal') return `Q${z.quartal} ${z.year}`;
  return new Date(z.year, z.month - 1, 1).toLocaleDateString('de-CH', { month: 'long', year: 'numeric' });
}

// ── Navigation (< / >) ──────────────────────────────────────────────────────

/** Zeitraum um ±1 Periode verschieben (Woche ±7 Tage, sonst ±1 Einheit). */
export function shiftZeitraum(z: Zeitraum, richtung: 1 | -1): Zeitraum {
  if (z.granular === 'woche') {
    const d = new Date(z.wochenStart + 'T12:00:00');
    d.setDate(d.getDate() + 7 * richtung);
    return mitWochenStart(z, ymdLocal(d));
  }
  if (z.granular === 'jahr') return { ...z, year: z.year + richtung };
  if (z.granular === 'quartal') {
    let q = z.quartal + richtung; let y = z.year;
    if (q < 1) { q = 4; y -= 1; } else if (q > 4) { q = 1; y += 1; }
    return { ...z, quartal: q, year: y, month: quartalMonate(q)[0] };
  }
  let m = z.month + richtung; let y = z.year;
  if (m < 1) { m = 12; y -= 1; } else if (m > 12) { m = 1; y += 1; }
  return { ...z, month: m, year: y };
}

/** Woche setzen: year/month folgen dem Montag (Daten-Ladeanker). */
export function mitWochenStart(z: Zeitraum, wochenStart: string): Zeitraum {
  return {
    ...z, wochenStart,
    year: Number(wochenStart.slice(0, 4)),
    month: Number(wochenStart.slice(5, 7)),
  };
}

/** «Vor»-Pfeil gesperrt? (aktuelle/zukünftige Periode — wie FIBU-Abgleich) */
export function nextGesperrt(z: Zeitraum, todayStr: string): boolean {
  const tY = Number(todayStr.slice(0, 4));
  if (z.granular === 'jahr') return z.year >= tY;
  if (z.granular === 'woche') {
    const ende = wochenEndeVon(z.wochenStart);
    return (todayStr >= z.wochenStart && todayStr <= ende) || z.wochenStart > todayStr;
  }
  if (z.granular === 'quartal') {
    const tQ = Math.floor((Number(todayStr.slice(5, 7)) - 1) / 3) + 1;
    return z.year > tY || (z.year === tY && z.quartal >= tQ);
  }
  const tM = Number(todayStr.slice(5, 7));
  return z.year > tY || (z.year === tY && z.month >= tM);
}

/**
 * Granularität wechseln (FIBU-Muster): Woche startet in der Woche von heute
 * (falls aktueller Monat gewählt) bzw. in der Woche des Monatsersten; Monat/
 * Quartal/Jahr behalten das Jahr, Quartal folgt dem gewählten Monat.
 */
export function wechsleGranularitaet(z: Zeitraum, g: Granularitaet, todayStr: string): Zeitraum {
  if (g === 'woche') {
    const istAktuellerMonat = z.year === Number(todayStr.slice(0, 4)) && z.month === Number(todayStr.slice(5, 7));
    const ref = istAktuellerMonat ? todayStr : `${z.year}-${pad2(z.month)}-01`;
    const w = getIsoWeek(ref);
    return mitWochenStart({ ...z, granular: g }, isoWeekRange(w.isoYear, w.week).from);
  }
  if (g === 'quartal') return { ...z, granular: g, quartal: Math.floor((z.month - 1) / 3) + 1 };
  return { ...z, granular: g };
}

/** Standard-Startwert: aktueller Monat (bzw. Woche von heute). */
export function initialZeitraum(granular: Granularitaet = 'monat', now: Date = new Date()): Zeitraum {
  const todayStr = ymdLocal(now);
  const basis: Zeitraum = {
    granular: 'monat', year: now.getFullYear(), month: now.getMonth() + 1,
    quartal: Math.floor(now.getMonth() / 3) + 1,
    wochenStart: isoWeekRange(getIsoWeek(todayStr).isoYear, getIsoWeek(todayStr).week).from,
  };
  return granular === 'monat' ? basis : wechsleGranularitaet(basis, granular, todayStr);
}
