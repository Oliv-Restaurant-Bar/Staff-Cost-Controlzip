/**
 * map.ts — turns the validated AI reading into the SAME structure an original
 * PDF produces (`ProfilPdfErgebnis` + `ParsedCsvRechnung`), and checks the
 * arithmetic so a misread digit is visible before anything is booked.
 * =============================================================================
 * Rules: never guess (missing stays null), computed values are flagged, the
 * supplier is assigned by the existing lookup (VAT no / name / IBAN) — an unknown
 * supplier stays "Lieferant offen". Nothing here saves anything.
 */
import type { ParsedCsvRechnung, WarenPosition } from '@/lib/waren-positionen';
import type { ProfilPdfErgebnis, MwstKlasse } from '@/lib/profil-pdf-parse';
import { findeProfilImText, type LieferantenProfil } from '@/lib/lieferanten-profile';
import { tr } from '@/lib/unified-import/strings';
import type { KiRechnung } from './schema';

const R2 = (n: number) => Math.round(n * 100) / 100;
/** Legal Swiss rates the existing structures can represent. */
const GESETZLICHE_SAETZE = [0, 2.6, 8.1] as const;
type Satz = (typeof GESETZLICHE_SAETZE)[number];
const istSatz = (n: number | null): n is Satz => n !== null && (GESETZLICHE_SAETZE as readonly number[]).includes(n);
const TOL = 0.05;

export type KiPruefLevel = 'warn' | 'error';
export interface KiPruefung {
  code:
    | 'not-invoice' | 'lines-vs-net' | 'gross-vs-net-vat' | 'classes-vs-net' | 'class-amount'
    | 'lines-vs-classes' | 'line-arithmetic' | 'line-total-computed' | 'line-skipped'
    | 'vat-rate-unknown' | 'no-lines' | 'missing-header' | 'unreadable-note';
  level: KiPruefLevel;
  text: string;
  /** Index into the AI position list, when the finding belongs to one line. */
  position?: number;
}

export interface KiMapErgebnis {
  ergebnis: ProfilPdfErgebnis;
  pruefungen: KiPruefung[];
  /** Per AI position (same order as the model output): true when a check flagged it. */
  positionsFlags: Array<{ warn: boolean }>;
  /** The lines that made it into the result, in document order, with their warning state (for the preview table). */
  zeilen: Array<{ pos: WarenPosition; warn: boolean }>;
}

function supplierText(d: KiRechnung): string {
  // The existing lookup works on text; feed it exactly the identifiers the AI read.
  return [d.lieferant.name, d.lieferant.mwstNr, d.lieferant.iban ? `IBAN ${d.lieferant.iban}` : null]
    .filter(Boolean).join('\n');
}

function mwstKlassenVon(d: KiRechnung): MwstKlasse[] {
  return d.mwstKlassen
    .filter(k => k.satz !== null && k.basis !== null && k.betrag !== null)
    .map(k => ({ satz: k.satz as number, basis: k.basis as number, betrag: k.betrag as number }));
}

export function mappeKiRechnung(d: KiRechnung, profile: LieferantenProfil[]): KiMapErgebnis {
  const pruef: KiPruefung[] = [];
  const hinweise: string[] = [];
  const add = (p: KiPruefung) => { pruef.push(p); };

  const { profil, mwstNrn } = findeProfilImText(supplierText(d), profile);
  const belegart: ProfilPdfErgebnis['belegart'] =
    d.dokumentart === 'rechnung' || d.dokumentart === 'lieferschein' || d.dokumentart === 'sonstiges'
      ? 'rechnung' : d.dokumentart;
  const keineRechnung = d.dokumentart === 'sonstiges' || belegart !== 'rechnung';

  if (keineRechnung) {
    add({
      code: 'not-invoice', level: 'error',
      text: tr(
        'Das Dokument sieht nicht wie eine Rechnung aus (z. B. Auftragsbestätigung/Offerte) — wird nicht gebucht.',
        'The document does not look like an invoice (e.g. order confirmation/offer) — it will not be booked.',
      ),
    });
  }
  // Known mapping: a delivery note is booked like the profile parsers do (provisional delivery).
  // For suppliers whose INVOICE is always the final monthly invoice (see parseProfilPdf: Spahni, Gourmador,
  // Bohnenblust, belegtyp 'monatsrechnung'), an AI-read invoice must be treated the same way — otherwise the
  // preview defaults to a provisional delivery note. Other dual suppliers stay open (user picks in the preview).
  const rechnungIstFinal = !!profil && (profil.belegtyp === 'monatsrechnung' || ['spahni', 'gourmador', 'bohnenblust'].includes(profil.id));
  const dokumenttyp: ProfilPdfErgebnis['dokumenttyp'] =
    d.dokumentart === 'lieferschein' ? 'lieferschein'
    : d.dokumentart === 'rechnung' && rechnungIstFinal ? 'monatsrechnung'
    : null;

  // ── Lines ────────────────────────────────────────────────────────────────
  const rechnungsNr = d.rechnungsNr;
  const kopfDatum = d.lieferdatum ?? d.rechnungsdatum;
  const gruppen = new Map<string, WarenPosition[]>();
  const gruppenMeta = new Map<string, { nr: string; datum: string }>();
  const flags: Array<{ warn: boolean }> = d.positionen.map(() => ({ warn: false }));
  const behalten: Array<{ idx: number; pos: WarenPosition; satz: number | null }> = [];

  d.positionen.forEach((p, idx) => {
    const flag = (pr: KiPruefung) => { flags[idx].warn = true; add(pr); };
    let pp = p.positionspreis;
    if (pp === null && p.menge !== null && p.preis !== null) {
      pp = R2(p.menge * p.preis);
      flag({
        code: 'line-total-computed', level: 'warn', position: idx,
        text: tr(
          `Zeile ${idx + 1} («${p.bezeichnung}»): Betrag fehlte auf dem Beleg und wurde aus Menge × Preis berechnet.`,
          `Line ${idx + 1} («${p.bezeichnung}»): amount missing on the document, computed from quantity × price.`,
        ),
      });
    }
    if (pp === null || !p.bezeichnung) {
      flag({
        code: 'line-skipped', level: 'warn', position: idx,
        text: tr(
          `Zeile ${idx + 1}: ohne Betrag oder Bezeichnung gelesen — übersprungen.`,
          `Line ${idx + 1}: read without amount or description — skipped.`,
        ),
      });
      return;
    }
    const menge = p.menge ?? 1;
    const preis = p.preis ?? (menge !== 0 ? R2(pp / menge) : pp);
    // qty × unit price ≈ line total (unit prices are printed rounded -> relative tolerance)
    if (p.menge !== null && p.preis !== null && Math.abs(p.menge * p.preis - pp) > Math.max(TOL, 0.01 * Math.abs(pp))) {
      flag({
        code: 'line-arithmetic', level: 'warn', position: idx,
        text: tr(
          `Zeile ${idx + 1} («${p.bezeichnung}»): ${p.menge} × ${p.preis} ≠ ${pp} — bitte gegen den Beleg prüfen.`,
          `Line ${idx + 1} («${p.bezeichnung}»): ${p.menge} × ${p.preis} ≠ ${pp} — please check against the document.`,
        ),
      });
    }
    let satz: Satz | undefined;
    if (p.mwstSatz !== null) {
      if (istSatz(p.mwstSatz)) satz = p.mwstSatz;
      else flag({
        code: 'vat-rate-unknown', level: 'warn', position: idx,
        text: tr(
          `Zeile ${idx + 1}: MwSt-Satz ${p.mwstSatz} % ist kein aktueller Schweizer Satz (0 / 2.6 / 8.1) — MwSt dieser Zeile bitte prüfen.`,
          `Line ${idx + 1}: VAT rate ${p.mwstSatz} % is not a current Swiss rate (0 / 2.6 / 8.1) — please check this line's VAT.`,
        ),
      });
    }
    const pos: WarenPosition = {
      artNr: p.artNr ?? '', bezeichnung: p.bezeichnung, warengruppe: profil?.kategorie ?? '',
      menge, einheit: p.einheit ?? '', preis, positionspreis: R2(pp),
      mwstBetrag: satz !== undefined ? R2(pp * satz / 100) : 0,
      mwstCode: satz === undefined ? 0 : satz === 0 ? 0 : satz === 2.6 ? 1 : 2,
      ...(satz !== undefined ? { mwstSatz: satz } : {}),
    };
    behalten.push({ idx, pos, satz: p.mwstSatz });
    const datum = p.lieferdatum ?? kopfDatum;
    const nr = p.lieferscheinNr ?? rechnungsNr;
    if (datum && nr) {
      const key = `${nr}|${datum}`;
      gruppenMeta.set(key, { nr, datum });
      gruppen.set(key, [...(gruppen.get(key) ?? []), pos]);
    }
  });

  const lieferungen: ParsedCsvRechnung[] = [...gruppen.entries()].map(([key, positionen]) => {
    const { nr, datum } = gruppenMeta.get(key)!;
    const markt = profil?.name ?? d.lieferant.name ?? '';
    const nettoTotal = R2(positionen.reduce((s, p) => s + p.positionspreis, 0));
    const mwstTotal = R2(positionen.reduce((s, p) => s + p.mwstBetrag, 0));
    return {
      docKey: `${nr}|${datum}|${markt}`, rechnungsNr: nr, datum, markt, positionen,
      nettoTotal, mwstTotal, bruttoTotal: R2(nettoTotal + mwstTotal),
    };
  });

  if (d.positionen.length === 0) {
    add({
      code: 'no-lines', level: 'warn',
      text: tr('Keine Positionen gelesen — der Beleg wird nur über die Kopfwerte gebucht, ohne Preisüberwachung.',
        'No lines read — the document will be booked from the header values only, without price tracking.'),
    });
  } else if (behalten.length > 0 && lieferungen.length === 0) {
    add({
      code: 'missing-header', level: 'error',
      text: tr('Positionen gelesen, aber Rechnungs-Nr oder Datum fehlen — bitte in der Vorschau erfassen.',
        'Lines read, but invoice number or date is missing — please enter them in the preview.'),
    });
  }

  // ── Header values ────────────────────────────────────────────────────────
  const klassen = mwstKlassenVon(d);
  const netto = d.netto;
  let mwst = d.mwst;
  if (mwst === null && klassen.length > 0) mwst = R2(klassen.reduce((s, k) => s + k.betrag, 0));
  const brutto = d.brutto ?? (netto !== null && mwst !== null ? R2(netto + mwst) : null);
  const mwstSatz = klassen.length === 1 ? klassen[0].satz : null; // never an average across classes
  if (!rechnungsNr) add({ code: 'missing-header', level: 'warn', text: tr('Rechnungs-Nr nicht gelesen.', 'Invoice number not read.') });
  if (!d.rechnungsdatum) add({ code: 'missing-header', level: 'warn', text: tr('Rechnungsdatum nicht gelesen.', 'Invoice date not read.') });
  if (netto === null) add({ code: 'missing-header', level: 'warn', text: tr('Netto-Betrag nicht gelesen.', 'Net amount not read.') });

  // ── Arithmetic checks ────────────────────────────────────────────────────
  const summeZeilen = R2(behalten.reduce((s, b) => s + b.pos.positionspreis, 0));
  if (behalten.length > 0 && netto !== null && Math.abs(summeZeilen - netto) > TOL) {
    add({
      code: 'lines-vs-net', level: 'error',
      text: tr(
        `Summe der Positionen ${summeZeilen.toFixed(2)} ≠ Netto auf dem Beleg ${netto.toFixed(2)} — mindestens eine Zeile ist falsch oder fehlt.`,
        `Sum of lines ${summeZeilen.toFixed(2)} ≠ net on the document ${netto.toFixed(2)} — at least one line is wrong or missing.`,
      ),
    });
  }
  if (netto !== null && mwst !== null && d.brutto !== null && Math.abs(R2(netto + mwst) - d.brutto) > TOL) {
    add({
      code: 'gross-vs-net-vat', level: 'error',
      text: tr(
        `Netto ${netto.toFixed(2)} + MwSt ${mwst.toFixed(2)} ≠ Brutto ${d.brutto.toFixed(2)}.`,
        `Net ${netto.toFixed(2)} + VAT ${mwst.toFixed(2)} ≠ gross ${d.brutto.toFixed(2)}.`,
      ),
    });
  }
  if (klassen.length > 0) {
    const sumBasis = R2(klassen.reduce((s, k) => s + k.basis, 0));
    if (netto !== null && Math.abs(sumBasis - netto) > TOL) {
      add({
        code: 'classes-vs-net', level: 'error',
        text: tr(
          `MwSt-Klassen (Basis ${sumBasis.toFixed(2)}) decken das Netto ${netto.toFixed(2)} nicht.`,
          `VAT classes (base ${sumBasis.toFixed(2)}) do not cover the net ${netto.toFixed(2)}.`,
        ),
      });
    }
    for (const k of klassen) {
      if (Math.abs(R2(k.basis * k.satz / 100) - k.betrag) > TOL) {
        add({
          code: 'class-amount', level: 'warn',
          text: tr(
            `MwSt ${k.satz} %: ${k.basis.toFixed(2)} × ${k.satz} % ≠ ${k.betrag.toFixed(2)}.`,
            `VAT ${k.satz} %: ${k.basis.toFixed(2)} × ${k.satz} % ≠ ${k.betrag.toFixed(2)}.`,
          ),
        });
      }
      const ausZeilen = R2(behalten.filter(b => b.satz === k.satz).reduce((s, b) => s + b.pos.positionspreis, 0));
      if (behalten.length > 0 && Math.abs(ausZeilen - k.basis) > TOL) {
        add({
          code: 'lines-vs-classes', level: 'error',
          text: tr(
            `MwSt ${k.satz} %: Zeilen ergeben ${ausZeilen.toFixed(2)}, der Beleg weist ${k.basis.toFixed(2)} aus.`,
            `VAT ${k.satz} %: lines add up to ${ausZeilen.toFixed(2)}, the document shows ${k.basis.toFixed(2)}.`,
          ),
        });
      }
    }
  }
  if (d.lesehinweis) {
    add({ code: 'unreadable-note', level: 'warn', text: tr(`Hinweis der KI: ${d.lesehinweis}`, `Note from the AI: ${d.lesehinweis}`) });
  }

  // The "read by AI" marker is shown by the preview itself (ergebnis.perKi), not as a hint line.
  if (!profil && !keineRechnung) {
    hinweise.push(tr('Lieferant nicht erkannt — bitte in der Vorschau zuordnen (wird dauerhaft gespeichert).',
      'Supplier not recognised — please assign in the preview (saved permanently).'));
  }
  hinweise.push(...pruef.map(p => p.text));

  const ergebnis: ProfilPdfErgebnis = {
    profil, mwstNrn,
    rechnungsNr,
    rechnungsdatum: d.rechnungsdatum,
    lieferdatum: d.lieferdatum ?? (lieferungen.length === 1 ? lieferungen[0].datum : null),
    netto, mwst, mwstSatz, mwstKlassen: klassen, brutto,
    lieferungen, positionenErkannt: lieferungen.length > 0,
    belegart: keineRechnung && belegart === 'rechnung' ? 'auftragsbestaetigung' : belegart,
    dokumenttyp,
    hinweise,
    perKi: true,
  };
  return {
    ergebnis, pruefungen: pruef, positionsFlags: flags,
    zeilen: behalten.map(b => ({ pos: b.pos, warn: flags[b.idx].warn })),
  };
}
