/**
 * Personaleintritt — MIRUS-Lohnexport (Struktur)
 * ==============================================
 * MIRUS ist das Lohnprogramm (Swiss Gastro, Swissdec). Das exakte Importformat
 * ist noch NICHT mit dem MIRUS-Support bestätigt — bis dahin liefert dieser
 * Export die Lohnprogramm-Felder strukturiert als Excel (Spalten Feld|Wert).
 *
 * Regeln (Projektstandard):
 * - buildMirusZeilen ist REIN (kein DOM/IO) und einzeln testbar.
 * - Zahlen als echte Zahlenzellen mit Rohwerten (Zellformat, keine Strings).
 * - Fehlende Werte = LEERE Zelle, nie 0; fehlende Pflicht-Lohnfelder ⇒ Hinweis.
 */
import type { PersonaleintrittRecord } from './types';

export interface MirusZeile {
  feld: string;
  /** Rohwert: string (Text/Datum dd.MM.yyyy) oder number (echte Zahlenzelle) oder null (leer). */
  wert: string | number | null;
  /** Excel-Zahlenformat für number-Werte (z. B. '#,##0.00'). */
  zellformat?: string;
}

export interface MirusExport {
  zeilen: MirusZeile[];
  /** Fehlende Pflicht-Lohnfelder + genereller Format-Hinweis. */
  hinweise: string[];
  dateiname: string;
}

function datum(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

const leer = (s: string | undefined | null): string | null => (s && s.trim() ? s.trim() : null);

export function buildMirusZeilen(record: PersonaleintrittRecord): MirusExport {
  const p = record.maDaten?.personalien ?? {};
  const v = record.maDaten?.vertrag ?? {};
  const l = record.maDaten?.lohnprogramm ?? {};
  const hinweise: string[] = [
    'Importformat vor dem Anbinden mit dem MIRUS-Support bestätigen (CSV/Excel-Mitarbeiterimport vs. MIRUS-CONNECT).',
  ];

  const pflicht: [string, string | undefined][] = [
    ['AHV-Nr.', l.ahv_nr], ['IBAN', l.iban], ['Zivilstand', l.zivilstand],
    ['Geburtsdatum', p.geburtsdatum], ['Eintritt', record.eintritt ?? undefined],
  ];
  for (const [label, wert] of pflicht) {
    if (!leer(wert)) hinweise.push(`Pflichtfeld fürs Lohnprogramm fehlt: ${label}.`);
  }

  const lohnart = record.vertragstyp === 'ML' ? 'Monatslohn'
    : record.vertragstyp === 'SL' ? 'Stundenlohn' : null;

  const zeilen: MirusZeile[] = [
    { feld: 'Betrieb', wert: leer(record.betrieb) },
    { feld: 'Anrede', wert: leer(p.anrede) },
    { feld: 'Name', wert: leer(p.name) },
    { feld: 'Vorname', wert: leer(p.vorname) },
    { feld: 'Strasse', wert: leer(p.strasse) },
    { feld: 'PLZ', wert: leer(p.plz) },
    { feld: 'Ort', wert: leer(p.ort) },
    { feld: 'Geburtsdatum', wert: datum(p.geburtsdatum) },
    { feld: 'Heimatort / Nationalität', wert: leer(p.heimatort_nationalitaet) },
    { feld: 'Telefon', wert: leer(p.telefon) },
    { feld: 'E-Mail', wert: leer(p.email) },
    { feld: 'Zivilstand', wert: leer(l.zivilstand) },
    { feld: 'AHV-Nr.', wert: leer(l.ahv_nr) },
    { feld: 'IBAN', wert: leer(l.iban) },
    { feld: 'Bank', wert: leer(l.bank) },
    { feld: 'Konfession', wert: leer(l.konfession) },
    { feld: 'Ausweisart', wert: leer(l.ausweisart) },
    { feld: 'Ausweis-Nr.', wert: leer(l.ausweis_nr) },
    { feld: 'Aufenthaltsbewilligung', wert: leer(l.aufenthaltsbewilligung) },
    { feld: 'Ehepartner Name', wert: leer(l.ehepartner?.name) },
    {
      feld: 'Ehepartner erwerbstätig',
      wert: l.ehepartner?.name ? (l.ehepartner?.erwerbstaetig ? 'ja' : 'nein') : null,
    },
    { feld: 'Eintritt', wert: datum(record.eintritt) },
    { feld: 'Funktion', wert: leer(record.funktion) },
    {
      feld: 'Pensum (%)',
      wert: record.vertragstyp === 'ML' ? (record.pensumProzent ?? null) : null,
      zellformat: '0',
    },
    { feld: 'Wochenstunden', wert: v.wochenstunden ?? null, zellformat: '0.0' },
    { feld: 'Lohnart', wert: lohnart },
    {
      feld: record.vertragstyp === 'SL' ? 'Basislohn (CHF/Std., exkl. Zuschläge)' : 'Basislohn (CHF/Monat, exkl. 13.)',
      wert: record.lohnBerechnet ?? null,
      zellformat: '#,##0.00',
    },
    { feld: 'Probezeit (Tage)', wert: record.probezeitTage ?? null, zellformat: '0' },
    {
      feld: 'Vertragsdauer',
      wert: record.vertragsdauer === 'befristet'
        ? `befristet bis ${datum(record.befristetBis) ?? '?'}`
        : record.vertragsdauer ? 'unbefristet' : null,
    },
  ];

  const kinder = l.kinder ?? [];
  kinder.forEach((k, i) => {
    zeilen.push(
      { feld: `Kind ${i + 1} Name`, wert: leer(k.name) },
      { feld: `Kind ${i + 1} Geburtsdatum`, wert: datum(k.geburtsdatum) },
      { feld: `Kind ${i + 1} Familienzulage bei`, wert: leer(k.familienzulage_bei) },
    );
  });

  const nameSlug = [p.vorname, p.name].filter(Boolean).join('_').replace(/[^\p{L}\p{N}_-]+/gu, '') || record.id;
  return { zeilen, hinweise, dateiname: `MIRUS_Export_${nameSlug}.xlsx` };
}

/** Excel-Datei erzeugen (Bytes) — Rohwerte + Zellformate, leere Zellen statt 0. */
export async function erzeugeMirusExcel(record: PersonaleintrittRecord): Promise<{
  bytes: Uint8Array; dateiname: string; hinweise: string[];
}> {
  const XLSX = await import('xlsx');
  const { zeilen, hinweise, dateiname } = buildMirusZeilen(record);

  const aoa: (string | number | null)[][] = [['Feld', 'Wert']];
  for (const z of zeilen) aoa.push([z.feld, z.wert]);
  aoa.push([null, null], ['Hinweise', null]);
  for (const h of hinweise) aoa.push([h, null]);

  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: false });
  zeilen.forEach((z, i) => {
    if (typeof z.wert === 'number' && z.zellformat) {
      const cell = ws[XLSX.utils.encode_cell({ r: i + 1, c: 1 })];
      if (cell) cell.z = z.zellformat;
    }
  });
  ws['!cols'] = [{ wch: 38 }, { wch: 34 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'MIRUS');
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return { bytes: new Uint8Array(bytes), dateiname, hinweise };
}
