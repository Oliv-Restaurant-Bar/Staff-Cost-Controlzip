/**
 * Tagesabschluss-Monatsübersicht — REINE Logik (DOM-/Supabase-frei)
 * =============================================================================
 * Baut aus den Z-Bericht-Tagesimporten (auto), manuellen Eingaben und
 * Korrektur-Overrides die Monats-Tabelle der Tagesabschlüsse analog der
 * Excel-Datei "UMSATZ Oliv" (Sheet "Buchung").
 *
 * Persistenz-Modell: eigener Blob `tagesabschluss_v1` (localStorage primär +
 * Supabase-KV-Backup, siehe tagesabschluss-db.ts). Es wird NIE in den
 * Adyen-Blob `adyenAbstimmung_v1` geschrieben — dessen Tagesbestätigungen
 * (Barbestand gezählt/Tag bestätigt) werden hier nur GELESEN bzw. über die
 * bestehenden Adyen-Mutationen gesetzt (ein einziger Bestätigungs-Store).
 *
 * Override-Namespace: `date:field` (geschlossene Field-Union) — bewusst
 * getrennt vom Adyen-Namespace `date:source:methodKey`.
 */

import {
  type AdyenAbstimmungBlob,
  type AdyenOverride,
  type AdyenComment,
  type DayConfirmation,
  type GnDayPayment,
  type AdyenDiffStatus,
  adyenDiffStatus,
  buildDayComparison,
  normalizeGnPaymentName,
} from './adyen-abstimmung';

export const TAGESABSCHLUSS_KEY = 'tagesabschluss_v1';

// ── Felder der Tagesübersicht ────────────────────────────────────────────────

/** Auto-Felder: aus dem Z-Bericht übernommen, per Override korrigierbar. */
export const TAGESABSCHLUSS_AUTO_FIELDS = [
  'umsatz',
  'netto',
  'mwst',
  'bar',
  'karten',
  'twint',
  'rechnung',
  'gutscheinVerkauft',
  'gutscheinEingeloest',
  'trinkgeld',
] as const;

/** Manuelle Felder: nur vom Benutzer erfasst (kein Auto-Wert). */
export const TAGESABSCHLUSS_MANUAL_FIELDS = ['bestandKasse', 'einzahlungBank'] as const;

export type TagesabschlussAutoField = (typeof TAGESABSCHLUSS_AUTO_FIELDS)[number];
export type TagesabschlussManualField = (typeof TAGESABSCHLUSS_MANUAL_FIELDS)[number];
export type TagesabschlussField = TagesabschlussAutoField | TagesabschlussManualField;

export const TAGESABSCHLUSS_FIELD_LABEL: Record<TagesabschlussField, string> = {
  umsatz: 'Umsatz',
  netto: 'Netto',
  mwst: 'MWST',
  bar: 'Bargeld / Barumsatz',
  bestandKasse: 'Cash Ist (Bestand Kasse)',
  karten: 'Kreditkarten / Adyen / SIX',
  twint: 'TWINT',
  rechnung: 'Rechnung / Debitoren',
  gutscheinVerkauft: 'Verkaufte Gutscheine',
  gutscheinEingeloest: 'Eingelöste Gutscheine',
  trinkgeld: 'Trinkgeld',
  einzahlungBank: 'Einzahlung Bank',
};

/** Stabiler Override-/Kommentar-Schlüssel: `date:field`. */
export function makeTagesabschlussFieldKey(date: string, field: TagesabschlussField): string {
  return `${date}:${field}`;
}

// ── Differenzgrund-Katalog (feste Schnellauswahl) ────────────────────────────

export interface CashDiffReasonOption {
  /** Stabiler Key (Slug) — wird persistiert, NIE das Label (Projekt-Konvention). */
  key: string;
  label: string;
}

export interface CashDiffReasonCategory {
  key: string;
  label: string;
  reasons: readonly CashDiffReasonOption[];
}

/**
 * Fester Katalog der Kassendifferenz-Gründe (Mehrfachauswahl). Persistiert
 * werden NUR die stabilen Keys — Labels dürfen sich jederzeit ändern.
 */
export const CASH_DIFF_REASON_CATALOG: readonly CashDiffReasonCategory[] = [
  {
    key: 'barausgaben', label: 'Barausgaben',
    reasons: [
      { key: 'barausgabe_vergessen', label: 'Barausgabe vergessen' },
      { key: 'barausgabe_falsch_erfasst', label: 'Barausgabe falsch erfasst' },
    ],
  },
  {
    key: 'bank', label: 'Bank',
    reasons: [
      { key: 'einzahlung_vergessen', label: 'Einzahlung vergessen' },
      { key: 'einzahlung_falscher_betrag', label: 'Einzahlung falscher Betrag' },
      { key: 'einzahlung_folgetag', label: 'Einzahlung erfolgt am Folgetag' },
    ],
  },
  {
    key: 'gutscheine', label: 'Gutscheine',
    reasons: [
      { key: 'gutschein_falsch_verbucht', label: 'Gutschein falsch verbucht' },
      { key: 'gutscheinnummer_pruefen', label: 'Gutscheinnummer prüfen' },
    ],
  },
  {
    key: 'debitoren', label: 'Debitoren',
    reasons: [
      { key: 'rechnung_falsch_erfasst', label: 'Rechnung falsch erfasst' },
      { key: 'debitor_fehlt', label: 'Debitor fehlt' },
    ],
  },
  {
    key: 'kartenzahlungen', label: 'Kartenzahlungen',
    reasons: [
      { key: 'adyen_abweichung', label: 'Adyen-Abweichung' },
      { key: 'zahlung_nachtraeglich', label: 'Zahlung nachträglich verarbeitet' },
    ],
  },
  {
    key: 'kasse', label: 'Kasse',
    reasons: [
      { key: 'wechselgeld_angepasst', label: 'Wechselgeld angepasst' },
      { key: 'trinkgeld_differenz', label: 'Trinkgeld-Differenz' },
      { key: 'rundungsdifferenz', label: 'Rundungsdifferenz' },
      { key: 'kassenfehler', label: 'Kassenfehler' },
    ],
  },
  {
    key: 'sonstiges', label: 'Sonstiges',
    reasons: [
      { key: 'sonstige_ursache', label: 'Sonstige Ursache' },
    ],
  },
];

/** Lookup Key → Label (unbekannte Keys werden vom Aufrufer als Key angezeigt). */
export const CASH_DIFF_REASON_LABEL: Record<string, string> = Object.fromEntries(
  CASH_DIFF_REASON_CATALOG.flatMap(cat => cat.reasons.map(r => [r.key, r.label])),
);

export function cashDiffReasonLabel(key: string): string {
  return CASH_DIFF_REASON_LABEL[key] ?? key;
}

// ── Blob-Datenmodell ─────────────────────────────────────────────────────────

/** Einzelne Barausgabe (im CSV-Export je eine eigene Zeile). */
export interface CashExpense {
  id: string;
  date: string; // yyyy-MM-dd
  amount: number; // CHF, positiv
  konto: string;
  gegenkonto?: string;
  text: string;
  mwstCode?: string;
  belegNr?: string;
  kommentar?: string;
  /**
   * Tombstone: Ausgabe wurde gelöscht. Der Record bleibt (mit jüngerem
   * updatedAt) erhalten, damit merge-on-save die Löschung NICHT durch den
   * Remote-Stand wiederbelebt; alle Leser filtern `deleted`.
   */
  deleted?: true;
  updatedAt: string; // ISO
}

/** Manuelle Tageswerte (kein Auto-Wert vorhanden). */
export interface TagesabschlussManualDay {
  bestandKasse?: number;
  einzahlungBank?: number;
  bemerkung?: string;
  /** Gutscheinnummern (verkauft) — nur im Tagesdetail sichtbar, NIE in der Übersicht. */
  gutscheinNummernVerkauft?: string[];
  /** Gutscheinnummern (eingelöst) — nur im Tagesdetail sichtbar, NIE in der Übersicht. */
  gutscheinNummernEingeloest?: string[];
  updatedAt: string; // ISO — für merge-on-save (jüngster gewinnt)
}

/**
 * Patch für manuelle Tageswerte: NUR vorhandene Keys werden angefasst;
 * `null` / leerer String / leeres Array löscht das jeweilige Feld.
 */
export interface TagesabschlussManualPatch {
  bestandKasse?: number | null;
  einzahlungBank?: number | null;
  bemerkung?: string | null;
  gutscheinNummernVerkauft?: string[] | null;
  gutscheinNummernEingeloest?: string[] | null;
}

/** Rollen-Konten für den Buchhaltungs-Export (Tabelle2). */
export interface TagesabschlussExportSettings {
  /** Konto je Rolle — leere Strings = nicht konfiguriert (Export blockiert). */
  konten: {
    kasse: string;          // z. B. 1000
    /**
     * LEGACY — Einzahlung Bank wird seit der Korrektur NICHT mehr exportiert
     * (sie steuert nur den Kassensaldo; Bankbuchung kommt separat aus dem
     * Bankbeleg/Bankimport). Feld bleibt wegen persistierter Settings-Blobs
     * im Typ/Default erhalten, wird aber weder bebucht noch validiert.
     */
    bank: string;           // z. B. 1020
    debitoren: string;      // z. B. 1100
    gutscheine: string;     // z. B. 2003
    kartenSammel: string;   // z. B. 1110
    /**
     * LEGACY (altes MWST-Modell) — wird seit dem Brutto-Modell NICHT mehr
     * bebucht/validiert. Feld bleibt wegen persistierter Settings-Blobs
     * (merge-on-save kann alte Stände zurückbringen) im Typ erhalten.
     */
    umsatz: string;
    /**
     * Umsatz-BRUTTO-Konto (z. B. 1098): Haben-Seite ALLER Zahlweg-Zeilen.
     * Historischer Feldname „umsatzTransit" bleibt wegen persistierter
     * Settings-Blobs — fachlich ist das seit dem Brutto-Modell das
     * Umsatzkonto (keine MWST-/Durchlaufkonto-Buchungen mehr).
     */
    umsatzTransit: string;
  };
  /**
   * Konto je Zahlungsarten-Key: kartenähnliche Arten (amex/postcard/…;
   * leer → kartenSammel) UND unklassifizierte Arten (kd_tisch_5000/just_eat/…;
   * PFLICHT — ohne Konto blockiert der Export, kein stiller Barumsatz-Rest).
   */
  kontoJeZahlungsart: Record<string, string>;
  /**
   * LEGACY (altes MWST-Modell) — der Export bucht keine MWST mehr (kein 2200,
   * Brutto direkt). Feld bleibt wegen persistierter Settings-Blobs im Typ.
   */
  mwstCodes: Record<string, string>;
  /**
   * Buchungsregeln: Anzeige-Bezeichnung je KONTONUMMER (z. B. '1098' →
   * 'Umsatz'). Rein für die Buchungsvorschau/Anzeige — ändert NIE die
   * CSV-Bytes und fliesst deshalb NICHT in den Settings-Fingerprint.
   * Optional (Alt-Blobs ohne Feld → Fallback DEFAULT_KONTO_BEZEICHNUNGEN).
   */
  kontoBezeichnungen?: Record<string, string>;
  /** Erste Belegnummer (fortlaufend); leer = Blg-Spalte bleibt leer. */
  blgStart?: string;
  /** Benutzer hat das Mapping geprüft — Pflicht vor dem ersten Export. */
  reviewed: boolean;
  updatedAt: string; // ISO
}

/** Differenzgründe + eigene Notiz eines Tages (beides gleichzeitig möglich). */
export interface CashDiffReasonEntry {
  /** Stabile Grund-Keys aus CASH_DIFF_REASON_CATALOG (Mehrfachauswahl). */
  reasons: string[];
  /** Freitext "Eigene Notiz" — zusätzlich zur Schnellauswahl, nicht statt. */
  note?: string;
  /** Tombstone: Gründe entfernt — Key bleibt für merge-on-save (jüngster gewinnt). */
  deleted?: true;
  updatedAt: string; // ISO — für merge-on-save (jüngster gewinnt)
}

/** Benutzerdefinierter Kassensaldo-Anfangsbestand eines Monats (Anker). */
export interface KassensaldoAnfangsbestand {
  value: number; // CHF
  /** Tombstone: Anfangsbestand entfernt — Key bleibt für merge-on-save (jüngster gewinnt). */
  deleted?: true;
  updatedAt: string; // ISO — für merge-on-save (jüngster gewinnt)
}

/**
 * Manueller Kassensaldo-Anker eines TAGES (Inline-Korrektur „Kassensaldo
 * Soll"): die fortlaufende Kette rechnet ab diesem Tag mit dem Anker-Wert
 * weiter (re-base) — auch über Monatsgrenzen. Der berechnete Wert bleibt
 * jederzeit wiederherstellbar (Anker entfernen = Kette gilt wieder).
 */
export interface KassensaldoTagesanker {
  value: number; // CHF
  /** Tombstone: Anker entfernt — bleibt für merge-on-save erhalten (jüngster gewinnt). */
  deleted?: true;
  updatedAt: string; // ISO — für merge-on-save (jüngster gewinnt)
}

/**
 * Korrektur-Override im Tagesabschluss-Blob — wie AdyenOverride, plus
 * optionaler Tombstone: `deleted` markiert einen ENTFERNTEN Override
 * (Auto-Wert gilt wieder), ohne den Key zu löschen — ein gelöschter Key
 * würde beim merge-on-save sofort aus dem Remote-Stand wiederauferstehen.
 * Erst-Original bleibt auch über Tombstones hinweg verankert.
 */
export interface TagesabschlussOverride extends AdyenOverride {
  deleted?: true;
}

/**
 * Feld-Kommentar im Tagesabschluss-Blob — wie AdyenComment, plus optionaler
 * Tombstone (gleiche Begründung wie bei TagesabschlussOverride: gelöschte
 * Keys würden beim merge-on-save aus dem Remote-Stand wiederauferstehen).
 */
export interface TagesabschlussComment extends AdyenComment {
  deleted?: true;
}

// ── Abschluss-/Sperrmechanismus (Tages- + Monatsabschluss) ───────────────────

/** Status eines definitiven Tagesabschlusses (Closure-Record). */
export type DayClosureStatus =
  | 'abgeschlossen'
  | 'abgeschlossen_mit_differenz'
  | 'wieder_geoeffnet';

/** Audit-Eintrag der Abschluss-Historie eines Tages. */
export interface ClosureHistoryEntry {
  at: string; // ISO
  by: string; // Benutzer (E-Mail)
  action: 'abschluss' | 'wiederoeffnung';
  /** Resultierender Status (bei `abschluss`). */
  status?: DayClosureStatus;
  /** Pflicht-Grund (bei `wiederoeffnung`). */
  reason?: string;
}

/**
 * Definitiver Tagesabschluss. WICHTIG: Records werden NIE gelöscht
 * (merge-on-save würde gelöschte Keys von der Gegenseite wiederbeleben) —
 * Wiederöffnen setzt `status: 'wieder_geoeffnet'` mit jüngerem updatedAt.
 */
export interface DayClosure {
  status: DayClosureStatus;
  closedAt: string; // ISO des (letzten) Abschlusses
  closedBy: string;
  /**
   * Beim Abschluss FIXIERTER Kassensaldo (Soll) des Tages — Anzeige-/
   * Audit-Anker. Die Saldo-Kette rechnet IMMER mit den berechneten Werten
   * weiter; weicht der berechnete Saldo später vom fixierten ab
   * (Alt-Tag-Änderung), wird der Tag zur Überprüfung markiert (needsReview).
   * null = Saldo war beim Abschluss unbekannt (sollte canCloseDay verhindern).
   */
  fixedKassensaldo: number | null;
  reopenedAt?: string;
  reopenedBy?: string;
  reopenReason?: string;
  updatedAt: string; // ISO — merge-on-save (jüngster gewinnt, Historie = Union)
  history: ClosureHistoryEntry[];
}

/** Beim Monatsabschluss eingefrorene Monats-Kennzahlen. */
export interface MonthClosureSnapshot {
  anfangsbestand: number | null;
  endbestand: number | null;
  umsatzTotal: number;
  bargeldTotal: number;
  barausgabenTotal: number;
  bankeinzahlungenTotal: number;
  cashDiffTotal: number;
  begruendeteDifferenzen: number;
}

/**
 * Monatsabschluss. Wiederöffnen entfernt den Status NIE per Key-Löschung
 * (merge-Resurrection), sondern setzt `status: 'wieder_geoeffnet'`.
 * Die Tagesabschlüsse bleiben davon unberührt.
 */
export interface MonthClosure {
  status: 'abgeschlossen' | 'wieder_geoeffnet';
  closedAt: string;
  closedBy: string;
  snapshot: MonthClosureSnapshot;
  reopenedAt?: string;
  reopenedBy?: string;
  updatedAt: string; // ISO — merge-on-save (jüngster gewinnt)
}

/**
 * Protokoll-Eintrag eines Buchhaltungs-Exports (write-once — wird nach dem
 * Anlegen NIE mutiert; merge-on-save = Union je Export-ID).
 */
export interface BuchhaltungsExportRecord {
  /** Eindeutige Export-ID (Protokoll §8). */
  id: string;
  /** Monat yyyy-MM. */
  monat: string;
  /** Fortlaufende Version je Monat: 1, 2, 3, … (Mehrfach-Export möglich). */
  version: number;
  exportedAt: string; // ISO
  exportedBy: string; // Benutzer (E-Mail)
  /** Anzahl exportierter Buchungszeilen. */
  anzahlBuchungen: number;
  /** Kassensaldo Ende zum Exportzeitpunkt (null = ohne Anker unbekannt). */
  kassensaldoEnde: number | null;
  /**
   * Soll-/Haben-Total der Buchungsvorschau zum Exportzeitpunkt.
   * Optional: Alt-Records (vor der Soll/Haben-Vorschau) haben keins → „—".
   * NIE rückwirkend befüllen (write-once).
   */
  sollTotal?: number | null;
  habenTotal?: number | null;
  /**
   * Inhalts-Fingerprint der export-relevanten Buchungsregeln (Konten/
   * Zahlungsarten-Mapping/Belegnummer) zum Exportzeitpunkt
   * (computeSettingsFingerprint). Weicht der aktuelle Regel-Stand ab, ist
   * der Export VERALTET. Optional: Alt-Records ohne Feld werden NICHT
   * verglichen (kein rückwirkendes Umkippen auf „veraltet").
   */
  settingsFingerprint?: string;
  /**
   * Deterministischer Fingerprint des Monats-Datenstands zum Exportzeitpunkt
   * (computeMonthFingerprint). Weicht der aktuell berechnete Fingerprint ab,
   * ist der Export VERALTET (kein Zeitvergleich — robust gegen Clock-Skew
   * und merge-on-save-Nachzügler).
   */
  fingerprint: string;
  updatedAt: string; // ISO — = exportedAt (merge-on-save, jüngster gewinnt)
}

export interface TagesabschlussBlob {
  /** Manuelle Tageswerte, Key = yyyy-MM-dd. */
  days: Record<string, TagesabschlussManualDay>;
  /** Barausgaben je Tag, Key = yyyy-MM-dd. */
  expenses: Record<string, CashExpense[]>;
  /** Korrektur-Overrides, Key = `date:field` (inkl. Tombstones). */
  overrides: Record<string, TagesabschlussOverride>;
  /** Kommentare, Key = `date:field` (inkl. Tombstones). */
  comments: Record<string, TagesabschlussComment>;
  /** Kassendifferenz-Gründe + Notiz, Key = yyyy-MM-dd (eigener Namespace,
   *  bewusst NICHT in `days` — dort wird je Datum als Ganzes gemerged). */
  cashDiffReasons: Record<string, CashDiffReasonEntry>;
  /** Kassensaldo-Anfangsbestand je Monat, Key = yyyy-MM (Anker der Saldo-Kette). */
  anfangsbestand: Record<string, KassensaldoAnfangsbestand>;
  /** Manuelle Kassensaldo-Tagesanker, Key = yyyy-MM-dd (re-base der Kette). */
  saldoAnker: Record<string, KassensaldoTagesanker>;
  /** Definitive Tagesabschlüsse (Sperr-Records), Key = yyyy-MM-dd. */
  abschluesse: Record<string, DayClosure>;
  /** Monatsabschlüsse, Key = yyyy-MM. */
  monatsabschluesse: Record<string, MonthClosure>;
  /** Export-Einstellungen (null = noch nie konfiguriert). */
  exportSettings: TagesabschlussExportSettings | null;
  /** Buchhaltungs-Export-Protokolle (write-once), Key = Export-ID. */
  exportProtokolle: Record<string, BuchhaltungsExportRecord>;
  /**
   * Schwelle des Umsatz-Abgleichs (Tagesumsätze-Import vs. Z-Bericht) in CHF —
   * null = Standard (DEFAULT_UMSATZ_DIFF_SCHWELLE). Pro Mandant im Blob.
   */
  umsatzDiffSchwelle: { value: number; updatedAt: string } | null;
}

export function emptyTagesabschlussBlob(): TagesabschlussBlob {
  return {
    days: {}, expenses: {}, overrides: {}, comments: {},
    cashDiffReasons: {}, anfangsbestand: {}, saldoAnker: {},
    abschluesse: {}, monatsabschluesse: {},
    exportSettings: null, exportProtokolle: {},
    umsatzDiffSchwelle: null,
  };
}

/** Defensive Normalisierung eines (evtl. beschädigten) geladenen Blobs. */
export function normalizeTagesabschlussBlob(raw: unknown): TagesabschlussBlob {
  const empty = emptyTagesabschlussBlob();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const o = raw as Partial<TagesabschlussBlob>;
  const isObj = (v: unknown): v is Record<string, never> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  const expenses: TagesabschlussBlob['expenses'] = {};
  if (isObj(o.expenses)) {
    for (const [date, list] of Object.entries(o.expenses as Record<string, unknown>)) {
      if (Array.isArray(list)) expenses[date] = list.filter(e => !!e && typeof e === 'object') as CashExpense[];
    }
  }
  // Differenzgründe: Einträge ohne gültiges reasons-Array defensiv reparieren.
  const cashDiffReasons: TagesabschlussBlob['cashDiffReasons'] = {};
  if (isObj(o.cashDiffReasons)) {
    for (const [date, entry] of Object.entries(o.cashDiffReasons as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const e = entry as Partial<CashDiffReasonEntry>;
      cashDiffReasons[date] = {
        reasons: Array.isArray(e.reasons) ? e.reasons.filter(r => typeof r === 'string') : [],
        ...(typeof e.note === 'string' && e.note.trim() !== '' ? { note: e.note } : {}),
        ...(e.deleted === true ? { deleted: true as const } : {}),
        updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : '',
      };
    }
  }
  const anfangsbestand: TagesabschlussBlob['anfangsbestand'] = {};
  if (isObj(o.anfangsbestand)) {
    for (const [monthKey, entry] of Object.entries(o.anfangsbestand as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const e = entry as Partial<KassensaldoAnfangsbestand>;
      if (typeof e.value !== 'number' || !Number.isFinite(e.value)) continue;
      anfangsbestand[monthKey] = {
        value: e.value,
        ...(e.deleted === true ? { deleted: true as const } : {}),
        updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : '',
      };
    }
  }
  const saldoAnker: TagesabschlussBlob['saldoAnker'] = {};
  if (isObj(o.saldoAnker)) {
    for (const [date, entry] of Object.entries(o.saldoAnker as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const e = entry as Partial<KassensaldoTagesanker>;
      if (typeof e.value !== 'number' || !Number.isFinite(e.value)) continue;
      saldoAnker[date] = {
        value: e.value,
        ...(e.deleted === true ? { deleted: true as const } : {}),
        updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : '',
      };
    }
  }
  // Tagesabschlüsse: nur strukturell gültige Records übernehmen.
  const abschluesse: TagesabschlussBlob['abschluesse'] = {};
  if (isObj(o.abschluesse)) {
    for (const [date, entry] of Object.entries(o.abschluesse as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const e = entry as Partial<DayClosure>;
      if (e.status !== 'abgeschlossen' && e.status !== 'abgeschlossen_mit_differenz' && e.status !== 'wieder_geoeffnet') continue;
      abschluesse[date] = {
        status: e.status,
        closedAt: typeof e.closedAt === 'string' ? e.closedAt : '',
        closedBy: typeof e.closedBy === 'string' ? e.closedBy : '',
        fixedKassensaldo:
          typeof e.fixedKassensaldo === 'number' && Number.isFinite(e.fixedKassensaldo)
            ? e.fixedKassensaldo : null,
        ...(typeof e.reopenedAt === 'string' ? { reopenedAt: e.reopenedAt } : {}),
        ...(typeof e.reopenedBy === 'string' ? { reopenedBy: e.reopenedBy } : {}),
        ...(typeof e.reopenReason === 'string' ? { reopenReason: e.reopenReason } : {}),
        updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : '',
        history: Array.isArray(e.history)
          ? (e.history.filter(h => !!h && typeof h === 'object') as ClosureHistoryEntry[])
          : [],
      };
    }
  }
  const monatsabschluesse: TagesabschlussBlob['monatsabschluesse'] = {};
  if (isObj(o.monatsabschluesse)) {
    for (const [monthKey, entry] of Object.entries(o.monatsabschluesse as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const e = entry as Partial<MonthClosure>;
      if (e.status !== 'abgeschlossen' && e.status !== 'wieder_geoeffnet') continue;
      if (!e.snapshot || typeof e.snapshot !== 'object' || Array.isArray(e.snapshot)) continue;
      monatsabschluesse[monthKey] = {
        status: e.status,
        closedAt: typeof e.closedAt === 'string' ? e.closedAt : '',
        closedBy: typeof e.closedBy === 'string' ? e.closedBy : '',
        snapshot: e.snapshot as MonthClosureSnapshot,
        ...(typeof e.reopenedAt === 'string' ? { reopenedAt: e.reopenedAt } : {}),
        ...(typeof e.reopenedBy === 'string' ? { reopenedBy: e.reopenedBy } : {}),
        updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : '',
      };
    }
  }
  // Export-Protokolle: nur strukturell gültige Records übernehmen.
  const exportProtokolle: TagesabschlussBlob['exportProtokolle'] = {};
  if (isObj(o.exportProtokolle)) {
    for (const [id, entry] of Object.entries(o.exportProtokolle as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const e = entry as Partial<BuchhaltungsExportRecord>;
      if (typeof e.monat !== 'string' || e.monat === '') continue;
      if (typeof e.version !== 'number' || !Number.isFinite(e.version)) continue;
      exportProtokolle[id] = {
        id,
        monat: e.monat,
        version: e.version,
        exportedAt: typeof e.exportedAt === 'string' ? e.exportedAt : '',
        exportedBy: typeof e.exportedBy === 'string' ? e.exportedBy : '',
        anzahlBuchungen:
          typeof e.anzahlBuchungen === 'number' && Number.isFinite(e.anzahlBuchungen)
            ? e.anzahlBuchungen : 0,
        kassensaldoEnde:
          typeof e.kassensaldoEnde === 'number' && Number.isFinite(e.kassensaldoEnde)
            ? e.kassensaldoEnde : null,
        sollTotal:
          typeof e.sollTotal === 'number' && Number.isFinite(e.sollTotal)
            ? e.sollTotal : null,
        habenTotal:
          typeof e.habenTotal === 'number' && Number.isFinite(e.habenTotal)
            ? e.habenTotal : null,
        settingsFingerprint:
          typeof e.settingsFingerprint === 'string' && e.settingsFingerprint !== ''
            ? e.settingsFingerprint : undefined,
        fingerprint: typeof e.fingerprint === 'string' ? e.fingerprint : '',
        updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : '',
      };
    }
  }
  return {
    days:      isObj(o.days)      ? (o.days      as TagesabschlussBlob['days'])      : {},
    expenses,
    overrides: isObj(o.overrides) ? (o.overrides as TagesabschlussBlob['overrides']) : {},
    comments:  isObj(o.comments)  ? (o.comments  as TagesabschlussBlob['comments'])  : {},
    cashDiffReasons,
    anfangsbestand,
    saldoAnker,
    abschluesse,
    monatsabschluesse,
    exportSettings:
      isObj(o.exportSettings) ? (o.exportSettings as unknown as TagesabschlussExportSettings) : null,
    exportProtokolle,
    umsatzDiffSchwelle:
      isObj(o.umsatzDiffSchwelle)
        && typeof (o.umsatzDiffSchwelle as { value?: unknown }).value === 'number'
        && Number.isFinite((o.umsatzDiffSchwelle as { value: number }).value)
        && (o.umsatzDiffSchwelle as { value: number }).value >= 0
        ? {
            value: (o.umsatzDiffSchwelle as { value: number }).value,
            updatedAt: typeof (o.umsatzDiffSchwelle as { updatedAt?: unknown }).updatedAt === 'string'
              ? (o.umsatzDiffSchwelle as { updatedAt: string }).updatedAt : '',
          }
        : null,
  };
}

// ── Z-Bericht-Tagesdaten (Input aus dem read-only Loader) ────────────────────

export interface GnTaxRow {
  rate: string;   // Label wie im Z-Bericht, z. B. "8.1%"
  net: number;
  tax: number;
  gross: number;
}

export interface GnAccountingLine {
  name: string;
  account: string | null;
  taxRate: string | null;
  grossAmount: number;
}

export interface GnPaymentAccount {
  name: string;
  account: string | null;
  grossAmount: number;
}

/** Aggregierte Z-Bericht-Daten EINES Tages (nur Tagesimporte). */
export interface GnDayClosing {
  date: string; // yyyy-MM-dd
  grossRevenue: number | null;
  netRevenue: number | null;
  /** Trinkgeld = totalGross − totalExclTip (nur wenn beide vorhanden, > 0). */
  tip: number | null;
  taxes: GnTaxRow[];
  payments: GnDayPayment[];
  accountingLines: GnAccountingLine[];
  paymentAccounts: GnPaymentAccount[];
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

// Klassifizierungs-Prädikate für Z-Bericht-Zahlungsarten — von
// deriveAutoValues UND collectWeitereZahlungsarten gemeinsam genutzt,
// damit beide nie auseinanderlaufen.
const isBarKey       = (key: string): boolean => key === 'bar' || /^bar(geld|zahlung)?$/.test(key);
const isRechnungKey  = (key: string): boolean => /rechnung|debitor|hotel|auf_haus|kredit_kunde/.test(key);
const isGutscheinKey = (key: string): boolean => /gutschein|voucher/.test(key);
const isTrinkgeldKey = (key: string): boolean => /trinkgeld|^tip/.test(key);

/**
 * Prädikat: Zahlart ist in KEINER Übersichts-Spalte klassifiziert (nicht
 * kartenähnlich, nicht Bar/Rechnung/Gutschein/Trinkgeld) — z. B.
 * „KD Tisch 5000" oder „Just Eat". Von collectWeitereZahlungsarten UND
 * collectUnclassifiedZahlarten (Buchhaltungs-Export) gemeinsam genutzt,
 * damit Übersicht und Export nie auseinanderlaufen.
 */
const isUnclassifiedZahlart = (norm: { key: string; isKkCard: boolean }): boolean =>
  !norm.isKkCard
  && !isBarKey(norm.key) && !isRechnungKey(norm.key)
  && !isGutscheinKey(norm.key) && !isTrinkgeldKey(norm.key);

/** Aus den Z-Bericht-Zahlungsarten die Spaltenwerte eines Tages ableiten. */
export function deriveAutoValues(closing: GnDayClosing): Record<TagesabschlussAutoField, number | null> {
  let bar = 0;
  let karten = 0;
  let twint = 0;
  let rechnung = 0;
  let gutscheinEingeloest = 0;
  let trinkgeldPm = 0;
  let hasBar = false, hasKarten = false, hasTwint = false, hasRechnung = false,
      hasGutschein = false, hasTip = false;

  for (const pm of closing.payments) {
    const norm = normalizeGnPaymentName(pm.name);
    if (norm.key === 'twint') { twint += pm.amount; hasTwint = true; continue; }
    // KK-Karten = alle kartenähnlichen Zahlarten (isKkCard) — inkl.
    // PostCard/Lunch-Check/Stripe, die NICHT über Adyen laufen, aber
    // Kartenzahlungen sind (kein Bargeld). Die Adyen-Vergleichsbasis
    // (isCard) bleibt davon unberührt.
    if (norm.isKkCard) { karten += pm.amount; hasKarten = true; continue; }
    if (isBarKey(norm.key)) { bar += pm.amount; hasBar = true; continue; }
    if (isRechnungKey(norm.key)) { rechnung += pm.amount; hasRechnung = true; continue; }
    if (isGutscheinKey(norm.key)) { gutscheinEingeloest += pm.amount; hasGutschein = true; continue; }
    if (isTrinkgeldKey(norm.key)) { trinkgeldPm += pm.amount; hasTip = true; continue; }
    // Übrige unklassifizierte Zahlarten (z. B. KD Tisch 5000) zählen wir
    // bewusst NICHT stillschweigend irgendwo hinein — sie erscheinen im
    // Tagesdetail unter „Weitere Zahlungsarten" und bleiben Sache der
    // manuellen Kontrolle.
  }

  // Verkaufte Gutscheine: aus den Buchungskonten-Zeilen des Z-Berichts.
  let gutscheinVerkauft = 0;
  let hasVerkauft = false;
  for (const line of closing.accountingLines) {
    if (/gutschein/i.test(line.name) && !/einge/i.test(line.name)) {
      gutscheinVerkauft += line.grossAmount;
      hasVerkauft = true;
    }
  }

  const mwst = closing.taxes.length > 0
    ? round2(closing.taxes.reduce((s, t) => s + t.tax, 0))
    : null;

  const tip = closing.tip !== null && closing.tip > 0
    ? closing.tip
    : (hasTip ? round2(trinkgeldPm) : null);

  return {
    umsatz: closing.grossRevenue,
    netto: closing.netRevenue,
    mwst,
    bar: hasBar ? round2(bar) : null,
    karten: hasKarten ? round2(karten) : null,
    twint: hasTwint ? round2(twint) : null,
    rechnung: hasRechnung ? round2(rechnung) : null,
    gutscheinVerkauft: hasVerkauft ? round2(gutscheinVerkauft) : null,
    gutscheinEingeloest: hasGutschein ? round2(gutscheinEingeloest) : null,
    trinkgeld: tip,
  };
}

// ── Weitere (selten genutzte) Zahlungsarten fürs Tagesdetail ─────────────────

export interface WeitereZahlungsart {
  key: string;
  label: string;
  amount: number;
  /** Im KK-Total der Übersicht enthalten (kartenähnlich)? Sonst rein informativ. */
  inKk: boolean;
}

/** Selten genutzte Karten-Keys — in der Übersicht NUR im KK-Total, einzeln erst im Tagesdetail. */
const RARE_KK_KEYS = new Set(['amex', 'postcard', 'lunch_check', 'stripe']);

/**
 * Selten genutzte Zahlungsarten eines Tages für den aufklappbaren Bereich
 * „Weitere Zahlungsarten" im Tagesdetail: American Express, PostCard,
 * Lunch-Check, Stripe (alle im KK-Total enthalten) sowie sämtliche
 * unklassifizierten Rest-Zahlarten (z. B. KD Tisch 5000 — in KEINER
 * Berechnung enthalten). Mastercard/Visa/Maestro/TWINT/Bar/Rechnung/
 * Gutschein/Trinkgeld erscheinen hier bewusst NICHT — sie stecken bereits
 * in den Übersichts-Spalten.
 */
export function collectWeitereZahlungsarten(closing: GnDayClosing | undefined): WeitereZahlungsart[] {
  if (!closing) return [];
  const agg = new Map<string, WeitereZahlungsart>();
  for (const pm of closing.payments) {
    const norm = normalizeGnPaymentName(pm.name);
    const rareKk = RARE_KK_KEYS.has(norm.key);
    if (!rareKk && !isUnclassifiedZahlart(norm)) continue;
    const prev = agg.get(norm.key);
    agg.set(norm.key, {
      key: norm.key,
      label: prev?.label ?? norm.label,
      amount: (prev?.amount ?? 0) + pm.amount,
      inKk: norm.isKkCard,
    });
  }
  return [...agg.values()]
    .map(z => ({ ...z, amount: round2(z.amount) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'de'));
}

/**
 * Unklassifizierte Zahlarten eines Tages (z. B. „KD Tisch 5000", „Just Eat"),
 * je Key aggregiert — für den Buchhaltungs-Export: jede dieser Arten wird
 * dort SEPARAT kontiert (Konto je Zahlungsart, Default KD Tisch → 1104) und
 * im Export-Barumsatz abgezogen; ohne Konto-Mapping blockiert der Export.
 * Nutzt DASSELBE Prädikat wie deriveAutoValues/collectWeitereZahlungsarten
 * (nie in tagesabschluss-export.ts nachbauen — sonst divergieren
 * Übersicht und Export).
 */
export function collectUnclassifiedZahlarten(closing: GnDayClosing | undefined): ZahlungsartPosten[] {
  if (!closing) return [];
  const agg = new Map<string, ZahlungsartPosten>();
  for (const pm of closing.payments) {
    const norm = normalizeGnPaymentName(pm.name);
    if (!isUnclassifiedZahlart(norm)) continue;
    const prev = agg.get(norm.key);
    agg.set(norm.key, {
      key: norm.key,
      label: prev?.label ?? norm.label,
      amount: (prev?.amount ?? 0) + pm.amount,
    });
  }
  return [...agg.values()]
    .map(z => ({ ...z, amount: round2(z.amount) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'de'));
}

// ── KK-/Adyen-Zusammensetzung (Popover in Übersicht + Tagesdetail) ───────────

/** Ein Posten einer Zahlungsarten-Aufschlüsselung (Popover/Tagesdetail). */
export interface ZahlungsartPosten {
  key: string;
  label: string;
  amount: number;
}

/** Anzeigereihenfolge der KK-Zusammensetzung; unbekannte Keys alphabetisch danach. */
const KK_BREAKDOWN_ORDER = ['mastercard', 'visa', 'twint', 'amex', 'postcard', 'lunch_check', 'stripe'];

function sortPosten(items: ZahlungsartPosten[], order: string[]): ZahlungsartPosten[] {
  return items.sort((a, b) => {
    const ia = order.indexOf(a.key);
    const ib = order.indexOf(b.key);
    if (ia !== -1 || ib !== -1) {
      return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
    }
    return a.label.localeCompare(b.label, 'de');
  });
}

/**
 * Zusammensetzung des KK-Totals der Übersicht (Z-Bericht-Rohwerte): ALLE
 * kartenähnlichen Zahlarten (isKkCard) inkl. TWINT, je Key aggregiert.
 * Die Summe entspricht karten.auto + twint.auto; manuelle Korrekturen
 * werden bewusst NICHT eingerechnet (die Anzeige ergänzt dafür einen
 * separaten Korrektur-Posten).
 */
export function collectKkBreakdown(closing: GnDayClosing | undefined): ZahlungsartPosten[] {
  if (!closing) return [];
  const agg = new Map<string, ZahlungsartPosten>();
  for (const pm of closing.payments) {
    const norm = normalizeGnPaymentName(pm.name);
    if (!norm.isKkCard) continue;
    const prev = agg.get(norm.key);
    agg.set(norm.key, {
      key: norm.key,
      label: prev?.label ?? norm.label,
      amount: (prev?.amount ?? 0) + pm.amount,
    });
  }
  return sortPosten([...agg.values()].map(z => ({ ...z, amount: round2(z.amount) })), KK_BREAKDOWN_ORDER);
}

/**
 * Kartenähnliche Zahlarten, die NICHT über Adyen abgewickelt werden
 * (isKkCard && !isCard — PostCard, Lunch-Check, Stripe). Erklärt im
 * KK-Adyen-Popover, weshalb KK und KK Adyen abweichen können.
 */
export function collectNichtAdyenKk(closing: GnDayClosing | undefined): ZahlungsartPosten[] {
  if (!closing) return [];
  const agg = new Map<string, ZahlungsartPosten>();
  for (const pm of closing.payments) {
    const norm = normalizeGnPaymentName(pm.name);
    if (!norm.isKkCard || norm.isCard) continue;
    const prev = agg.get(norm.key);
    agg.set(norm.key, {
      key: norm.key,
      label: prev?.label ?? norm.label,
      amount: (prev?.amount ?? 0) + pm.amount,
    });
  }
  return sortPosten([...agg.values()].map(z => ({ ...z, amount: round2(z.amount) })), KK_BREAKDOWN_ORDER);
}

// ── Zellen-/Zeilenmodell ─────────────────────────────────────────────────────

export type CellSource = 'auto' | 'manual' | 'corrected' | 'missing';

export interface DayCell {
  /** Automatisch aus dem Z-Bericht übernommener Wert (null = keiner). */
  auto: number | null;
  /** Effektiver Rechenwert (Override > manuell > auto). */
  value: number | null;
  source: CellSource;
  override?: AdyenOverride;
  comment?: string;
}

export type TagesabschlussStatus =
  | 'fehlt'
  | 'offen'
  | 'in_bearbeitung'
  | 'abgeschlossen'
  | 'abgeschlossen_mit_differenz'
  | 'wieder_geoeffnet';

/** Toleranz fixierter vs. berechneter Kassensaldo (Review-Marker). */
export const KASSENSALDO_REVIEW_TOLERANCE = 0.005;

export interface TagesabschlussRow {
  date: string; // yyyy-MM-dd
  hasZbericht: boolean;
  cells: Record<TagesabschlussField, DayCell>;
  /** Summe der einzelnen Barausgaben des Tages (Übersicht zeigt NUR das Total). */
  barausgabenTotal: number;
  expenseCount: number;
  /**
   * Barausgaben-Total darf INLINE erfasst werden: keine Ausgaben oder nur
   * die generische Inline-Ausgabe. Bei itemisierten Ausgaben false —
   * dann nur über den Barausgaben-Dialog editieren.
   */
  inlineExpenseOnly: boolean;
  bemerkung?: string;
  /** Gutscheinnummern (verkauft) — NUR fürs Tagesdetail, nie in der Übersicht rendern. */
  gutscheinNummernVerkauft?: string[];
  /** Gutscheinnummern (eingelöst) — NUR fürs Tagesdetail, nie in der Übersicht rendern. */
  gutscheinNummernEingeloest?: string[];
  /**
   * Selten genutzte Zahlungsarten (Amex, PostCard, Lunch-Check, Stripe,
   * KD Tisch 5000, …) — NUR im aufklappbaren Tagesdetail-Bereich rendern,
   * NIE als eigene Spalte in der Übersicht.
   */
  weitereZahlungsarten: WeitereZahlungsart[];
  /**
   * Zusammensetzung des KK-Totals (alle isKkCard-Arten inkl. TWINT,
   * Z-Bericht-Rohwerte) — fürs KK-Popover in Übersicht und Tagesdetail.
   */
  kkZusammensetzung: ZahlungsartPosten[];
  /**
   * Adyen-seitige Zahlungsarten (effektive Werte inkl. Overrides, identische
   * Basis wie der Adyen-Abgleich) — fürs KK-Adyen-Popover. Leer ohne
   * Adyen-Import/Blob.
   */
  adyenZusammensetzung: ZahlungsartPosten[];
  /**
   * Kartenähnliche Arten OHNE Adyen-Abwicklung (PostCard, Lunch-Check,
   * Stripe) — erklärt im KK-Adyen-Popover die Abweichung KK vs. KK Adyen.
   */
  nichtAdyenKk: ZahlungsartPosten[];
  /**
   * Rechnerischer Barumsatz = Umsatz − Karten − TWINT − Rechnung − eingelöste
   * Gutscheine (effektive Werte). Basis für Export und Bargeld-Soll.
   */
  barumsatz: number | null;
  /**
   * Bargeld (Soll) des Tages — die fachlich verbindliche Formel:
   * Umsatz − KK (Karten+TWINT) − Rechnung − Barausgaben − eingelöste
   * Gutscheine + verkaufte Gutscheine (= Barumsatz + verkaufte Gutscheine
   * − Barausgaben; EingG steckt genau EINMAL im Barumsatz).
   * null, wenn weder Umsatz-Basis noch Barausgaben/Gutscheine vorliegen.
   */
  bargeldSoll: number | null;
  /**
   * Fortlaufender Kassensaldo (Soll) = Saldo Vortag + Bargeld (Soll)
   * − Einzahlung Bank. Monatsstart = Endsaldo Vormonat bzw. gespeicherter
   * Anfangsbestand. null, solange kein Anker (startSaldo) bekannt ist.
   */
  kassensaldoSoll: number | null;
  /**
   * Manueller Kassensaldo-Tagesanker (Inline-Korrektur): gesetzt = die Kette
   * wurde ab diesem Tag auf diesen Wert re-based (kassensaldoSoll = Anker).
   * null = rein berechneter Saldo.
   */
  saldoAnker: number | null;
  /**
   * Rein BERECHNETER Kettenwert dieses Tages (vor Anwendung eines
   * Tages-Ankers) — für die Anzeige „berechnet: …" neben dem Anker.
   */
  saldoBerechnet: number | null;
  /** Cash Ist = manuell gezählter Kassenbestand (Feld `bestandKasse`). */
  cashIst: number | null;
  /** Cash Differenz = Cash Ist − Kassensaldo Soll; null, solange eine Seite fehlt. */
  cashDiff: number | null;
  cashDiffStatus: AdyenDiffStatus | null;
  /** Gewählte Differenzgrund-Keys (Schnellauswahl). */
  cashDiffReasons: string[];
  /** Eigene Notiz zur Differenz (Freitext, zusätzlich zur Schnellauswahl). */
  cashDiffNote?: string;
  /** Begründet = mindestens ein Grund ODER eine Notiz vorhanden. */
  cashDiffBegruendet: boolean;
  /** Adyen-Import für diesen Tag vorhanden? */
  hasAdyen: boolean;
  /**
   * Karten/TWINT-Total laut Adyen (effektiver Wert inkl. Overrides aus dem
   * Adyen-Abgleich — gleiche Zahlen wie in der Adyen-Abgleich-Section).
   * null = kein Adyen-Import bzw. kein Adyen-Blob übergeben.
   */
  adyenTotal: number | null;
  /** Karten/TWINT-Total laut Z-Bericht aus dem Adyen-Vergleich (effektiv). */
  adyenZTotal: number | null;
  /** Differenz Z-Bericht − Adyen (effektive Werte); null = nicht vergleichbar. */
  adyenDiff: number | null;
  adyenDiffStatus: AdyenDiffStatus | null;
  status: TagesabschlussStatus;
  confirmation?: DayConfirmation;
  /** Abschluss-Record des Tages (auch nach Wiederöffnung vorhanden — Audit). */
  closure?: DayClosure;
  /** Tag ist definitiv abgeschlossen → alle Wertfelder gesperrt. */
  locked: boolean;
  /** Beim Abschluss fixierter Kassensaldo (Anzeige-Anker bei gesperrten Tagen). */
  fixedKassensaldo: number | null;
  /**
   * Der aktuell BERECHNETE Kassensaldo weicht vom beim Abschluss fixierten ab
   * (Alt-Tag-Änderung) → „Kassensaldo aufgrund Änderung an früherem Tag
   * überprüfen." Rein abgeleitet, kein persistiertes Flag.
   */
  needsReview: boolean;
}

export interface TagesabschlussTotals {
  values: Record<TagesabschlussField, number>;
  barausgaben: number;
  barumsatz: number;
  /** Summe Karten/TWINT laut Adyen (nur Tage mit Adyen-Import). */
  adyenTotal: number;
  /** Summe der Tages-Differenzen Z-Bericht − Adyen (kann sich aufheben). */
  adyenDiff: number;
  /** Total Bargeld (Soll) — Summe der Tages-Bargeld-Solls. */
  bargeldSoll: number;
  /** Kassensaldo (Soll) am Monatsende; null ohne Anker. */
  kassensaldoEnde: number | null;
  /** Summe Cash Ist (nur Tage mit gezähltem Bestand). */
  cashIst: number;
  /** Cash-Differenz des LETZTEN Tages mit erfasstem Cash Ist (aktueller Stand). */
  letzteCashDiff: number | null;
  letzteCashDiffStatus: AdyenDiffStatus | null;
  daysWithZbericht: number;
  /** Abgeschlossene Tage (inkl. „Abgeschlossen mit Differenz"). */
  daysConfirmed: number;
  /** Tage mit Z-Bericht, aber noch ohne (vollständige) Bestätigung. */
  daysOpen: number;
  /** Tage mit Status „In Bearbeitung". */
  daysInBearbeitung: number;
  /** Definitiv abgeschlossene Tage OHNE Differenz. */
  daysAbgeschlossen: number;
  /** Definitiv abgeschlossene Tage MIT (begründeter) Differenz. */
  daysAbgeschlossenMitDifferenz: number;
  /** Wieder geöffnete Tage. */
  daysWiederGeoeffnet: number;
  /** Abgeschlossene Tage mit Review-Marker (Saldo-Abweichung durch Alt-Tag-Änderung). */
  daysNeedsReview: number;
  /** Summe der Cash-Differenzen (nur Tage mit erfasster Differenz). */
  cashDiffTotal: number;
  /** Tage mit nicht-grüner Adyen- ODER Cash-Differenz. */
  daysWithDiff: number;
  /** Tage mit nicht-grüner Cash-Differenz. */
  daysWithCashDiff: number;
  /** Tage mit nicht-grüner Cash-Differenz UND Begründung (Grund oder Notiz). */
  daysBegruendet: number;
  /** Tage mit nicht-grüner Cash-Differenz OHNE Begründung. */
  daysUnbegruendet: number;
}

export interface TagesabschlussMonth {
  rows: TagesabschlussRow[];
  totals: TagesabschlussTotals;
  /** Kassensaldo (Soll) zu Monatsbeginn (Input); null = kein Anker bekannt. */
  startSaldo: number | null;
  /** Kassensaldo (Soll) am Monatsende; null, wenn startSaldo unbekannt. */
  endSaldo: number | null;
}

/** Alle Kalendertage eines Monats als yyyy-MM-dd (aufsteigend). */
export function monthDates(year: number, month: number): string[] {
  const mm = String(month).padStart(2, '0');
  const last = new Date(year, month, 0).getDate();
  const out: string[] = [];
  for (let d = 1; d <= last; d++) out.push(`${year}-${mm}-${String(d).padStart(2, '0')}`);
  return out;
}

/** Summe der Barausgaben einer Liste. */
export function expensesTotal(list: readonly CashExpense[] | undefined): number {
  if (!list || list.length === 0) return 0;
  return round2(list.reduce((s, e) => s + (Number.isFinite(e.amount) ? e.amount : 0), 0));
}

function buildCell(
  date: string,
  field: TagesabschlussField,
  auto: number | null,
  manual: number | null,
  blob: TagesabschlussBlob,
): DayCell {
  const key = makeTagesabschlussFieldKey(date, field);
  const ov = blob.overrides[key];
  const commentEntry = blob.comments[key];
  const comment = commentEntry && !commentEntry.deleted ? commentEntry.text : undefined;
  if (ov && ov.correctedByManualOverride && !ov.deleted) {
    return { auto, value: ov.correctedValue, source: 'corrected', override: ov, ...(comment ? { comment } : {}) };
  }
  if (manual !== null && manual !== undefined) {
    return { auto, value: manual, source: 'manual', ...(comment ? { comment } : {}) };
  }
  if (auto !== null && auto !== undefined) {
    return { auto, value: auto, source: 'auto', ...(comment ? { comment } : {}) };
  }
  return { auto: null, value: null, source: 'missing', ...(comment ? { comment } : {}) };
}

/**
 * Baut die Monats-Tabelle der Tagesabschlüsse.
 * `confirmations` stammen aus dem Adyen-Blob (EIN Bestätigungs-Store).
 * `adyenBlob` (optional, rückwärtskompatibel): liefert pro Tag den
 * Karten/TWINT-Vergleich Z-Bericht vs. Adyen (via `buildDayComparison` —
 * exakt dieselben effektiven Werte wie in der Adyen-Abgleich-Section,
 * inkl. dortiger Overrides). Ohne Blob bleiben die Adyen-Felder null.
 * `startSaldo` (optional): Kassensaldo (Soll) zu Monatsbeginn — Endsaldo des
 * Vormonats bzw. gespeicherter Anfangsbestand (via resolveKassensaldoStart).
 * Ohne Anker (null/undefined) bleiben alle Saldi und Cash-Differenzen null.
 */
export function buildTagesabschlussRows(
  year: number,
  month: number,
  closings: Record<string, GnDayClosing>,
  blob: TagesabschlussBlob,
  confirmations: Record<string, DayConfirmation>,
  adyenBlob?: AdyenAbstimmungBlob | null,
  startSaldo?: number | null,
): TagesabschlussMonth {
  const rows: TagesabschlussRow[] = [];
  const start = startSaldo ?? null;
  // Fortlaufender Kassensaldo (Soll) — läuft auch an Tagen ohne Z-Bericht
  // weiter (Barausgaben/Einzahlungen existieren unabhängig vom Z-Bericht).
  let saldo: number | null = start;

  for (const date of monthDates(year, month)) {
    const closing = closings[date];
    const manual = blob.days[date];
    const auto: Record<TagesabschlussAutoField, number | null> = closing
      ? deriveAutoValues(closing)
      : {
          umsatz: null, netto: null, mwst: null, bar: null, karten: null, twint: null,
          rechnung: null, gutscheinVerkauft: null, gutscheinEingeloest: null, trinkgeld: null,
        };

    const cells = {} as Record<TagesabschlussField, DayCell>;
    for (const f of TAGESABSCHLUSS_AUTO_FIELDS) {
      cells[f] = buildCell(date, f, auto[f], null, blob);
    }
    cells.bestandKasse = buildCell(date, 'bestandKasse', null, manual?.bestandKasse ?? null, blob);
    cells.einzahlungBank = buildCell(date, 'einzahlungBank', null, manual?.einzahlungBank ?? null, blob);

    const expenses = (blob.expenses[date] ?? []).filter(e => !e.deleted);
    const barausgabenTotal = expensesTotal(expenses);

    const umsatz = cells.umsatz.value;
    const barumsatz = umsatz !== null
      ? round2(
          umsatz
          - (cells.karten.value ?? 0)
          - (cells.twint.value ?? 0)
          - (cells.rechnung.value ?? 0)
          - (cells.gutscheinEingeloest.value ?? 0),
        )
      : null;

    // Bargeld (Soll) — verbindliche Formel: Umsatz − KK − Rechnung −
    // Barausgaben − EingG + VerkG. Der Barumsatz enthält bereits
    // Umsatz − Karten − TWINT − Rechnung − EingG, also:
    // bargeldSoll = Barumsatz + verkaufte Gutscheine − Barausgaben.
    // An Tagen ohne Z-Bericht: nur Barausgaben (negativ), sonst null.
    const gutscheinVerkauft = cells.gutscheinVerkauft.value ?? 0;
    const bargeldSoll = barumsatz !== null
      ? round2(barumsatz + gutscheinVerkauft - barausgabenTotal)
      : (barausgabenTotal > 0 ? round2(-barausgabenTotal) : null);

    // Kassensaldo (Soll) fortführen: Saldo Vortag + Bargeld (Soll)
    // − Einzahlung Bank. Beiträge fehlender Werte zählen als 0, damit der
    // Laufsaldo an umsatzfreien Tagen (z. B. Ruhetag mit Bankeinzahlung)
    // nicht abreisst. Ohne Anker (start === null) bleibt alles null.
    const einzahlungBank = cells.einzahlungBank.value ?? 0;
    if (saldo !== null) {
      saldo = round2(saldo + (bargeldSoll ?? 0) - einzahlungBank);
    }
    // Manueller Tages-Anker (Inline-Korrektur „Kassensaldo Soll"): re-based
    // die Kette ab diesem Tag — auch wenn sie bisher null war (kein
    // Monats-Anker). Der berechnete Wert bleibt über das Entfernen des
    // Ankers jederzeit wiederherstellbar.
    const ankerEntry = blob.saldoAnker[date];
    const tagesanker = ankerEntry && !ankerEntry.deleted ? ankerEntry : undefined;
    const saldoVorAnker = saldo;
    if (tagesanker) saldo = round2(tagesanker.value);
    const kassensaldoSoll = saldo;

    // Abschluss-Record: gesperrte Tage zeigen den beim Abschluss FIXIERTEN
    // Saldo (Anzeige-/Audit-Anker); die Kette rechnet IMMER mit dem
    // berechneten Wert weiter — so wird eine Alt-Tag-Änderung als Abweichung
    // fixiert↔berechnet sichtbar (needsReview), auch über Monatsgrenzen.
    const closure = blob.abschluesse[date];
    const locked = !!closure && closure.status !== 'wieder_geoeffnet';
    const fixedKassensaldo = closure?.fixedKassensaldo ?? null;
    const needsReview = locked
      && fixedKassensaldo !== null
      && kassensaldoSoll !== null
      && Math.abs(fixedKassensaldo - kassensaldoSoll) > KASSENSALDO_REVIEW_TOLERANCE;

    const cashIst = cells.bestandKasse.value;
    const saldoForDiff = locked && fixedKassensaldo !== null ? fixedKassensaldo : kassensaldoSoll;
    const cashDiff = cashIst !== null && saldoForDiff !== null
      ? round2(cashIst - saldoForDiff)
      : null;
    const cashDiffStatus = cashDiff !== null ? adyenDiffStatus(cashDiff) : null;

    // Differenzgründe + Notiz (Schnellauswahl UND Freitext, beides zählt).
    // Tombstones (deleted) zählen als "keine Begründung".
    const rawReasonEntry = blob.cashDiffReasons[date];
    const reasonEntry = rawReasonEntry && !rawReasonEntry.deleted ? rawReasonEntry : undefined;
    const cashDiffReasons = reasonEntry?.reasons?.filter(r => r.trim() !== '') ?? [];
    const cashDiffNote = reasonEntry?.note?.trim() || undefined;
    const cashDiffBegruendet = cashDiffReasons.length > 0 || !!cashDiffNote;

    const confirmation = confirmations[date];
    // Statuslogik (Abschluss-Mechanismus):
    // 1. Definitiver Abschluss-Record gewinnt: abgeschlossen /
    //    abgeschlossen_mit_differenz (gesperrt) bzw. wieder_geoeffnet.
    // 2. Ohne Z-Bericht: fehlt.
    // 3. Sonst „in Bearbeitung", sobald irgendein Arbeitsstand existiert
    //    (Bestätigungs-Häkchen, Cash Ist, Einzahlung Bank, Barausgaben,
    //    Korrektur, Differenz-Begründung) — Alt-Tage mit Häkchen OHNE
    //    Closure-Record werden bewusst NICHT auto-migriert.
    // 4. Sonst: offen.
    const hasProgress = confirmation?.confirmed === true
      || confirmation?.cashCounted === true
      || cashIst !== null
      || cells.einzahlungBank.value !== null
      || expenses.length > 0
      || cashDiffBegruendet
      || !!tagesanker
      || (Object.values(cells) as DayCell[]).some(c => c.source === 'corrected' || c.source === 'manual');
    const status: TagesabschlussStatus = closure && locked
      ? closure.status as TagesabschlussStatus
      : closure && closure.status === 'wieder_geoeffnet'
        ? 'wieder_geoeffnet'
        : !closing
          ? 'fehlt'
          : hasProgress
            ? 'in_bearbeitung'
            : 'offen';

    // Adyen-Vergleich (nur ANZEIGE): identische Rechenbasis wie die
    // Adyen-Abgleich-Section — buildDayComparison mit dem Adyen-Blob.
    const adyenDay = adyenBlob?.days[date] ?? null;
    let adyenTotal: number | null = null;
    let adyenZTotal: number | null = null;
    let adyenDiff: number | null = null;
    let adyenDiffSt: AdyenDiffStatus | null = null;
    let adyenZusammensetzung: ZahlungsartPosten[] = [];
    if (adyenBlob && (closing || adyenDay)) {
      const cmp = buildDayComparison(date, closing ? closing.payments : null, adyenDay, adyenBlob);
      adyenTotal = cmp.cardTotalAdyen?.value ?? null;
      adyenZTotal = cmp.cardTotalZ?.value ?? null;
      adyenDiff = cmp.totalDiff;
      adyenDiffSt = cmp.totalStatus;
      // Nur Zahlungsarten, die auf der ADYEN-Seite existieren — Arten ohne
      // Adyen-Abwicklung erscheinen bewusst nicht in dieser Aufschlüsselung.
      adyenZusammensetzung = cmp.rows
        .filter(r => r.adyen !== undefined)
        .map(r => ({ key: r.methodKey, label: r.label, amount: round2(r.adyen!.value) }));
    }

    rows.push({
      date,
      hasZbericht: !!closing,
      cells,
      barausgabenTotal,
      expenseCount: expenses.length,
      inlineExpenseOnly: isInlineExpenseEditable(expenses, date),
      ...(manual?.bemerkung ? { bemerkung: manual.bemerkung } : {}),
      ...(manual?.gutscheinNummernVerkauft?.length
        ? { gutscheinNummernVerkauft: manual.gutscheinNummernVerkauft } : {}),
      ...(manual?.gutscheinNummernEingeloest?.length
        ? { gutscheinNummernEingeloest: manual.gutscheinNummernEingeloest } : {}),
      weitereZahlungsarten: collectWeitereZahlungsarten(closing),
      kkZusammensetzung: collectKkBreakdown(closing),
      adyenZusammensetzung,
      nichtAdyenKk: collectNichtAdyenKk(closing),
      barumsatz,
      bargeldSoll,
      kassensaldoSoll,
      saldoAnker: tagesanker ? round2(tagesanker.value) : null,
      saldoBerechnet: saldoVorAnker,
      cashIst,
      cashDiff,
      cashDiffStatus,
      cashDiffReasons,
      ...(cashDiffNote ? { cashDiffNote } : {}),
      cashDiffBegruendet,
      hasAdyen: !!adyenDay,
      adyenTotal,
      adyenZTotal,
      adyenDiff,
      adyenDiffStatus: adyenDiffSt,
      status,
      ...(confirmation ? { confirmation } : {}),
      ...(closure ? { closure } : {}),
      locked,
      fixedKassensaldo,
      needsReview,
    });
  }

  // Aktuellster Kassen-Zählstand: letzter Tag mit erfasster Cash-Differenz.
  const lastDiffRow = [...rows].reverse().find(r => r.cashDiff !== null) ?? null;

  const totals: TagesabschlussTotals = {
    values: Object.fromEntries(
      ([...TAGESABSCHLUSS_AUTO_FIELDS, ...TAGESABSCHLUSS_MANUAL_FIELDS] as TagesabschlussField[])
        .map(f => [
          f,
          round2(rows.reduce((s, r) => s + (r.cells[f].value ?? 0), 0)),
        ]),
    ) as Record<TagesabschlussField, number>,
    barausgaben: round2(rows.reduce((s, r) => s + r.barausgabenTotal, 0)),
    barumsatz: round2(rows.reduce((s, r) => s + (r.barumsatz ?? 0), 0)),
    adyenTotal: round2(rows.reduce((s, r) => s + (r.adyenTotal ?? 0), 0)),
    adyenDiff: round2(rows.reduce((s, r) => s + (r.adyenDiff ?? 0), 0)),
    bargeldSoll: round2(rows.reduce((s, r) => s + (r.bargeldSoll ?? 0), 0)),
    kassensaldoEnde: saldo,
    cashIst: round2(rows.reduce((s, r) => s + (r.cashIst ?? 0), 0)),
    letzteCashDiff: lastDiffRow?.cashDiff ?? null,
    letzteCashDiffStatus: lastDiffRow?.cashDiffStatus ?? null,
    daysWithZbericht: rows.filter(r => r.hasZbericht).length,
    daysConfirmed: rows.filter(r =>
      r.status === 'abgeschlossen' || r.status === 'abgeschlossen_mit_differenz',
    ).length,
    daysOpen: rows.filter(r => r.status === 'offen').length,
    daysInBearbeitung: rows.filter(r => r.status === 'in_bearbeitung').length,
    daysAbgeschlossen: rows.filter(r => r.status === 'abgeschlossen').length,
    daysAbgeschlossenMitDifferenz: rows.filter(r => r.status === 'abgeschlossen_mit_differenz').length,
    daysWiederGeoeffnet: rows.filter(r => r.status === 'wieder_geoeffnet').length,
    daysNeedsReview: rows.filter(r => r.needsReview).length,
    cashDiffTotal: round2(rows.reduce((s, r) => s + (r.cashDiff ?? 0), 0)),
    daysWithDiff: rows.filter(r =>
      (r.adyenDiffStatus !== null && r.adyenDiffStatus !== 'ok')
      || (r.cashDiffStatus !== null && r.cashDiffStatus !== 'ok'),
    ).length,
    daysWithCashDiff: rows.filter(r =>
      r.cashDiffStatus !== null && r.cashDiffStatus !== 'ok',
    ).length,
    daysBegruendet: rows.filter(r =>
      r.cashDiffStatus !== null && r.cashDiffStatus !== 'ok' && r.cashDiffBegruendet,
    ).length,
    daysUnbegruendet: rows.filter(r =>
      r.cashDiffStatus !== null && r.cashDiffStatus !== 'ok' && !r.cashDiffBegruendet,
    ).length,
  };

  return { rows, totals, startSaldo: start, endSaldo: saldo };
}

// ── Mutationen (rein, immutabel) ─────────────────────────────────────────────

/**
 * Setzt/entfernt manuelle Tageswerte. NUR im Patch vorhandene Keys werden
 * angefasst — `null`/`undefined`/leerer String löscht das jeweilige Feld.
 * Inline-Edits dürfen daher ein einzelnes Feld patchen, ohne die übrigen
 * manuellen Werte des Tages zu verlieren.
 */
export function upsertManualDay(
  blob: TagesabschlussBlob,
  date: string,
  patch: TagesabschlussManualPatch,
  now: string,
): TagesabschlussBlob {
  const existing = blob.days[date];
  const next: TagesabschlussManualDay = { ...existing, updatedAt: now };
  const nextRec = next as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch) as Array<[keyof TagesabschlussManualPatch, unknown]>) {
    if (Array.isArray(v)) {
      // Gutscheinnummern: trimmen, Leereinträge verwerfen; leer → Feld löschen.
      const cleaned = v.map(s => String(s).trim()).filter(s => s !== '');
      if (cleaned.length === 0) delete nextRec[k];
      else nextRec[k] = cleaned;
      continue;
    }
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      delete nextRec[k];
    } else {
      nextRec[k] = typeof v === 'string' ? v.trim() : v;
    }
  }
  const days = { ...blob.days };
  const hasContent =
    next.bestandKasse !== undefined || next.einzahlungBank !== undefined || next.bemerkung !== undefined
    || next.gutscheinNummernVerkauft !== undefined || next.gutscheinNummernEingeloest !== undefined;
  if (hasContent) days[date] = next;
  else delete days[date];
  return { ...blob, days };
}

/** Setzt oder entfernt einen Korrektur-Override. correctedValue===null entfernt. */
export function setTagesabschlussOverride(
  blob: TagesabschlussBlob,
  date: string,
  field: TagesabschlussField,
  originalValue: number,
  correctedValue: number | null,
  comment: string | undefined,
  now: string,
): TagesabschlussBlob {
  const key = makeTagesabschlussFieldKey(date, field);
  const overrides = { ...blob.overrides };
  if (correctedValue === null) {
    // Tombstone statt Key-Löschung: merge-on-save (Union je Key) würde einen
    // gelöschten Key sofort aus dem Remote-Stand wiederbeleben. Erst-Original
    // bleibt verankert; alle Leser behandeln `deleted` als "kein Override".
    const existing = overrides[key];
    if (!existing) return blob;
    if (!existing.deleted) {
      overrides[key] = {
        originalValue: existing.originalValue,
        correctedValue: existing.correctedValue,
        correctedByManualOverride: true,
        deleted: true,
        updatedAt: now,
      };
    }
  } else {
    const existing = overrides[key];
    overrides[key] = {
      // Original des ERSTEN Overrides behalten — nie den korrigierten Wert
      // als neues "Original" verankern (gleiches Prinzip wie Adyen-Abgleich).
      originalValue: existing ? existing.originalValue : originalValue,
      correctedValue,
      correctedByManualOverride: true,
      ...(comment !== undefined && comment.trim() !== '' ? { comment: comment.trim() } : {}),
      updatedAt: now,
    };
  }
  return { ...blob, overrides };
}

/**
 * Setzt oder entfernt die Differenzgründe + Notiz eines Tages.
 * Schnellauswahl (Keys) UND Freitext werden GEMEINSAM gespeichert —
 * beide leer → Eintrag wird entfernt.
 */
export function setCashDiffReasons(
  blob: TagesabschlussBlob,
  date: string,
  reasons: readonly string[],
  note: string | undefined,
  now: string,
): TagesabschlussBlob {
  const cleanedReasons = [...new Set(reasons.map(r => r.trim()).filter(r => r !== ''))];
  const cleanedNote = (note ?? '').trim();
  const cashDiffReasons = { ...blob.cashDiffReasons };
  if (cleanedReasons.length === 0 && cleanedNote === '') {
    // Tombstone statt Key-Löschung (merge-on-save würde den Remote-Stand
    // wiederbeleben); Leser behandeln `deleted` als "keine Begründung".
    const existing = cashDiffReasons[date];
    if (!existing || existing.deleted) return blob;
    cashDiffReasons[date] = {
      reasons: existing.reasons,
      ...(existing.note !== undefined ? { note: existing.note } : {}),
      deleted: true,
      updatedAt: now,
    };
  } else {
    // Neusetzen reaktiviert einen evtl. Tombstone (kein `deleted`-Feld).
    cashDiffReasons[date] = {
      reasons: cleanedReasons,
      ...(cleanedNote !== '' ? { note: cleanedNote } : {}),
      updatedAt: now,
    };
  }
  return { ...blob, cashDiffReasons };
}

/**
 * Setzt oder entfernt den Kassensaldo-Anfangsbestand eines Monats
 * (`monthKey` = yyyy-MM). `value === null` entfernt den Anker.
 */
export function setAnfangsbestand(
  blob: TagesabschlussBlob,
  monthKey: string,
  value: number | null,
  now: string,
): TagesabschlussBlob {
  const anfangsbestand = { ...blob.anfangsbestand };
  if (value === null || !Number.isFinite(value)) {
    // Tombstone statt Key-Löschung (merge-on-save würde den Remote-Stand
    // wiederbeleben); Leser behandeln `deleted` als "kein Anfangsbestand".
    const existing = anfangsbestand[monthKey];
    if (!existing || existing.deleted) return blob;
    anfangsbestand[monthKey] = { value: existing.value, deleted: true, updatedAt: now };
  } else {
    // Neusetzen reaktiviert einen evtl. Tombstone (kein `deleted`-Feld).
    anfangsbestand[monthKey] = { value: round2(value), updatedAt: now };
  }
  return { ...blob, anfangsbestand };
}

/**
 * Setzt oder entfernt den manuellen Kassensaldo-Tagesanker (`date` =
 * yyyy-MM-dd). Die Saldo-Kette rechnet ab diesem Tag mit dem Anker-Wert
 * weiter (re-base, auch monatsübergreifend); `value === null` entfernt den
 * Anker — die berechnete Kette gilt wieder. Spätere GESPERRTE Tage können
 * dadurch bewusst einen Review-Marker erhalten (fixierter ≠ neuer Saldo).
 */
export function setSaldoAnker(
  blob: TagesabschlussBlob,
  date: string,
  value: number | null,
  now: string,
): TagesabschlussBlob {
  const saldoAnker = { ...blob.saldoAnker };
  if (value === null || !Number.isFinite(value)) {
    // Tombstone statt Key-Löschung (merge-on-save würde den Remote-Stand
    // wiederbeleben); Leser behandeln `deleted` als "kein Anker".
    const existing = saldoAnker[date];
    if (!existing) return blob;
    if (!existing.deleted) {
      saldoAnker[date] = { value: existing.value, deleted: true, updatedAt: now };
    }
  } else {
    saldoAnker[date] = { value: round2(value), updatedAt: now };
  }
  return { ...blob, saldoAnker };
}

/** Setzt oder entfernt einen Kommentar (leerer Text entfernt). */
export function setTagesabschlussComment(
  blob: TagesabschlussBlob,
  date: string,
  field: TagesabschlussField,
  text: string,
  now: string,
): TagesabschlussBlob {
  const key = makeTagesabschlussFieldKey(date, field);
  const comments = { ...blob.comments };
  const trimmed = text.trim();
  if (trimmed === '') {
    // Tombstone statt Key-Löschung (merge-on-save würde den Remote-Stand
    // wiederbeleben); Leser behandeln `deleted` als "kein Kommentar".
    const existing = comments[key];
    if (!existing || existing.deleted) return blob;
    comments[key] = { text: existing.text, deleted: true, updatedAt: now };
  } else {
    // Neusetzen reaktiviert einen evtl. Tombstone (kein `deleted`-Feld).
    comments[key] = { text: trimmed, updatedAt: now };
  }
  return { ...blob, comments };
}

/** Fügt eine Barausgabe hinzu oder aktualisiert sie (Match über id). */
export function upsertExpense(blob: TagesabschlussBlob, expense: CashExpense): TagesabschlussBlob {
  const expenses = { ...blob.expenses };
  // Bei Datumswechsel einer bestehenden Ausgabe: aus alter Liste entfernen.
  for (const [date, list] of Object.entries(expenses)) {
    if (date !== expense.date && list.some(e => e.id === expense.id)) {
      const filtered = list.filter(e => e.id !== expense.id);
      if (filtered.length > 0) expenses[date] = filtered;
      else delete expenses[date];
    }
  }
  const list = expenses[expense.date] ?? [];
  const idx = list.findIndex(e => e.id === expense.id);
  const nextList = idx >= 0 ? list.map(e => (e.id === expense.id ? expense : e)) : [...list, expense];
  expenses[expense.date] = nextList;
  return { ...blob, expenses };
}

/**
 * Entfernt eine Barausgabe — als Tombstone (`deleted: true`, jüngeres
 * updatedAt): merge-on-save vereinigt Ausgaben je id, ein hart gelöschter
 * Record würde sofort aus dem Remote-Stand wiederauferstehen.
 */
export function removeExpense(
  blob: TagesabschlussBlob,
  date: string,
  id: string,
  now: string,
): TagesabschlussBlob {
  const list = blob.expenses[date];
  if (!list) return blob;
  const target = list.find(e => e.id === id);
  if (!target || target.deleted) return blob;
  const expenses = { ...blob.expenses };
  expenses[date] = list.map(e => (e.id === id ? { ...e, deleted: true as const, updatedAt: now } : e));
  return { ...blob, expenses };
}

// ── Inline-Barausgabe (Schnellerfassung des Tages-Totals in der Tabelle) ─────

/** Konto-Default der generischen Inline-Barausgabe (Kontoplan Oliv: 1001 Barausgaben). */
export const INLINE_EXPENSE_DEFAULT_KONTO = '1001';

/** ID der generischen Inline-Barausgabe eines Tages. */
export function inlineExpenseId(date: string): string {
  return `inline-${date}`;
}

/**
 * Inline-Eingabe des Barausgaben-Totals nur erlaubt, solange KEINE anderen
 * itemisierten Ausgaben existieren (leer ODER genau die generische
 * Inline-Ausgabe) — sonst würde die Summeneingabe einzelne, je Konto
 * exportierte Positionen still verdrängen (dann Dialog-only).
 */
export function isInlineExpenseEditable(
  list: readonly CashExpense[] | undefined,
  date: string,
): boolean {
  const active = (list ?? []).filter(e => !e.deleted);
  if (active.length === 0) return true;
  return active.length === 1 && active[0].id === inlineExpenseId(date);
}

/**
 * Setzt die generische Inline-Barausgabe eines Tages (Betrag = Tages-Total).
 * `amount === null` oder ≤ 0 entfernt sie. Konto-/Text-Anpassungen einer
 * bestehenden Inline-Ausgabe (im Dialog editiert) bleiben erhalten;
 * itemisierte andere Ausgaben werden NIE angefasst (Aufrufer gated via
 * isInlineExpenseEditable).
 */
export function upsertInlineExpense(
  blob: TagesabschlussBlob,
  date: string,
  amount: number | null,
  now: string,
): TagesabschlussBlob {
  const id = inlineExpenseId(date);
  if (amount === null || !Number.isFinite(amount) || amount <= 0) {
    return removeExpense(blob, date, id, now);
  }
  const existing = (blob.expenses[date] ?? []).find(e => e.id === id);
  const next: CashExpense = existing
    // `deleted` bewusst verwerfen: erneutes Setzen reaktiviert den Tombstone.
    ? { ...existing, deleted: undefined, amount: round2(amount), updatedAt: now }
    : {
        id,
        date,
        amount: round2(amount),
        konto: INLINE_EXPENSE_DEFAULT_KONTO,
        text: 'Barausgaben (inline erfasst)',
        updatedAt: now,
      };
  return upsertExpense(blob, next);
}

// ── Import-Abgleich (Z-Bericht-Import vs. manuell korrigierte Werte) ─────────

/**
 * Konflikt zwischen einem manuellen Override und einem neu importierten
 * Z-Bericht-Wert desselben Tags/Felds. Ohne Auflösung GEWINNT der manuelle
 * Wert weiterhin (Overrides sind unabhängig von gn_* — der Import
 * überschreibt nie still).
 */
export interface TagesabschlussImportConflict {
  date: string; // yyyy-MM-dd
  field: TagesabschlussAutoField;
  /** Anzeige-Label des Felds (TAGESABSCHLUSS_FIELD_LABEL). */
  label: string;
  /** Aktuell wirksamer manueller Wert (correctedValue des Overrides). */
  manualValue: number;
  /** Verankertes Erst-Original des Overrides (Wert VOR der ersten Korrektur). */
  originalValue: number;
  /** Neuer Auto-Wert aus dem Import. */
  importValue: number;
  /** Tag ist definitiv abgeschlossen — „Import übernehmen" erfordert Wiederöffnung. */
  dayLocked: boolean;
}

/**
 * Ermittelt alle Konflikte zwischen manuellen Overrides und den Auto-Werten
 * der (neu importierten) Z-Berichte. Kein Konflikt, wenn der Importwert dem
 * manuellen Wert (±0.005) entspricht oder das Feld im Import fehlt.
 */
export function detectTagesabschlussImportConflicts(
  closings: Record<string, GnDayClosing>,
  blob: TagesabschlussBlob,
): TagesabschlussImportConflict[] {
  const out: TagesabschlussImportConflict[] = [];
  for (const date of Object.keys(closings).sort()) {
    const auto = deriveAutoValues(closings[date]);
    const closure = blob.abschluesse[date];
    const dayLocked = !!closure && closure.status !== 'wieder_geoeffnet';
    for (const field of TAGESABSCHLUSS_AUTO_FIELDS) {
      const ov = blob.overrides[makeTagesabschlussFieldKey(date, field)];
      if (!ov || !ov.correctedByManualOverride || ov.deleted) continue;
      const importValue = auto[field];
      if (importValue === null || !Number.isFinite(importValue)) continue;
      if (Math.abs(round2(importValue) - round2(ov.correctedValue)) < 0.005) continue;
      out.push({
        date,
        field,
        label: TAGESABSCHLUSS_FIELD_LABEL[field],
        manualValue: round2(ov.correctedValue),
        originalValue: round2(ov.originalValue),
        importValue: round2(importValue),
        dayLocked,
      });
    }
  }
  return out;
}

export type TagesabschlussImportConflictAction = 'behalten' | 'uebernehmen';

export interface TagesabschlussImportConflictResolution {
  date: string;
  field: TagesabschlussAutoField;
  action: TagesabschlussImportConflictAction;
}

/**
 * Wendet die Konflikt-Entscheidungen an: „uebernehmen" ENTFERNT den
 * manuellen Override — als TOMBSTONE (`deleted: true`, jüngeres updatedAt),
 * denn ein hart gelöschter Key würde beim merge-on-save sofort aus dem
 * Remote-Stand wiederauferstehen; der importierte Auto-Wert gilt wieder.
 * „behalten" ist ein bewusstes No-op. Gesperrte Tage werden defensiv NIE
 * angefasst (Wiederöffnung nötig); Feld-Kommentare bleiben erhalten.
 */
export function applyImportConflictResolutions(
  blob: TagesabschlussBlob,
  resolutions: readonly TagesabschlussImportConflictResolution[],
  now: string,
): TagesabschlussBlob {
  let overrides: TagesabschlussBlob['overrides'] | null = null;
  for (const r of resolutions) {
    if (r.action !== 'uebernehmen') continue;
    const closure = blob.abschluesse[r.date];
    if (closure && closure.status !== 'wieder_geoeffnet') continue;
    const key = makeTagesabschlussFieldKey(r.date, r.field);
    const existing = (overrides ?? blob.overrides)[key];
    if (!existing || existing.deleted) continue;
    overrides = overrides ?? { ...blob.overrides };
    overrides[key] = {
      originalValue: existing.originalValue,
      correctedValue: existing.correctedValue,
      correctedByManualOverride: true,
      deleted: true,
      updatedAt: now,
    };
  }
  return overrides ? { ...blob, overrides } : blob;
}

// ── Export-Einstellungen ─────────────────────────────────────────────────────

/**
 * Default-VORSCHLAG auf Basis des vom Benutzer gelieferten Kontenplans
 * "Kontoplan Oliv" (echte Konten, keine Erfindung). MUSS vor dem ersten
 * Export geprüft werden (`reviewed`-Pflicht in der Export-Validierung).
 */
export function defaultExportSettings(now: string): TagesabschlussExportSettings {
  return {
    konten: {
      kasse: '1000',          // Kasse (Bar)
      bank: '1020',           // UBS Konto (Einzahlungen)
      debitoren: '1100',      // Forderungen (Debitoren / Rechnung)
      gutscheine: '2003',     // Abrechnungs Kto. Gutscheine
      kartenSammel: '1110',   // KK/SIX/Mastercard/Visa/TWINT Sammel
      umsatz: '3000',         // LEGACY — ungenutzt (kein MWST-Modell mehr)
      umsatzTransit: '1098',  // Umsatz BRUTTO (Haben-Seite aller Zahlwege)
    },
    // Mastercard/Visa/Maestro/TWINT bewusst OHNE Einzelkonto → kartenSammel 1110.
    kontoJeZahlungsart: {
      amex: '1114',           // KK AMEX
      postcard: '1116',       // PostCard / PostFinance
      lunch_check: '1115',    // Lunch-Check
      just_eat: '1115',       // Just Eat (gleiches Konto wie Lunch-Check)
      stripe: '1118',         // Stripe
      kd_tisch_5000: '1104',  // KD Tisch 5000 (unklassifizierte Zahlart)
    },
    mwstCodes: {},            // LEGACY — ungenutzt
    kontoBezeichnungen: { ...DEFAULT_KONTO_BEZEICHNUNGEN },
    reviewed: false,
    updatedAt: now,
  };
}

/**
 * Standard-Bezeichnungen je Kontonummer (Kontoplan Oliv) — Fallback für
 * Alt-Settings ohne `kontoBezeichnungen` und Vorbelegung neuer Settings.
 * Anzeige-only: ändert nie die CSV-Bytes.
 */
export const DEFAULT_KONTO_BEZEICHNUNGEN: Readonly<Record<string, string>> = {
  '1000': 'Bargeld',
  '1001': 'Barausgaben',
  '1098': 'Umsatz',
  '1100': 'Debitoren',
  '1104': 'KD Tisch 5000',
  '1110': 'KK SIX',
  '1114': 'KK AMEX',
  '1115': 'Lunch-Check',
  '1116': 'PostCard',
  '1118': 'Stripe',
  '2003': 'Gutscheine',
};

// ── Umsatz-Abgleich: Tagesumsätze-Import vs. Z-Bericht ───────────────────────

/** Standard-Schwelle des Umsatz-Abgleichs in CHF (Spec: 10.00, konfigurierbar). */
export const DEFAULT_UMSATZ_DIFF_SCHWELLE = 10;

/** Effektive Schwelle aus dem Blob (Standard, falls nie konfiguriert/ungültig). */
export function umsatzDiffSchwelle(blob: TagesabschlussBlob): number {
  const v = blob.umsatzDiffSchwelle?.value;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : DEFAULT_UMSATZ_DIFF_SCHWELLE;
}

/** Setzt die Umsatz-Abgleich-Schwelle (null/ungültig = zurück auf Standard). */
export function setUmsatzDiffSchwelle(
  blob: TagesabschlussBlob,
  value: number | null,
  now: string,
): TagesabschlussBlob {
  const valid = value !== null && Number.isFinite(value) && value >= 0;
  return {
    ...blob,
    umsatzDiffSchwelle: valid
      ? { value: round2(value), updatedAt: now }
      // Kein Key-Löschen (merge-Resurrection) — Standardwert explizit setzen:
      : { value: DEFAULT_UMSATZ_DIFF_SCHWELLE, updatedAt: now },
  };
}

export interface UmsatzAbgleich {
  /** Angezeigter Umsatz: Tagesumsätze-Import, sonst Z-Bericht (nur vorhandene Quelle). */
  anzeige: number | null;
  /** Quelle des angezeigten Werts. */
  quelle: 'import' | 'zbericht' | null;
  importWert: number | null;
  zWert: number | null;
  /** Import − Z-Bericht; nur wenn BEIDE Quellen vorliegen. */
  diff: number | null;
  /** Rot-Markierung: beide Quellen vorhanden UND |diff| > Schwelle. */
  rot: boolean;
}

/**
 * Abgleich des Tagesumsatzes: MASSGEBLICH angezeigt wird der Wert aus dem
 * Tagesumsätze-Import (Brutto); der Z-Bericht (Brutto, gleiche Basis) dient
 * als Hintergrund-Kontrolle. Fehlt eine Quelle: nur den vorhandenen Wert
 * zeigen, KEINE Rot-Markierung (leer statt 0, keine Differenz).
 */
export function umsatzAbgleich(
  importWert: number | null,
  zWert: number | null,
  schwelle: number,
): UmsatzAbgleich {
  const anzeige = importWert ?? zWert;
  const quelle = importWert !== null ? 'import' as const : zWert !== null ? 'zbericht' as const : null;
  const diff = importWert !== null && zWert !== null ? round2(importWert - zWert) : null;
  return { anzeige, quelle, importWert, zWert, diff, rot: diff !== null && Math.abs(diff) > schwelle };
}

/** Aktualisiert die Export-Einstellungen im Blob. */
export function setExportSettings(
  blob: TagesabschlussBlob,
  settings: TagesabschlussExportSettings,
): TagesabschlussBlob {
  return { ...blob, exportSettings: settings };
}

// ── Merge zweier Blob-Stände (für merge-on-save, Finanzdaten!) ───────────────

const newer = (a: string | undefined, b: string | undefined): boolean =>
  (a ?? '') >= (b ?? '');

/**
 * Merged den lokalen (zu speichernden) Stand mit einem evtl. neueren
 * Remote-Stand aus dem KV-Backup — je Schlüssel gewinnt der jüngere
 * `updatedAt`. So überschreibt ein Gerät mit veraltetem localStorage nie
 * stillschweigend die Eingaben eines anderen Geräts (kein naiver Blob-Write,
 * gleiches Prinzip wie safeUpsertDailyBudgets).
 */
export function mergeTagesabschlussBlobs(
  local: TagesabschlussBlob,
  remote: TagesabschlussBlob,
): TagesabschlussBlob {
  const days: TagesabschlussBlob['days'] = { ...remote.days };
  for (const [date, day] of Object.entries(local.days)) {
    const r = days[date];
    if (!r || newer(day.updatedAt, r.updatedAt)) days[date] = day;
  }

  const overrides: TagesabschlussBlob['overrides'] = { ...remote.overrides };
  for (const [key, ov] of Object.entries(local.overrides)) {
    const r = overrides[key];
    if (!r || newer(ov.updatedAt, r.updatedAt)) overrides[key] = ov;
  }

  const comments: TagesabschlussBlob['comments'] = { ...remote.comments };
  for (const [key, c] of Object.entries(local.comments)) {
    const r = comments[key];
    if (!r || newer(c.updatedAt, r.updatedAt)) comments[key] = c;
  }

  // Barausgaben: je Ausgabe (id) der jüngere Stand; Vereinigung beider Seiten.
  const byId = new Map<string, CashExpense>();
  for (const list of Object.values(remote.expenses)) {
    for (const e of list) byId.set(e.id, e);
  }
  for (const list of Object.values(local.expenses)) {
    for (const e of list) {
      const r = byId.get(e.id);
      if (!r || newer(e.updatedAt, r.updatedAt)) byId.set(e.id, e);
    }
  }
  const expenses: TagesabschlussBlob['expenses'] = {};
  for (const e of byId.values()) {
    (expenses[e.date] ??= []).push(e);
  }
  for (const list of Object.values(expenses)) {
    list.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
  }

  const cashDiffReasons: TagesabschlussBlob['cashDiffReasons'] = { ...remote.cashDiffReasons };
  for (const [date, entry] of Object.entries(local.cashDiffReasons)) {
    const r = cashDiffReasons[date];
    if (!r || newer(entry.updatedAt, r.updatedAt)) cashDiffReasons[date] = entry;
  }

  const anfangsbestand: TagesabschlussBlob['anfangsbestand'] = { ...remote.anfangsbestand };
  for (const [monthKey, entry] of Object.entries(local.anfangsbestand)) {
    const r = anfangsbestand[monthKey];
    if (!r || newer(entry.updatedAt, r.updatedAt)) anfangsbestand[monthKey] = entry;
  }

  const saldoAnker: TagesabschlussBlob['saldoAnker'] = { ...remote.saldoAnker };
  for (const [date, entry] of Object.entries(local.saldoAnker)) {
    const r = saldoAnker[date];
    if (!r || newer(entry.updatedAt, r.updatedAt)) saldoAnker[date] = entry;
  }

  // Tagesabschlüsse: Skalar-Felder gewinnt der jüngere Stand, die Historie
  // ist ein Audit-Trail und wird VEREINIGT (dedupliziert nach at+action+by,
  // chronologisch sortiert) — winner-takes-all würde Einträge eines anderen
  // Geräts still verwerfen.
  const abschluesse: TagesabschlussBlob['abschluesse'] = { ...remote.abschluesse };
  for (const [date, entry] of Object.entries(local.abschluesse)) {
    const r = abschluesse[date];
    if (!r) { abschluesse[date] = entry; continue; }
    const winner = newer(entry.updatedAt, r.updatedAt) ? entry : r;
    abschluesse[date] = { ...winner, history: mergeClosureHistories(entry.history, r.history) };
  }

  const monatsabschluesse: TagesabschlussBlob['monatsabschluesse'] = { ...remote.monatsabschluesse };
  for (const [monthKey, entry] of Object.entries(local.monatsabschluesse)) {
    const r = monatsabschluesse[monthKey];
    if (!r || newer(entry.updatedAt, r.updatedAt)) monatsabschluesse[monthKey] = entry;
  }

  const exportSettings =
    local.exportSettings && remote.exportSettings
      ? (newer(local.exportSettings.updatedAt, remote.exportSettings.updatedAt)
          ? local.exportSettings
          : remote.exportSettings)
      : local.exportSettings ?? remote.exportSettings;

  // Export-Protokolle: write-once-Records → Union je Export-ID (jüngster gewinnt).
  const exportProtokolle: TagesabschlussBlob['exportProtokolle'] = { ...remote.exportProtokolle };
  for (const [id, rec] of Object.entries(local.exportProtokolle)) {
    const r = exportProtokolle[id];
    if (!r || newer(rec.updatedAt, r.updatedAt)) exportProtokolle[id] = rec;
  }

  const umsatzDiffSchwelle =
    local.umsatzDiffSchwelle && remote.umsatzDiffSchwelle
      ? (newer(local.umsatzDiffSchwelle.updatedAt, remote.umsatzDiffSchwelle.updatedAt)
          ? local.umsatzDiffSchwelle
          : remote.umsatzDiffSchwelle)
      : local.umsatzDiffSchwelle ?? remote.umsatzDiffSchwelle;

  return {
    days, expenses, overrides, comments, cashDiffReasons, anfangsbestand,
    saldoAnker, abschluesse, monatsabschluesse, exportSettings, exportProtokolle,
    umsatzDiffSchwelle,
  };
}

/** Union zweier Abschluss-Historien, dedupliziert nach (at, action, by), chronologisch. */
export function mergeClosureHistories(
  a: readonly ClosureHistoryEntry[],
  b: readonly ClosureHistoryEntry[],
): ClosureHistoryEntry[] {
  const byKey = new Map<string, ClosureHistoryEntry>();
  for (const h of [...a, ...b]) {
    byKey.set(`${h.at}|${h.action}|${h.by}`, h);
  }
  return [...byKey.values()].sort((x, y) => x.at.localeCompare(y.at));
}

// ── Tages-/Monatsabschluss (rein, immutabel) ─────────────────────────────────

export interface CloseDayCheck {
  ok: boolean;
  /** Menschentaugliche Blocker-Liste (leer bei ok). */
  blockers: string[];
}

/** Gate für eine Bestätigungs-Checkbox: ok oder Grund fürs Sperren (Tooltip). */
export interface ConfirmCheckboxGate {
  ok: boolean;
  /** Anzeigbarer Sperr-Grund (nur bei !ok). */
  reason?: string;
}

/**
 * «Bar kontrolliert» darf erst AKTIVIERT werden, wenn BAR IST (gezählter
 * Kassenbestand) erfasst ist. Reines Aktivierungs-Gate — ein bereits
 * gesetztes Häkchen bleibt IMMER entfernbar (Audit beim Entfernen).
 */
export function canCheckBarKontrolliert(row: TagesabschlussRow): ConfirmCheckboxGate {
  if (row.locked) return { ok: false, reason: 'Tag ist bereits abgeschlossen.' };
  if (row.cashIst === null) return { ok: false, reason: 'BAR IST muss zuerst erfasst werden.' };
  return { ok: true };
}

/**
 * «Tagesabschluss geprüft» darf erst AKTIVIERT werden, wenn alle
 * Pflichtwerte vorhanden sind: Z-Bericht + BAR IST + Kassensaldo bekannt.
 * Die weitergehenden Validierungen (Differenz begründet etc.) prüft
 * weiterhin AUSSCHLIESSLICH canCloseDay für den Abschließen-Button —
 * keine doppelte Statuslogik.
 */
export function canCheckAbschlussGeprueft(row: TagesabschlussRow): ConfirmCheckboxGate {
  if (row.locked) return { ok: false, reason: 'Tag ist bereits abgeschlossen.' };
  if (!row.hasZbericht || row.cashIst === null || row.kassensaldoSoll === null) {
    return { ok: false, reason: 'Es fehlen noch Pflichtwerte.' };
  }
  return { ok: true };
}

/**
 * Vorbedingungen für „Tagesabschluss abschließen":
 * Z-Bericht + Tagesbestätigung (Adyen geprüft/begründet via canConfirmDay)
 * + Barbestand gezählt + Cash Ist erfasst + Kassensaldo bekannt +
 * Cash-Differenz grün ODER begründet. Bereits gesperrte Tage: nicht erneut.
 */
export function canCloseDay(row: TagesabschlussRow): CloseDayCheck {
  const blockers: string[] = [];
  if (row.locked) blockers.push('Tag ist bereits abgeschlossen.');
  if (!row.hasZbericht) blockers.push('Kein Z-Bericht vorhanden.');
  if (row.confirmation?.confirmed !== true) {
    blockers.push('«Tagesabschluss geprüft» nicht bestätigt.');
  }
  if (row.confirmation?.cashCounted !== true) blockers.push('«Bar kontrolliert» nicht bestätigt.');
  if (row.cashIst === null) blockers.push('BAR IST (gezählter Kassenbestand) fehlt.');
  if (row.kassensaldoSoll === null) blockers.push('Kassensaldo unbekannt (Anfangsbestand fehlt).');
  if (row.cashDiff !== null && row.cashDiffStatus !== 'ok' && !row.cashDiffBegruendet) {
    blockers.push('Kassendifferenz weder grün noch begründet.');
  }
  return { ok: blockers.length === 0, blockers };
}

/**
 * Schließt einen Tag definitiv ab: Status (mit/ohne Differenz), Benutzer,
 * Zeitstempel, fixierter Kassensaldo, Historie-Eintrag. Wirft bei verletzten
 * Vorbedingungen (canCloseDay) — kein stiller Teil-Abschluss.
 */
export function closeDay(
  blob: TagesabschlussBlob,
  row: TagesabschlussRow,
  user: string,
  now: string,
): TagesabschlussBlob {
  const check = canCloseDay(row);
  if (!check.ok) {
    throw new Error(`Tagesabschluss ${row.date} nicht möglich: ${check.blockers.join(' ')}`);
  }
  const status: DayClosureStatus =
    row.cashDiffStatus === 'ok' ? 'abgeschlossen' : 'abgeschlossen_mit_differenz';
  const prev = blob.abschluesse[row.date];
  const entry: ClosureHistoryEntry = { at: now, by: user, action: 'abschluss', status };
  const next: DayClosure = {
    status,
    closedAt: now,
    closedBy: user,
    fixedKassensaldo: row.kassensaldoSoll,
    updatedAt: now,
    history: mergeClosureHistories(prev?.history ?? [], [entry]),
  };
  return { ...blob, abschluesse: { ...blob.abschluesse, [row.date]: next } };
}

/**
 * Öffnet einen abgeschlossenen Tag wieder (nur Admin — UI-seitig zu gaten).
 * Grund ist PFLICHT. Der Record bleibt bestehen (Status-Flag statt Löschung —
 * merge-on-save würde gelöschte Keys wiederbeleben); Historie wächst.
 */
export function reopenDay(
  blob: TagesabschlussBlob,
  date: string,
  user: string,
  reason: string,
  now: string,
): TagesabschlussBlob {
  const prev = blob.abschluesse[date];
  if (!prev || prev.status === 'wieder_geoeffnet') {
    throw new Error(`Tag ${date} ist nicht abgeschlossen.`);
  }
  const trimmed = reason.trim();
  if (trimmed === '') throw new Error('Wiederöffnungsgrund ist Pflicht.');
  const entry: ClosureHistoryEntry = { at: now, by: user, action: 'wiederoeffnung', reason: trimmed };
  const next: DayClosure = {
    ...prev,
    status: 'wieder_geoeffnet',
    reopenedAt: now,
    reopenedBy: user,
    reopenReason: trimmed,
    updatedAt: now,
    history: mergeClosureHistories(prev.history, [entry]),
  };
  return { ...blob, abschluesse: { ...blob.abschluesse, [date]: next } };
}

/** Aktiver Monatsabschluss (wieder geöffnete zählen nicht). */
export function isMonthClosed(blob: TagesabschlussBlob, monthKey: string): boolean {
  return blob.monatsabschluesse[monthKey]?.status === 'abgeschlossen';
}

export interface CloseMonthCheck {
  ok: boolean;
  blockers: string[];
}

/**
 * Monatsabschluss möglich, wenn JEDER Tag mit Z-Bericht definitiv
 * abgeschlossen ist (kein offener/in Bearbeitung/wieder geöffneter Tag)
 * und mindestens ein Tag existiert.
 */
export function canCloseMonth(month: TagesabschlussMonth, alreadyClosed: boolean): CloseMonthCheck {
  const blockers: string[] = [];
  if (alreadyClosed) blockers.push('Monat ist bereits abgeschlossen.');
  if (month.totals.daysWithZbericht === 0) blockers.push('Keine Tagesabschlüsse (Z-Berichte) im Monat.');
  const notClosed = month.rows.filter(r =>
    r.hasZbericht && r.status !== 'abgeschlossen' && r.status !== 'abgeschlossen_mit_differenz',
  ).length;
  if (notClosed > 0) blockers.push(`${notClosed} Tag(e) noch nicht abgeschlossen.`);
  return { ok: blockers.length === 0, blockers };
}

/** Eingefrorene Monats-Kennzahlen aus der aktuellen Monatsansicht. */
export function buildMonthClosureSnapshot(month: TagesabschlussMonth): MonthClosureSnapshot {
  return {
    anfangsbestand: month.startSaldo,
    endbestand: month.endSaldo,
    umsatzTotal: month.totals.values.umsatz,
    bargeldTotal: month.totals.bargeldSoll,
    barausgabenTotal: month.totals.barausgaben,
    bankeinzahlungenTotal: month.totals.values.einzahlungBank,
    cashDiffTotal: month.totals.cashDiffTotal,
    begruendeteDifferenzen: month.totals.daysBegruendet,
  };
}

/** Schließt einen Monat ab (Snapshot wird JETZT eingefroren). */
export function closeMonth(
  blob: TagesabschlussBlob,
  monthKey: string,
  month: TagesabschlussMonth,
  user: string,
  now: string,
): TagesabschlussBlob {
  const check = canCloseMonth(month, isMonthClosed(blob, monthKey));
  if (!check.ok) {
    throw new Error(`Monatsabschluss ${monthKey} nicht möglich: ${check.blockers.join(' ')}`);
  }
  const next: MonthClosure = {
    status: 'abgeschlossen',
    closedAt: now,
    closedBy: user,
    snapshot: buildMonthClosureSnapshot(month),
    updatedAt: now,
  };
  return { ...blob, monatsabschluesse: { ...blob.monatsabschluesse, [monthKey]: next } };
}

/**
 * Öffnet einen abgeschlossenen Monat wieder (nur Admin — UI-seitig zu gaten).
 * Status-Flag statt Key-Löschung (merge-Resurrection); die Tagesabschlüsse
 * bleiben unberührt.
 */
export function reopenMonth(
  blob: TagesabschlussBlob,
  monthKey: string,
  user: string,
  now: string,
): TagesabschlussBlob {
  const prev = blob.monatsabschluesse[monthKey];
  if (!prev || prev.status !== 'abgeschlossen') {
    throw new Error(`Monat ${monthKey} ist nicht abgeschlossen.`);
  }
  const next: MonthClosure = {
    ...prev,
    status: 'wieder_geoeffnet',
    reopenedAt: now,
    reopenedBy: user,
    updatedAt: now,
  };
  return { ...blob, monatsabschluesse: { ...blob.monatsabschluesse, [monthKey]: next } };
}

/**
 * „Bereit für Buchhaltung": alle Tage mit Z-Bericht definitiv abgeschlossen,
 * keine offenen/in Bearbeitung/wieder geöffneten Tage, keine unbegründeten
 * Differenzen.
 */
export function readyForBuchhaltung(month: TagesabschlussMonth): boolean {
  return month.totals.daysWithZbericht > 0
    && month.totals.daysConfirmed === month.totals.daysWithZbericht
    && month.totals.daysOpen === 0
    && month.totals.daysInBearbeitung === 0
    && month.totals.daysWiederGeoeffnet === 0
    && month.totals.daysUnbegruendet === 0;
}

// ── Kassensaldo-Kette über Monatsgrenzen ─────────────────────────────────────

/** Monats-Schlüssel yyyy-MM (Key für `anfangsbestand`). */
export function tagesabschlussMonthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** Folgemonat von (year, month). */
export function nextMonthOf(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

/**
 * Endsaldo eines Monats — EXAKT dieselbe Rechenbasis wie die Monatsansicht
 * (buildTagesabschlussRows inkl. Overrides/Barausgaben), nur ohne Adyen.
 * null bei startSaldo null OHNE Kassensaldo-Tagesanker im Monat.
 */
export function computeMonthEndSaldo(
  year: number,
  month: number,
  closings: Record<string, GnDayClosing>,
  blob: TagesabschlussBlob,
  startSaldo: number | null,
): number | null {
  // Auch mit unbekanntem Startsaldo durchrechnen: ein manueller
  // Kassensaldo-Tagesanker im Monat re-based die Kette und liefert einen
  // Endsaldo — ohne Anker bleibt das Ergebnis null (nie stille 0).
  return buildTagesabschlussRows(year, month, closings, blob, {}, null, startSaldo).endSaldo;
}

/**
 * Sicherheitskappe der Vorwärts-Kette Anker → Zielmonat (10 Jahre). Reine
 * Schutzgrenze gegen pathologische Distanzen — KEIN fachliches Monats-Limit:
 * der Kassensaldo läuft über Monats- UND Jahreswechsel lückenlos weiter.
 */
export const KASSENSALDO_MAX_CHAIN_MONTHS = 120;

export interface KassensaldoStartResolution {
  /** Kassensaldo (Soll) zu Monatsbeginn; null = kein Anker gefunden. */
  startSaldo: number | null;
  /** Monat (yyyy-MM), dessen expliziter Anfangsbestand als Anker diente. */
  anchorMonth: string | null;
}

/**
 * Ermittelt den Kassensaldo zu Monatsbeginn — fortlaufende Kasse über ALLE
 * Monate und Jahre (Monats-/Jahreswechsel setzen NIE zurück):
 * 1. Expliziter Anfangsbestand für DIESEN Monat gewinnt sofort (kein Load).
 * 2. Sonst wird der JÜNGSTE frühere Monat mit explizitem Anfangsbestand
 *    synchron aus den Blob-Schlüsseln bestimmt (yyyy-MM sortiert
 *    lexikografisch = chronologisch) und die Kette von dort VORWÄRTS bis zum
 *    Zielmonat durchgerechnet (je Monat 1 `loadClosings`-Aufruf, identische
 *    Rechenbasis wie die Monatsansicht inkl. Overrides/Barausgaben). Monate
 *    ganz ohne Daten laufen als 0-Beitrag einfach durch — auch geschlossene
 *    Monate oder der Jahreswechsel unterbrechen die Kette nicht.
 * 3. Existiert nirgends ein früherer Anfangsbestand → null: der Benutzer
 *    muss EINMALIG einen Kassen-Anfangsbestand erfassen. KEINE stille 0.
 * Da alles aus den Rohdaten abgeleitet ist, rechnet eine Änderung an einem
 * alten Tag automatisch alle nachfolgenden Salden neu (keine Persistenz von
 * Zwischenständen).
 */
export async function resolveKassensaldoStart(
  year: number,
  month: number,
  blob: TagesabschlussBlob,
  loadClosings: (year: number, month: number) => Promise<Record<string, GnDayClosing>>,
): Promise<KassensaldoStartResolution> {
  const ownKey = tagesabschlussMonthKey(year, month);
  const own = blob.anfangsbestand[ownKey];
  if (own && !own.deleted) return { startSaldo: round2(own.value), anchorMonth: ownKey };

  // Anker-Kandidaten: Monate mit explizitem Anfangsbestand UND Monate mit
  // manuellem Kassensaldo-Tagesanker (Inline-Korrektur) — beide setzen die
  // Kette auf einen bekannten Wert und tragen sie in Folgemonate.
  // Tombstones (deleted) sind KEINE Kandidaten.
  const anchorKey = [
    ...Object.entries(blob.anfangsbestand)
      .filter(([, entry]) => !entry.deleted)
      .map(([k]) => k),
    ...Object.entries(blob.saldoAnker)
      .filter(([, entry]) => !entry.deleted)
      .map(([d]) => d.slice(0, 7)),
  ]
    .filter(k => k < ownKey)
    .sort()
    .pop();
  if (!anchorKey) return { startSaldo: null, anchorMonth: null };

  const [ay, am] = anchorKey.split('-').map(Number);
  let cur = { year: ay, month: am };
  // Ohne expliziten Anfangsbestand startet der Anker-Monat mit null — der
  // Tagesanker im Monat re-based die Kette (computeMonthEndSaldo rechnet
  // auch mit null-Start durch).
  const anchorEntry = blob.anfangsbestand[anchorKey];
  let saldo: number | null = anchorEntry && !anchorEntry.deleted
    ? round2(anchorEntry.value)
    : null;

  for (let i = 0; i < KASSENSALDO_MAX_CHAIN_MONTHS; i++) {
    if (cur.year === year && cur.month === month) {
      return { startSaldo: round2(saldo as number), anchorMonth: anchorKey };
    }
    const closings = await loadClosings(cur.year, cur.month);
    saldo = computeMonthEndSaldo(cur.year, cur.month, closings, blob, saldo);
    if (saldo === null) return { startSaldo: null, anchorMonth: null };
    cur = nextMonthOf(cur.year, cur.month);
  }
  // Schutzkappe erreicht (Anker unrealistisch weit weg) — kein stiller Wert.
  return { startSaldo: null, anchorMonth: null };
}
