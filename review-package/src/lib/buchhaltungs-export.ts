/**
 * Buchhaltungs-Export-Assistent (/tagesabschluesse) — REINE Logik
 * =============================================================================
 * Checkliste der Export-Voraussetzungen (§2), Monatsprüfung-Totale (§3),
 * Buchungsvorschau (§4), Export-Historie/-Protokoll mit Versionierung (§7/§8),
 * „Export veraltet"-Erkennung (§10) und Statusableitung für die
 * Import-Cockpit-Kontrollaufgabe (§11).
 *
 * Persistenz: KEINE Migration — Protokolle leben als write-once-Records im
 * bestehenden Blob `tagesabschluss_v1` (`exportProtokolle`, merge-on-save =
 * Union je Export-ID, s. mergeTagesabschlussBlobs).
 *
 * VERALTET-ERKENNUNG: deterministischer FNV-1a-Fingerprint über den
 * monatsbezogenen Datenstand (updatedAt-Stände aller Monats-Einträge) —
 * bewusst KEIN Zeitvergleich (`exportedAt < jüngste Mutation`), weil der
 * bei Clock-Skew zwischen Geräten UND bei merge-on-save-Nachzüglern
 * (ein später gemergter Eintrag kann ein ÄLTERES updatedAt tragen) versagt.
 * exportSettings fliessen NICHT in den Monats-Fingerprint ein; Regeländerungen
 * werden stattdessen über einen SEPARATEN Inhalts-Fingerprint der export-
 * relevanten Buchungsregeln erkannt (`computeSettingsFingerprint` +
 * `BuchhaltungsExportRecord.settingsFingerprint`; Alt-Records ohne das Feld
 * kippen NICHT rückwirkend auf „veraltet").
 */

import {
  type TagesabschlussBlob,
  type TagesabschlussMonth,
  type TagesabschlussExportSettings,
  type BuchhaltungsExportRecord,
  DEFAULT_KONTO_BEZEICHNUNGEN,
  defaultExportSettings,
  isMonthClosed,
} from './tagesabschluss';
import { type Tabelle2Row, type Tabelle2Kategorie } from './tagesabschluss-export';

const round2 = (v: number): number => Math.round(v * 100) / 100;

// ── Fingerprint (Veraltet-Erkennung, §10) ────────────────────────────────────

/** FNV-1a 32-Bit als 8-stelliger Hex-String. */
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Datumsteil (yyyy-MM-dd) eines `date:field`-Schlüssels. */
const keyDate = (key: string): string => key.slice(0, 10);

/**
 * Deterministischer Fingerprint des monatsbezogenen Blob-Datenstands.
 * Einbezogen: Tageswerte, Barausgaben, Korrekturen, Kommentare,
 * Differenzgründe, Anfangsbestand des Monats, Tages- und Monatsabschlüsse
 * (inkl. Status + Historienlänge — Wiederöffnen ändert den Fingerprint).
 * NICHT einbezogen: exportSettings, exportProtokolle.
 */
export function computeMonthFingerprint(blob: TagesabschlussBlob, monthKey: string): string {
  const inMonth = (date: string): boolean => date.startsWith(`${monthKey}-`);
  const parts: string[] = [];

  for (const [date, day] of Object.entries(blob.days)) {
    if (inMonth(date)) parts.push(`day:${date}:${day.updatedAt}`);
  }
  for (const [date, list] of Object.entries(blob.expenses)) {
    if (!inMonth(date)) continue;
    for (const e of list) parts.push(`exp:${e.id}:${e.updatedAt}`);
  }
  for (const [key, ov] of Object.entries(blob.overrides)) {
    if (inMonth(keyDate(key))) parts.push(`ov:${key}:${ov.updatedAt}`);
  }
  for (const [key, c] of Object.entries(blob.comments)) {
    if (inMonth(keyDate(key))) parts.push(`cm:${key}:${c.updatedAt}`);
  }
  for (const [date, entry] of Object.entries(blob.cashDiffReasons)) {
    if (inMonth(date)) parts.push(`cdr:${date}:${entry.updatedAt}`);
  }
  const anf = blob.anfangsbestand[monthKey];
  if (anf) parts.push(`anf:${monthKey}:${anf.value}:${anf.updatedAt}`);
  for (const [date, cl] of Object.entries(blob.abschluesse)) {
    if (inMonth(date)) parts.push(`cl:${date}:${cl.status}:${cl.updatedAt}:${cl.history.length}`);
  }
  const mc = blob.monatsabschluesse[monthKey];
  if (mc) parts.push(`mc:${monthKey}:${mc.status}:${mc.updatedAt}`);

  parts.sort();
  return fnv1a(parts.join('\n'));
}

/**
 * Inhalts-Fingerprint der EXPORT-RELEVANTEN Buchungsregeln — nur Felder, die
 * die CSV-Bytes ändern: aktive Rollen-Konten, Konto je Zahlungsart (getrimmt,
 * leere Werte ignoriert), erste Belegnummer. Bewusst NICHT einbezogen:
 * `updatedAt`/`reviewed` (identisches Re-Speichern invalidiert keinen Export),
 * LEGACY-Felder (bank/umsatz/mwstCodes) und `kontoBezeichnungen`
 * (Anzeige-only — eine Umbenennung macht eine exportierte CSV nicht falsch;
 * bewusste Abweichung von Spec §9 „Buchungsregeln geändert").
 * null-Settings werden wie die Default-Settings gehasht (gleiche Basis wie
 * die Vorschau, die mit demselben Fallback rendert).
 */
export function computeSettingsFingerprint(
  settings: TagesabschlussExportSettings | null,
): string {
  const s = settings ?? defaultExportSettings('1970-01-01T00:00:00.000Z');
  const parts: string[] = [
    `kasse:${s.konten.kasse.trim()}`,
    `debitoren:${s.konten.debitoren.trim()}`,
    `gutscheine:${s.konten.gutscheine.trim()}`,
    `kartenSammel:${s.konten.kartenSammel.trim()}`,
    `umsatzTransit:${s.konten.umsatzTransit.trim()}`,
    `blgStart:${(s.blgStart ?? '').trim()}`,
  ];
  const zahlarten = Object.entries(s.kontoJeZahlungsart)
    .map(([k, v]) => [k, v.trim()] as const)
    .filter(([, v]) => v !== '')
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [k, v] of zahlarten) parts.push(`za:${k}:${v}`);
  return fnv1a(parts.join('\n'));
}

// ── Checkliste der Export-Voraussetzungen (§2) ───────────────────────────────

export interface ExportChecklistItem {
  key: string;
  label: string;
  ok: boolean;
  /** Menschentauglicher Zusatz (Zählung/Begründung), auch wenn ok. */
  detail: string;
}

/**
 * Prüft alle Export-Voraussetzungen. Der Export ist NUR erlaubt, wenn jedes
 * Item ok ist (`exportChecklistOk`). Reihenfolge = Anzeige-Reihenfolge.
 */
export function buildExportChecklist(
  month: TagesabschlussMonth,
  blob: TagesabschlussBlob,
  monthKey: string,
): ExportChecklistItem[] {
  const t = month.totals;
  const zRows = month.rows.filter(r => r.hasZbericht);
  const unclosedZ = zRows.filter(r => !r.locked);
  const adyenUnchecked = month.rows.filter(r =>
    r.hasAdyen && r.adyenDiffStatus !== null && r.adyenDiffStatus !== 'ok'
    && r.confirmation?.confirmed !== true,
  );
  const monthClosed = isMonthClosed(blob, monthKey);

  return [
    {
      key: 'anfangsbestand',
      label: 'Anfangsbestand vorhanden',
      ok: month.startSaldo !== null,
      detail: month.startSaldo !== null
        ? `Kassensaldo Anfang: ${month.startSaldo.toFixed(2)}`
        : 'Kassen-Anfangsbestand fehlt — über der Monatsübersicht erfassen.',
    },
    {
      key: 'zberichte',
      label: 'Z-Berichte vollständig',
      ok: t.daysWithZbericht > 0,
      detail: t.daysWithZbericht > 0
        ? `${t.daysWithZbericht} Tag(e) mit Z-Bericht.`
        : 'Keine Z-Berichte im Monat importiert.',
    },
    {
      key: 'alle_tage_abgeschlossen',
      label: 'Alle Tage abgeschlossen',
      ok: t.daysWithZbericht > 0 && unclosedZ.length === 0,
      detail: unclosedZ.length === 0
        ? 'Jeder Z-Bericht-Tag ist definitiv abgeschlossen.'
        : `${unclosedZ.length} Tag(e) noch nicht abgeschlossen.`,
    },
    {
      key: 'keine_offenen_tage',
      label: 'Keine offenen Tage',
      ok: t.daysOpen === 0 && t.daysInBearbeitung === 0 && t.daysWiederGeoeffnet === 0,
      detail: t.daysOpen === 0 && t.daysInBearbeitung === 0 && t.daysWiederGeoeffnet === 0
        ? 'Kein offener, in Bearbeitung befindlicher oder wieder geöffneter Tag.'
        : `Offen: ${t.daysOpen}, in Bearbeitung: ${t.daysInBearbeitung}, wieder geöffnet: ${t.daysWiederGeoeffnet}.`,
    },
    {
      key: 'keine_unbegruendeten_differenzen',
      label: 'Keine unbegründeten Differenzen',
      ok: t.daysUnbegruendet === 0,
      detail: t.daysUnbegruendet === 0
        ? 'Alle Kassendifferenzen sind grün oder begründet.'
        : `${t.daysUnbegruendet} Tag(e) mit unbegründeter Kassendifferenz.`,
    },
    {
      key: 'kassensaldo_plausibel',
      label: 'Kassensaldo plausibel',
      ok: month.endSaldo !== null && t.daysNeedsReview === 0,
      detail: month.endSaldo === null
        ? 'Kassensaldo Ende unbekannt (Anfangsbestand fehlt).'
        : t.daysNeedsReview > 0
          ? `${t.daysNeedsReview} abgeschlossene(r) Tag(e) mit abweichendem Saldo — überprüfen.`
          : `Kassensaldo Ende: ${month.endSaldo.toFixed(2)}`,
    },
    {
      key: 'adyen_geprueft',
      label: 'Adyen-Abgleiche geprüft oder begründet',
      ok: adyenUnchecked.length === 0,
      detail: adyenUnchecked.length === 0
        ? 'Alle Adyen-Differenzen sind grün, übersteuert oder bestätigt.'
        : `${adyenUnchecked.length} Tag(e) mit ungeprüfter Adyen-Differenz.`,
    },
    {
      key: 'monatsabschluss',
      label: 'Monatsabschluss erstellt',
      ok: monthClosed,
      detail: monthClosed
        ? 'Monat ist definitiv abgeschlossen.'
        : 'Monat noch nicht abgeschlossen — zuerst den Monatsabschluss erstellen.',
    },
  ];
}

/** Export erlaubt = JEDES Checklisten-Item ok. */
export function exportChecklistOk(items: readonly ExportChecklistItem[]): boolean {
  return items.length > 0 && items.every(i => i.ok);
}

// ── Monatsprüfung (§3) ───────────────────────────────────────────────────────

export interface MonatspruefungItem {
  key: string;
  label: string;
  /** CHF; null = unbekannt (z. B. Saldo ohne Anfangsbestand) → „—". */
  value: number | null;
}

/** Die 9 Monats-Totale der Monatsprüfung, in Anzeige-Reihenfolge. */
export function buildMonatspruefung(month: TagesabschlussMonth): MonatspruefungItem[] {
  const v = month.totals.values;
  return [
    { key: 'umsatz', label: 'Umsatz Total', value: round2(v.umsatz) },
    { key: 'kreditkarten', label: 'Kreditkarten Total (inkl. TWINT)', value: round2(v.karten + v.twint) },
    { key: 'debitoren', label: 'Debitoren Total', value: round2(v.rechnung) },
    { key: 'barausgaben', label: 'Barausgaben Total', value: round2(month.totals.barausgaben) },
    { key: 'gutscheine_verkauft', label: 'Verkaufte Gutscheine', value: round2(v.gutscheinVerkauft) },
    { key: 'gutscheine_eingeloest', label: 'Eingelöste Gutscheine', value: round2(v.gutscheinEingeloest) },
    { key: 'einzahlung_bank', label: 'Einzahlung Bank (nur Kontrollwert — nicht im Export)', value: round2(v.einzahlungBank) },
    { key: 'saldo_anfang', label: 'Kassensaldo Anfang', value: month.startSaldo },
    { key: 'saldo_ende', label: 'Kassensaldo Ende', value: month.endSaldo },
  ];
}

// ── Buchungsvorschau (§4) ────────────────────────────────────────────────────

export const VORSCHAU_KATEGORIE_LABEL: Record<Tabelle2Kategorie, string> = {
  barumsatz: 'Barumsatz (Kasse)',
  kreditkarten: 'Kreditkarten',
  twint: 'TWINT',
  debitoren: 'Debitoren',
  weitere_zahlungsarten: 'Weitere Zahlungsarten (KD Tisch & Co.)',
  gutschein_verkauft: 'Verkaufte Gutscheine',
  gutschein_eingeloest: 'Eingelöste Gutscheine',
  barausgabe: 'Barausgaben',
};

/**
 * Anzeige-Reihenfolge der Vorschau-Bereiche (Brutto-Modell, Spec §4).
 * Einzahlung Bank ist KEINE Export-Kategorie mehr — sie erscheint nur als
 * Kontrollwert in der Monatsprüfung (`buildMonatspruefung`).
 */
export const VORSCHAU_KATEGORIEN: readonly Tabelle2Kategorie[] = [
  'barumsatz', 'kreditkarten', 'twint', 'debitoren', 'weitere_zahlungsarten',
  'gutschein_verkauft', 'gutschein_eingeloest', 'barausgabe',
];

export interface VorschauGruppe {
  kategorie: Tabelle2Kategorie;
  label: string;
  anzahl: number;
  netto: number;
  steuer: number;
  brutto: number;
}

export interface Buchungsvorschau {
  gruppen: VorschauGruppe[];
  /** Summe aller Beträge (Brutto-Modell: identisch mit bruttoTotal). */
  nettoTotal: number;
  /** LEGACY: seit dem Brutto-Modell immer 0 (keine MWST-Buchungen mehr). */
  mwstTotal: number;
  /** Summe aller Buchungsbeträge (brutto). */
  bruttoTotal: number;
  /** Gesamtzahl der Buchungszeilen. */
  anzahlBuchungen: number;
}

/**
 * Aggregiert die Tabelle2-Zeilen zur Buchungsvorschau — es wird KEINE Datei
 * erzeugt. Gruppierung über die strukturell gesetzte `kategorie` (nie über
 * Kontonummern/Texte rückwärts klassifiziert).
 */
export function summarizeBuchungsvorschau(rows: readonly Tabelle2Row[]): Buchungsvorschau {
  const byKat = new Map<Tabelle2Kategorie, { anzahl: number; netto: number; steuer: number }>();
  for (const kat of VORSCHAU_KATEGORIEN) byKat.set(kat, { anzahl: 0, netto: 0, steuer: 0 });
  for (const r of rows) {
    const g = byKat.get(r.kategorie);
    if (!g) continue;
    g.anzahl += 1;
    g.netto += r.netto;
    g.steuer += r.steuer;
  }
  const gruppen: VorschauGruppe[] = VORSCHAU_KATEGORIEN.map(kat => {
    const g = byKat.get(kat) as { anzahl: number; netto: number; steuer: number };
    return {
      kategorie: kat,
      label: VORSCHAU_KATEGORIE_LABEL[kat],
      anzahl: g.anzahl,
      netto: round2(g.netto),
      steuer: round2(g.steuer),
      brutto: round2(g.netto + g.steuer),
    };
  });
  const nettoTotal = round2(rows.reduce((s, r) => s + r.netto, 0));
  const mwstTotal = round2(rows.reduce((s, r) => s + r.steuer, 0));
  return {
    gruppen,
    nettoTotal,
    mwstTotal,
    bruttoTotal: round2(nettoTotal + mwstTotal),
    anzahlBuchungen: rows.length,
  };
}

// ── Soll/Haben-Buchungsvorschau (§4) ─────────────────────────────────────────

/**
 * Anzeige-Bezeichnung eines Kontos gemäss Buchungsregeln
 * (`kontoBezeichnungen`, keyed by Kontonummer) mit Fallback auf den
 * Default-Katalog; unbekannte Konten → «Konto NNNN». Mutiert NIE die Settings.
 */
export function kontoLabel(
  settings: TagesabschlussExportSettings | null,
  konto: string,
): string {
  const nr = konto.trim();
  const custom = settings?.kontoBezeichnungen?.[nr]?.trim();
  if (custom) return custom;
  return DEFAULT_KONTO_BEZEICHNUNGEN[nr] ?? `Konto ${nr}`;
}

export type SollHabenGruppeKey =
  | 'umsatz'
  | 'kartenzahlungen'
  | 'weitere_zahlungsarten'
  | 'debitoren'
  | 'gutscheine'
  | 'barausgaben';

export const SOLL_HABEN_GRUPPEN: readonly SollHabenGruppeKey[] = [
  'umsatz', 'kartenzahlungen', 'weitere_zahlungsarten',
  'debitoren', 'gutscheine', 'barausgaben',
];

export const SOLL_HABEN_GRUPPE_LABEL: Record<SollHabenGruppeKey, string> = {
  umsatz: 'Umsatz',
  kartenzahlungen: 'Kartenzahlungen',
  weitere_zahlungsarten: 'Weitere Zahlungsarten',
  debitoren: 'Debitoren',
  gutscheine: 'Gutscheine',
  barausgaben: 'Barausgaben',
};

/** Eine Zeile der Soll/Haben-Vorschau (genau EINE Seite befüllt). */
export interface SollHabenPosition {
  /** Stabiler Schlüssel (Aggregat bzw. Einzel-Barausgabe). */
  key: string;
  konto: string;
  bezeichnung: string;
  soll: number | null;
  haben: number | null;
}

export interface SollHabenGruppe {
  gruppe: SollHabenGruppeKey;
  label: string;
  positionen: SollHabenPosition[];
  soll: number;
  haben: number;
}

export interface SollHabenVorschau {
  gruppen: SollHabenGruppe[];
  sollTotal: number;
  habenTotal: number;
  /** sollTotal − habenTotal (gerundet). */
  differenz: number;
  /** |Differenz| < 0.005 — sonst ist der Export BLOCKIERT (§4). */
  ausgeglichen: boolean;
  /** Anzahl Buchungszeilen (CSV-Zeilen) — Export == Vorschau (§7). */
  anzahlBuchungen: number;
}

/** Interne Zuordnung einer Buchungsseite zu Gruppe/Aggregat/Bezeichnung. */
interface SeitenZuordnung {
  gruppe: SollHabenGruppeKey;
  /** Aggregations-Schlüssel innerhalb der Gruppe (einzigartig = keine Aggregation). */
  agg: string;
  bezeichnung: string;
}

/**
 * Leitet aus den Tabelle2-Buchungszeilen die doppelseitige Soll/Haben-Vorschau
 * ab: JEDE Zeile ist ein vollständiger Buchungssatz (Kto = Soll, GKto = Haben;
 * negativer Betrag = Seiten getauscht, Betrag = |netto|) und erzeugt daher
 * ZWEI Positionen. Soll-Total ≡ Haben-Total ist damit strukturell garantiert;
 * die Differenz-Prüfung (Toleranz 0.005) ist ein defensives Gate gegen
 * kaputte Zeilen (z. B. fehlendes Konto → Position entfällt → sichtbare
 * Differenz + Export-Block, NIE ein stiller Teil-Export).
 *
 * Aggregation (Übersichtlichkeit, §4): die Haben-Seite Umsatz brutto wird zu
 * EINER «Umsatz»-Zeile zusammengefasst; Zahlwege je Konto; Barausgaben
 * erscheinen EINZELN (Buchungstext), nur ihre Kassen-Gegenseite ist je Konto
 * aggregiert. Bezeichnungen kommen aus den Buchungsregeln (kontoLabel).
 * Die Spec-Beispieltabelle ist einseitig und nachweislich NICHT balanciert —
 * sie ist illustrativ; massgeblich ist die Buchhaltungs-Invariante
 * Soll = Haben.
 */
export function buildSollHabenVorschau(
  rows: readonly Tabelle2Row[],
  settings: TagesabschlussExportSettings | null,
): SollHabenVorschau {
  const label = (konto: string): string => kontoLabel(settings, konto);

  /** Zuordnung der KTO-Seite (Soll bei positivem Betrag). */
  const ktoSeite = (r: Tabelle2Row, index: number): SeitenZuordnung => {
    switch (r.kategorie) {
      case 'barumsatz':
        return { gruppe: 'umsatz', agg: `bar:${r.kto}`, bezeichnung: label(r.kto) };
      case 'kreditkarten':
      case 'twint':
        return { gruppe: 'kartenzahlungen', agg: `karte:${r.kto}`, bezeichnung: label(r.kto) };
      case 'weitere_zahlungsarten':
        return { gruppe: 'weitere_zahlungsarten', agg: `wz:${r.kto}`, bezeichnung: label(r.kto) };
      case 'debitoren':
        return { gruppe: 'debitoren', agg: `deb:${r.kto}`, bezeichnung: label(r.kto) };
      case 'gutschein_eingeloest':
        return { gruppe: 'gutscheine', agg: `ge:${r.kto}`, bezeichnung: 'Eingelöste Gutscheine' };
      case 'gutschein_verkauft':
        return { gruppe: 'gutscheine', agg: `gvk:${r.kto}`, bezeichnung: `Gutscheinverkauf (${label(r.kto)})` };
      case 'barausgabe':
        // EINZELN (§4) — eindeutiger Schlüssel, Buchungstext als Bezeichnung.
        return { gruppe: 'barausgaben', agg: `be:${index}`, bezeichnung: r.tx1.trim() || label(r.kto) };
    }
  };

  /** Zuordnung der GKTO-Seite (Haben bei positivem Betrag). */
  const gktoSeite = (r: Tabelle2Row): SeitenZuordnung => {
    switch (r.kategorie) {
      case 'gutschein_verkauft':
        return { gruppe: 'gutscheine', agg: `gv:${r.gkto}`, bezeichnung: 'Verkaufte Gutscheine' };
      case 'barausgabe':
        return { gruppe: 'barausgaben', agg: `beg:${r.gkto}`, bezeichnung: `Gegenkonto ${label(r.gkto)}` };
      default:
        // Alle Zahlweg-Zeilen: Haben = Umsatz brutto → EINE aggregierte Zeile.
        return { gruppe: 'umsatz', agg: `umsatz:${r.gkto}`, bezeichnung: label(r.gkto) };
    }
  };

  // Aggregation je (Gruppe, Aggregat, Seite) — Einfüge-Reihenfolge bleibt stabil.
  const map = new Map<string, {
    zuordnung: SeitenZuordnung; konto: string; seite: 'S' | 'H'; betrag: number;
  }>();
  let sollSum = 0;
  let habenSum = 0;

  const add = (zuordnung: SeitenZuordnung, konto: string, seite: 'S' | 'H', betrag: number): void => {
    if (konto.trim() === '') return; // kaputte Zeile → Seite entfällt → Differenz sichtbar
    if (seite === 'S') sollSum += betrag; else habenSum += betrag;
    const key = `${zuordnung.gruppe}|${zuordnung.agg}|${seite}`;
    const prev = map.get(key);
    if (prev) prev.betrag += betrag;
    else map.set(key, { zuordnung, konto: konto.trim(), seite, betrag });
  };

  rows.forEach((r, index) => {
    const betrag = Math.abs(r.netto);
    if (betrag === 0) return;
    const ktoIstSoll = r.netto >= 0; // negativ = Seiten getauscht
    add(ktoSeite(r, index), r.kto, ktoIstSoll ? 'S' : 'H', betrag);
    add(gktoSeite(r), r.gkto, ktoIstSoll ? 'H' : 'S', betrag);
  });

  const gruppen: SollHabenGruppe[] = SOLL_HABEN_GRUPPEN.map(gruppe => {
    const eintraege = [...map.entries()].filter(([, e]) => e.zuordnung.gruppe === gruppe);
    // Umsatz-Gruppe: Haben-Zeile(n) („Umsatz") zuerst — wie im Beleg-Layout.
    if (gruppe === 'umsatz') {
      eintraege.sort(([, a], [, b]) => (a.seite === b.seite ? 0 : a.seite === 'H' ? -1 : 1));
    }
    const positionen: SollHabenPosition[] = eintraege.map(([key, e]) => ({
      key,
      konto: e.konto,
      bezeichnung: e.zuordnung.bezeichnung,
      soll: e.seite === 'S' ? round2(e.betrag) : null,
      haben: e.seite === 'H' ? round2(e.betrag) : null,
    }));
    return {
      gruppe,
      label: SOLL_HABEN_GRUPPE_LABEL[gruppe],
      positionen,
      soll: round2(positionen.reduce((s, p) => s + (p.soll ?? 0), 0)),
      haben: round2(positionen.reduce((s, p) => s + (p.haben ?? 0), 0)),
    };
  }).filter(g => g.positionen.length > 0);

  const sollTotal = round2(sollSum);
  const habenTotal = round2(habenSum);
  const differenz = round2(sollTotal - habenTotal);
  return {
    gruppen,
    sollTotal,
    habenTotal,
    differenz,
    ausgeglichen: Math.abs(sollTotal - habenTotal) < 0.005,
    anzahlBuchungen: rows.length,
  };
}

// ── Kontrollwerte (§5) — NICHT Bestandteil des Exports ───────────────────────

export interface Kontrollwert {
  key: string;
  label: string;
  /** CHF; null = unbekannt (z. B. Saldo ohne Anfangsbestand) → „—". */
  value: number | null;
}

/**
 * Kontrollwerte unterhalb der Buchungsvorschau (§5): Einzahlung Bank und die
 * Kassensalden sind bewusst KEINE Buchungen (Bankbuchung kommt separat aus
 * dem Bankbeleg/Bankimport; Salden sind Bestandsgrössen) — sie dienen nur der
 * Plausibilisierung.
 */
export function buildKontrollwerte(month: TagesabschlussMonth): Kontrollwert[] {
  return [
    { key: 'einzahlung_bank', label: 'Einzahlung Bank', value: round2(month.totals.values.einzahlungBank) },
    { key: 'saldo_anfang', label: 'Kassensaldo Anfang', value: month.startSaldo },
    { key: 'saldo_ende', label: 'Kassensaldo Ende', value: month.endSaldo },
  ];
}

// ── Export-Historie / Protokoll (§7/§8) ──────────────────────────────────────

/** Alle Export-Protokolle eines Monats, chronologisch (älteste zuerst). */
export function exportsForMonth(
  blob: TagesabschlussBlob,
  monthKey: string,
): BuchhaltungsExportRecord[] {
  return Object.values(blob.exportProtokolle)
    .filter(r => r.monat === monthKey)
    .sort((a, b) => a.exportedAt.localeCompare(b.exportedAt) || a.version - b.version);
}

/** Jüngstes Export-Protokoll eines Monats (null = noch nie exportiert). */
export function latestExportForMonth(
  blob: TagesabschlussBlob,
  monthKey: string,
): BuchhaltungsExportRecord | null {
  const list = exportsForMonth(blob, monthKey);
  return list.length > 0 ? list[list.length - 1] : null;
}

/** Nächste Versionsnummer eines Monats: max(vorhandene Versionen) + 1. */
export function nextExportVersion(blob: TagesabschlussBlob, monthKey: string): number {
  const versions = exportsForMonth(blob, monthKey).map(r => r.version);
  return versions.length === 0 ? 1 : Math.max(...versions) + 1;
}

/**
 * Erstellt das Protokoll eines soeben erzeugten Exports (write-once):
 * Export-ID, Version (fortlaufend je Monat), Benutzer, Zeitstempel, Anzahl
 * Buchungen, Kassensaldo Ende, Soll-/Haben-Total (§7) und Fingerprints des
 * AKTUELLEN Daten- und Buchungsregeln-Stands.
 */
export function createExportRecord(params: {
  blob: TagesabschlussBlob;
  monthKey: string;
  user: string;
  now: string; // ISO
  anzahlBuchungen: number;
  kassensaldoEnde: number | null;
  sollTotal: number | null;
  habenTotal: number | null;
}): BuchhaltungsExportRecord {
  const { blob, monthKey, user, now, anzahlBuchungen, kassensaldoEnde, sollTotal, habenTotal } = params;
  const version = nextExportVersion(blob, monthKey);
  const rand = Math.random().toString(36).slice(2, 8);
  return {
    id: `exp-${monthKey}-v${version}-${rand}`,
    monat: monthKey,
    version,
    exportedAt: now,
    exportedBy: user,
    anzahlBuchungen,
    kassensaldoEnde,
    sollTotal,
    habenTotal,
    fingerprint: computeMonthFingerprint(blob, monthKey),
    settingsFingerprint: computeSettingsFingerprint(blob.exportSettings ?? null),
    updatedAt: now,
  };
}

/** Fügt ein Export-Protokoll immutabel in den Blob ein. */
export function addExportRecord(
  blob: TagesabschlussBlob,
  record: BuchhaltungsExportRecord,
): TagesabschlussBlob {
  return { ...blob, exportProtokolle: { ...blob.exportProtokolle, [record.id]: record } };
}

// ── Statusableitung (§10/§11) ────────────────────────────────────────────────

export type BuchhaltungsExportStatus = 'offen' | 'bereit' | 'exportiert' | 'veraltet';

export const EXPORT_STATUS_LABEL: Record<BuchhaltungsExportStatus, string> = {
  offen: 'Offen',
  bereit: 'Bereit für Export',
  exportiert: 'Exportiert',
  veraltet: 'Export veraltet',
};

/**
 * Status des Buchhaltungs-Exports eines Monats — rein aus dem Blob ableitbar
 * (auch synchron aus localStorage für die Import-Cockpit-Kontrollaufgabe):
 *  - veraltet:   es gibt einen Export, aber der Monats-Datenstand ODER die
 *                export-relevanten Buchungsregeln haben sich seither geändert
 *                (Fingerprint-Mismatch, §9/§10). Alt-Records OHNE
 *                settingsFingerprint werden NICHT gegen die Regeln verglichen
 *                (kein rückwirkendes Umkippen).
 *  - exportiert: jüngster Export entspricht dem aktuellen Stand
 *  - bereit:     Monat definitiv abgeschlossen, noch kein Export
 *  - offen:      sonst
 */
export function deriveExportStatus(
  blob: TagesabschlussBlob,
  monthKey: string,
): BuchhaltungsExportStatus {
  const latest = latestExportForMonth(blob, monthKey);
  if (latest) {
    const dataStale = latest.fingerprint !== computeMonthFingerprint(blob, monthKey);
    const settingsStale = latest.settingsFingerprint !== undefined
      && latest.settingsFingerprint !== computeSettingsFingerprint(blob.exportSettings ?? null);
    return dataStale || settingsStale ? 'veraltet' : 'exportiert';
  }
  return isMonthClosed(blob, monthKey) ? 'bereit' : 'offen';
}

/**
 * Jüngster Monat (yyyy-MM) mit Tagesabschluss-Aktivität — Bezugsmonat für die
 * Import-Cockpit-Kontrollaufgabe (§11). Betrachtet manuelle Tageswerte,
 * Barausgaben, Tages-/Monatsabschlüsse und Export-Protokolle; null = keinerlei
 * Daten (Cockpit zeigt dann „nie").
 */
export function latestRelevantExportMonth(blob: TagesabschlussBlob): string | null {
  const months = new Set<string>();
  const addDate = (date: string): void => {
    if (/^\d{4}-\d{2}/.test(date)) months.add(date.slice(0, 7));
  };
  for (const d of Object.keys(blob.days)) addDate(d);
  // blob.expenses ist Record<Datum, CashExpense[]> — der SCHLÜSSEL ist das Datum.
  for (const [date, list] of Object.entries(blob.expenses)) {
    if (list.length > 0) addDate(date);
  }
  for (const d of Object.keys(blob.abschluesse)) addDate(d);
  for (const m of Object.keys(blob.monatsabschluesse)) {
    if (/^\d{4}-\d{2}$/.test(m)) months.add(m);
  }
  for (const r of Object.values(blob.exportProtokolle)) {
    if (/^\d{4}-\d{2}$/.test(r.monat)) months.add(r.monat);
  }
  if (months.size === 0) return null;
  return [...months].sort().at(-1)!;
}
