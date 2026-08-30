/**
 * waren-monatsabgleich — Lieferschein → Monatsrechnung: Abgleich & Ersetzen.
 * ==========================================================================
 * Workflow (Dual-Modell, siehe waren-db.ts InvoiceEntry.quelle):
 *  - Lieferscheine sind PROVISORISCH (quelle fehlt oder 'auftragsbestaetigung'),
 *    tragen das LIEFERDATUM und fliessen sofort in Tages-/Wochen-Ansichten.
 *  - Die Monatsrechnung ist MASSGEBLICH. Beim Erfassen wird Σ der
 *    provisorischen Lieferscheine des Lieferanten/Monats gegen das
 *    Monatsrechnungs-Total gestellt; der User entscheidet PRO LIEFERANT:
 *      · übernehmen → Original-Lieferscheine bleiben als unveränderte
 *        Revisionshistorie erhalten, werden aber als ersetzt markiert. Genau
 *        EINE autoritative Monatsrechnung zählt wirtschaftlich.
 *      · nicht übernehmen → Lieferscheine bleiben unverändert massgeblich,
 *        Status «Differenz offen»; die Monatsrechnung wird NICHT gespeichert.
 *  - Die ältere skalierende Legacy-Funktion bleibt nur für kompatible
 *    Aufrufer/Tests bestehen; produktive Kreditorenpfade verwenden das
 *    historienerhaltende Modell.
 *
 * Pure Lib: keine IO, deterministisch, ÷0-sicher.
 */
import type { InvoiceEntry } from './waren-db';
import { istErsetzt } from './waren-supersession';
export { istErsetzt } from './waren-supersession';

export type DifferenzModus = 'rechnungsdatum' | 'anteilig';
export type LieferantAbgleichStatus = 'provisorisch' | 'abgeglichen' | 'differenz_offen';

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Ein Lieferschein wird beim neuen, historienerhaltenden Monatsabgleich nicht
 * gelöscht oder umdatiert. Stattdessen verweist er auf die Monatsrechnung.
 * Das explizite Flag ist massgeblich; die ID-Prüfung unterstützt Einträge, die
 * während einer frühen Einführung nur mit der Herkunftsreferenz gespeichert
 * wurden.
 */
/** Englischer Alias für Import-/Auswertungs-Code ausserhalb der deutschen UI. */
export const isSuperseded = istErsetzt;

/** Alle und nur die wirtschaftlich massgeblichen Einträge. Alt-Daten zählen. */
export function zaehlendeEintraege(entries: InvoiceEntry[]): InvoiceEntry[] {
  return entries.filter(e => !istErsetzt(e));
}

/** Englischer Alias für Import-/Auswertungs-Code ausserhalb der deutschen UI. */
export const countingEntries = zaehlendeEintraege;

/**
 * Stabile Namensbasis für die bekannte Firmenumbenennung WKQ → Fideco.
 * Andere Lieferanten werden nur firmenform-/zeichenbereinigt zurückgegeben.
 */
export function kanonischerWarenLieferant(name: string): string {
  const normal = name.toLowerCase()
    .replace(/\b(ag|gmbh|sa|sagl|co|cie|kg)\b\.?/g, '')
    .replace(/[^a-zäöüéèàç0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normal.includes('fideco') || normal === 'wkq' || normal.startsWith('wkq ')) return 'fideco';
  return normal;
}

/** Gemeinsamer Gruppenschlüssel für alle Monatsrechnungs-Einstiegspfade. */
export function kanonischerLieferantMonatKey(
  monat: string,
  supplierName: string,
  canonicalize: (name: string) => string = kanonischerWarenLieferant,
): string {
  return `${monat}\u0000${canonicalize(supplierName)}`;
}

/**
 * Referenz-Dublette für Import-Vorschauen. Revisionshistorie zählt nie als
 * aktive Dublette; Firmenwechsel/Aliasse verwenden dieselbe Kanonisierung wie
 * der Schreibkern.
 */
export function hatZaehlendeLieferantenReferenz(
  entries: InvoiceEntry[],
  supplierName: string,
  refs: Set<string>,
  canonicalize: (name: string) => string = kanonischerWarenLieferant,
): boolean {
  const supplier = canonicalize(supplierName);
  return zaehlendeEintraege(entries).some(entry =>
    canonicalize(entry.supplierName) === supplier
    && Boolean(entry.reference)
    && refs.has(entry.reference!.trim().toLowerCase()));
}

export interface LiefermonatAufloesung {
  /** null = mehrere Monate enthalten passende provisorische Lieferscheine. */
  monat: string | null;
  hatLieferscheine: boolean;
}

/**
 * Löst den Liefermonat einer Kreditoren-Monatsrechnung aus einem begrenzten,
 * vom Aufrufer geladenen Monatsfenster. Nur genau ein passender Monat darf
 * automatisch gewählt werden; mehrere Monate sind fail-closed.
 */
export function loeseEindeutigenLiefermonatAuf(input: {
  buchungsmonat: string;
  bestandByMonat: Map<string, InvoiceEntry[]>;
  matcht: (supplierName: string) => boolean;
}): LiefermonatAufloesung {
  const trefferMonate = [...input.bestandByMonat.entries()]
    .filter(([, entries]) => entries.some(entry =>
      istProvisorischerLieferschein(entry) && input.matcht(entry.supplierName)))
    .map(([monat]) => monat)
    .sort();
  if (trefferMonate.length > 1) return { monat: null, hatLieferscheine: true };
  if (trefferMonate.length === 1) return { monat: trefferMonate[0], hatLieferscheine: true };
  return { monat: input.buchungsmonat, hatLieferscheine: false };
}

export interface LieferantMonatsGruppe {
  /** Vom Aufrufer bestimmte, stabile Lieferantenbezeichnung. */
  lieferant: string;
  /** Liefermonat aus dem Beleg-/Lieferdatum, nie aus dem Erfassungszeitpunkt. */
  monat: string;
  /** Ausschliesslich wirtschaftlich zählende Einträge dieser Gruppe. */
  entries: InvoiceEntry[];
}

/**
 * Gruppiert zählende Einträge nach kanonischem Lieferanten und Liefermonat.
 * Die Kanonisierung wird bewusst injiziert: Alias-Regeln gehören zum
 * Lieferantenprofil und nicht in dieses persistence-nahe, reine Modul.
 */
export function gruppiereNachKanonischemLieferantUndMonat(
  entries: InvoiceEntry[],
  canonicalize: (supplierName: string) => string,
): Map<string, LieferantMonatsGruppe> {
  const gruppen = new Map<string, LieferantMonatsGruppe>();
  for (const entry of zaehlendeEintraege(entries)) {
    const lieferant = canonicalize(entry.supplierName);
    const monat = entry.date.slice(0, 7);
    const key = `${lieferant}\u0000${monat}`;
    const gruppe = gruppen.get(key);
    if (gruppe) gruppe.entries.push(entry);
    else gruppen.set(key, { lieferant, monat, entries: [entry] });
  }
  return gruppen;
}

/** Kürzerer Alias für Verbraucher, die die kanonische Eigenschaft kennen. */
export const gruppiereLieferantMonat = gruppiereNachKanonischemLieferantUndMonat;

/**
 * Provisorischer Lieferschein im Sinne des Abgleichs: regulär erfasst
 * (quelle fehlt) oder Auftragsbestätigung — und noch nicht finalisiert.
 * FIBU-/Kreditoren-Übernahmen sind KEINE Lieferscheine (sie repräsentieren
 * bereits Buchhaltungs-Totale), finalisierte Einträge sind abgeschlossen.
 */
export function istProvisorischerLieferschein(e: InvoiceEntry): boolean {
  if (istErsetzt(e) || e.final === true) return false;
  return e.quelle == null || e.quelle === 'auftragsbestaetigung';
}

export interface MonatsAbgleichVorschau {
  /** Lieferschein-Einträge (provisorisch) des Lieferanten im Monat. */
  lieferscheine: InvoiceEntry[];
  sigmaNet: number;
  sigmaGross: number;
  /** Monatsrechnungs-Total minus Σ Lieferscheine (netto). */
  differenzNet: number;
  differenzGross: number;
  /** Differenz in % der Lieferschein-Summe; null wenn Σ = 0 (nie ÷0). */
  differenzPct: number | null;
}

/**
 * Vorschau für EINEN Lieferanten/Monat: Σ provisorische Lieferscheine gegen
 * das Monatsrechnungs-Total. `matcht` entscheidet die Lieferanten-Zugehörigkeit
 * (Aufrufer kann Alias-Gruppen/`lieferantVerwandt` einsetzen).
 */
export function baueMonatsAbgleich(input: {
  bestand: InvoiceEntry[];
  monat: string; // YYYY-MM
  totalNet: number;
  totalGross: number;
  matcht: (supplierName: string) => boolean;
}): MonatsAbgleichVorschau {
  const lieferscheine = input.bestand.filter(e =>
    e.date.slice(0, 7) === input.monat
    && istProvisorischerLieferschein(e)
    && input.matcht(e.supplierName));
  const sigmaNet = r2(lieferscheine.reduce((s, e) => s + e.amountNet, 0));
  const sigmaGross = r2(lieferscheine.reduce((s, e) => s + e.amountGross, 0));
  const differenzNet = r2(input.totalNet - sigmaNet);
  const differenzGross = r2(input.totalGross - sigmaGross);
  return {
    lieferscheine, sigmaNet, sigmaGross, differenzNet, differenzGross,
    differenzPct: sigmaNet > 0 ? (differenzNet / sigmaNet) * 100 : null,
  };
}

/** Beschreibung der massgeblichen Monatsrechnung für den Ersetzungs-Schritt. */
export interface MonatsrechnungInfo {
  /** Rechnungs-/Belegdatum (YYYY-MM-DD) — Ziel der Differenz bei Modus 'rechnungsdatum'. */
  datum: string;
  referenz?: string;
  totalNet: number;
  totalGross: number;
  /** Warenkonto der Differenz-Buchung (Fallback: Konto des ersten Lieferscheins). */
  warenkonto?: string;
  vatRate?: number;
}

/**
 * Akzeptiert eine Monatsrechnung im historienerhaltenden Modell.
 *
 * Anders als der ältere `wendeMonatsrechnungAn` werden Lieferbelege weder
 * skaliert noch mit Korrekturen ergänzt: ihre ursprünglichen Daten und Beträge
 * bleiben auditierbar. Sie werden bloss als ersetzt markiert; die angehängte
 * Monatsrechnung ist damit der einzige zählende Betrag dieser
 * Lieferant-/Liefermonat-Gruppe.
 */
export function akzeptiereMonatsrechnung(input: {
  bestand: InvoiceEntry[];
  /** Liefermonat (YYYY-MM), bewusst explizit, da Rechnungs- und Liefermonat abweichen können. */
  liefermonat: string;
  /** Die bereits vollständig gebaute, autoritative Monatsrechnung. */
  monatsrechnung: InvoiceEntry;
  canonicalize: (supplierName: string) => string;
  now: string;
}): InvoiceEntry[] {
  const { bestand, liefermonat, monatsrechnung, canonicalize, now } = input;
  const canonicalSupplier = canonicalize(monatsrechnung.supplierName);
  const authoritative: InvoiceEntry = {
    ...monatsrechnung,
    quelle: 'monatsrechnung',
    final: true,
    superseded: false,
    updatedAt: now,
  };
  let vorhanden = false;
  const out = bestand.map(entry => {
    if (entry.id === authoritative.id) {
      vorhanden = true;
      return authoritative;
    }
    const belongsToMonth = entry.date.slice(0, 7) === liefermonat;
    const belongsToSupplier = canonicalize(entry.supplierName) === canonicalSupplier;
    if (!belongsToMonth || !belongsToSupplier || !istProvisorischerLieferschein(entry)) return entry;
    // Do not touch amount/date/note: the delivery note remains its original record.
    return {
      ...entry,
      superseded: true,
      supersededById: authoritative.id,
      ...(authoritative.reference ? { supersededByReference: authoritative.reference } : {}),
      updatedAt: now,
    };
  });
  if (!vorhanden) out.push(authoritative);
  return out;
}

/** Englischer Alias for persistence/import callers. */
export const acceptMonthlyInvoice = akzeptiereMonatsrechnung;

/**
 * Übernehmen: ersetzt die provisorischen Lieferscheine wirtschaftlich durch die
 * Monatsrechnung — Σ des Lieferanten/Monats == Monatsrechnungs-Total, die
 * Tages-Granularität der Lieferscheine bleibt für Wochen-Ansichten erhalten.
 *  - 'anteilig':       jeder Lieferschein wird mit Faktor total/Σ skaliert
 *                      (letzter Eintrag nimmt den Rundungsrest — Σ exakt).
 *  - 'rechnungsdatum': Lieferscheine bleiben, die Differenz wird als eigener
 *                      Korrektur-Eintrag am Rechnungsdatum gebucht (entfällt
 *                      bei Differenz < 1 Rappen).
 * Rückgabe: NEUER Monatsbestand (Eingaben unverändert). Die Monatsrechnung
 * selbst wird NICHT als zusätzlicher Eintrag angefügt.
 */
export function wendeMonatsrechnungAn(input: {
  bestand: InvoiceEntry[];
  vorschau: MonatsAbgleichVorschau;
  rechnung: MonatsrechnungInfo;
  modus: DifferenzModus;
  now: string;
}): InvoiceEntry[] {
  const { bestand, vorschau, rechnung, modus, now } = input;
  const ids = new Set(vorschau.lieferscheine.map(e => e.id));
  const abgleichNote = `Monatsabgleich${rechnung.referenz ? ` Rg. ${rechnung.referenz}` : ''}`;

  // Kein Lieferschein vorhanden → nichts zu ersetzen; Aufrufer speichert die
  // Monatsrechnung regulär selbst (hier bewusst unverändert zurück).
  if (vorschau.lieferscheine.length === 0) return bestand.slice();

  if (modus === 'anteilig' && vorschau.sigmaNet > 0) {
    const fNet = rechnung.totalNet / vorschau.sigmaNet;
    const fGross = vorschau.sigmaGross > 0 ? rechnung.totalGross / vorschau.sigmaGross : fNet;
    let restNet = rechnung.totalNet;
    let restGross = rechnung.totalGross;
    const letzteId = vorschau.lieferscheine[vorschau.lieferscheine.length - 1].id;
    return bestand.map(e => {
      if (!ids.has(e.id)) return e;
      const istLetzter = e.id === letzteId;
      const net = istLetzter ? r2(restNet) : r2(e.amountNet * fNet);
      const gross = istLetzter ? r2(restGross) : r2(e.amountGross * fGross);
      if (!istLetzter) { restNet = r2(restNet - net); restGross = r2(restGross - gross); }
      return {
        ...e, amountNet: net, amountGross: gross,
        final: true, abgleichStatus: 'abgeglichen' as const,
        note: e.note ? `${e.note} · ${abgleichNote}` : abgleichNote,
        updatedAt: now,
      };
    });
  }

  // Modus 'rechnungsdatum' (auch Fallback wenn Σ=0): Lieferscheine bleiben,
  // Differenz als Korrektur-Eintrag am Rechnungsdatum.
  const out: InvoiceEntry[] = bestand.map(e => ids.has(e.id)
    ? {
        ...e, final: true, abgleichStatus: 'abgeglichen' as const,
        note: e.note ? `${e.note} · ${abgleichNote}` : abgleichNote,
        updatedAt: now,
      }
    : e);
  if (Math.abs(vorschau.differenzNet) >= 0.005 || Math.abs(vorschau.differenzGross) >= 0.005) {
    const vorlage = vorschau.lieferscheine[0];
    out.push({
      id: `mabgl_${rechnung.datum}_${(rechnung.referenz ?? 'x')}_${vorlage.id.slice(-6)}`,
      date: rechnung.datum,
      supplierName: vorlage.supplierName,
      amountGross: vorschau.differenzGross,
      amountNet: vorschau.differenzNet,
      vatIncluded: true,
      vatRate: rechnung.vatRate ?? vorlage.vatRate,
      reference: rechnung.referenz,
      warenkonto: rechnung.warenkonto ?? vorlage.warenkonto,
      kategorie: vorlage.kategorie,
      note: `${abgleichNote} — Differenz (Rabatt/Korrektur/Retoure)`,
      quelle: 'monatsrechnung',
      final: true,
      abgleichStatus: 'abgeglichen',
      createdAt: now,
      updatedAt: now,
    });
  }
  return out;
}

/**
 * Nicht übernehmen: Lieferscheine bleiben massgeblich, werden aber als
 * «Differenz offen» markiert (sichtbarer Status, keine Betragsänderung).
 */
export function markiereDifferenzOffen(
  bestand: InvoiceEntry[],
  lieferscheine: InvoiceEntry[],
  now: string,
): InvoiceEntry[] {
  const ids = new Set(lieferscheine.map(e => e.id));
  return bestand.map(e => ids.has(e.id)
    ? { ...e, abgleichStatus: 'differenz_offen' as const, updatedAt: now }
    : e);
}

/**
 * Status eines Lieferanten für die Monats-/Cockpit-Ansicht:
 *  - 'differenz_offen' sobald ein Eintrag offen markiert ist,
 *  - 'provisorisch' solange unabgeglichene Lieferscheine existieren,
 *  - sonst 'abgeglichen' (finalisierte/übernommene Buchungen).
 */
export function lieferantStatus(entries: InvoiceEntry[]): LieferantAbgleichStatus {
  if (entries.some(e => e.abgleichStatus === 'differenz_offen')) return 'differenz_offen';
  if (entries.some(e => istProvisorischerLieferschein(e))) return 'provisorisch';
  return 'abgeglichen';
}
