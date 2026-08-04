/**
 * Personaleintritt — Dossier-PDF (IO: pdf-lib + Bucket-Downloads)
 * ===============================================================
 * Rendert das Personaleintritt-Dossier (Auftrag Punkt 10): Fragen + Antworten
 * aller Phasen (Inhalt aus dem REINEN Modul dossier-inhalt.ts) und bettet die
 * hochgeladenen Anhänge (AHV-Karte, Ausweis, Bankkarte, Foto) als Folgeseiten
 * ins selbe PDF ein. Kopfzeile (Betrieb · Name · Eintritt · Erstellungsdatum)
 * auf jeder selbst gerenderten Seite.
 *
 * Anhänge: JPG/PNG werden als Bild eingebettet, PDFs seitenweise kopiert
 * (mit vorangestellter Titelseite). Nicht einbettbare Formate (z. B. HEIC)
 * erhalten eine Platzhalterseite mit dem Bucket-Pfad — nie stilles Weglassen;
 * jeder Ausfall erscheint zusätzlich in `hinweise`.
 */

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import type { PersonaleintrittRecord } from './types';
import type { BetriebRecord } from './betriebs-config';
import { buildDossierInhalt, type DossierInhalt } from './dossier-inhalt';
import { downloadDokument } from './db';

export { buildDossierInhalt } from './dossier-inhalt';

const A4: [number, number] = [595.28, 841.89];
const MARGE = 50;
const KOPF_Y = A4[1] - 40;
const INHALT_START_Y = A4[1] - 70;
const FUSS_Y = 50;

const GRAU = rgb(0.42, 0.45, 0.5);
const DUNKEL = rgb(0.1, 0.12, 0.16);
const LINIE = rgb(0.85, 0.87, 0.9);

/** WinAnsi-sichere Textform (Standard-Fonts): nicht kodierbare Zeichen → «?». */
function winAnsi(s: string): string {
  return s.replace(/[^\u0020-\u007e\u00a0-\u00ff\u2013\u2014\u2018\u2019\u201a\u201c\u201d\u201e\u2026\u20ac]/g, '?');
}

function zeilenUmbruch(text: string, font: PDFFont, groesse: number, maxBreite: number): string[] {
  const woerter = winAnsi(text).split(/\s+/).filter(Boolean);
  if (woerter.length === 0) return [''];
  const zeilen: string[] = [];
  let aktuell = '';
  for (const wort of woerter) {
    const kandidat = aktuell ? `${aktuell} ${wort}` : wort;
    if (font.widthOfTextAtSize(kandidat, groesse) <= maxBreite || !aktuell) aktuell = kandidat;
    else { zeilen.push(aktuell); aktuell = wort; }
  }
  if (aktuell) zeilen.push(aktuell);
  return zeilen;
}

export interface DossierErgebnis {
  bytes: Uint8Array;
  dateiname: string;
  inhalt: DossierInhalt;
  /** Sichtbare Ausfälle (Anhang nicht einbettbar/ladbar) — nie stilles Weglassen. */
  hinweise: string[];
}

/** Erzeugt das komplette Dossier-PDF inkl. eingebetteter Anhänge. */
export async function erzeugeDossierPdf(
  record: PersonaleintrittRecord,
  betrieb: BetriebRecord,
): Promise<DossierErgebnis> {
  const inhalt = buildDossierInhalt(record, betrieb);
  const hinweise: string[] = [];

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fett = await doc.embedFont(StandardFonts.HelveticaBold);

  const kopfzeile = `${inhalt.kopf.betrieb} · ${inhalt.kopf.name} · Eintritt: ${inhalt.kopf.eintritt} · erstellt: ${inhalt.kopf.erstellt}`;

  const neueSeite = (): PDFPage => {
    const seite = doc.addPage(A4);
    seite.drawText(winAnsi(kopfzeile), { x: MARGE, y: KOPF_Y, size: 9, font, color: GRAU });
    seite.drawLine({
      start: { x: MARGE, y: KOPF_Y - 8 }, end: { x: A4[0] - MARGE, y: KOPF_Y - 8 },
      thickness: 0.5, color: LINIE,
    });
    return seite;
  };

  // ── Teil 1: Fragen + Antworten aller Phasen ────────────────────────────────
  let seite = neueSeite();
  let y = INHALT_START_Y;

  const brauchePlatz = (hoehe: number) => {
    if (y - hoehe < FUSS_Y) { seite = neueSeite(); y = INHALT_START_Y; }
  };

  seite.drawText('Personaleintritt-Dossier', { x: MARGE, y, size: 18, font: fett, color: DUNKEL });
  y -= 30;

  const frageBreite = 190;
  const antwortX = MARGE + frageBreite + 12;
  const antwortBreite = A4[0] - MARGE - antwortX;

  for (const sektion of inhalt.sektionen) {
    brauchePlatz(40);
    seite.drawText(winAnsi(sektion.titel), { x: MARGE, y, size: 12, font: fett, color: DUNKEL });
    y -= 18;
    for (const zeile of sektion.zeilen) {
      const frageZeilen = zeilenUmbruch(zeile.frage, font, 9, frageBreite);
      const antwortZeilen = zeilenUmbruch(zeile.antwort, font, 9, antwortBreite);
      const hoehe = Math.max(frageZeilen.length, antwortZeilen.length) * 12 + 4;
      brauchePlatz(hoehe);
      frageZeilen.forEach((t, i) => seite.drawText(t, { x: MARGE, y: y - i * 12, size: 9, font, color: GRAU }));
      antwortZeilen.forEach((t, i) => seite.drawText(t, { x: antwortX, y: y - i * 12, size: 9, font, color: DUNKEL }));
      y -= hoehe;
    }
    y -= 12;
  }

  // Anhang-Übersicht (inkl. fehlender Pflicht-Dokumente — sichtbar, nie still).
  brauchePlatz(40);
  seite.drawText('Anhänge', { x: MARGE, y, size: 12, font: fett, color: DUNKEL });
  y -= 18;
  if (inhalt.anhaenge.length === 0) {
    brauchePlatz(16);
    seite.drawText('Keine Dokumente hochgeladen.', { x: MARGE, y, size: 9, font, color: GRAU });
    y -= 16;
  }
  inhalt.anhaenge.forEach((a, i) => {
    brauchePlatz(16);
    seite.drawText(winAnsi(`${i + 1}. ${a.label} (Folgeseite)`), { x: MARGE, y, size: 9, font, color: DUNKEL });
    y -= 14;
  });
  for (const fehlt of inhalt.fehlendeDokumente) {
    brauchePlatz(16);
    seite.drawText(winAnsi(`Fehlt (Pflicht): ${fehlt}`), { x: MARGE, y, size: 9, font, color: rgb(0.75, 0.35, 0.05) });
    y -= 14;
  }

  // ── Teil 2: Anhänge als Folgeseiten ────────────────────────────────────────
  for (const anhang of inhalt.anhaenge) {
    const titel = `Anhang: ${anhang.label}`;
    const blob = await downloadDokument(anhang.path);
    if (!blob) {
      const s = neueSeite();
      s.drawText(winAnsi(titel), { x: MARGE, y: INHALT_START_Y, size: 14, font: fett, color: DUNKEL });
      s.drawText(winAnsi(`Download fehlgeschlagen — Original im Bucket: ${anhang.path}`),
        { x: MARGE, y: INHALT_START_Y - 24, size: 9, font, color: GRAU });
      hinweise.push(`${anhang.label}: Download aus dem Bucket fehlgeschlagen (${anhang.path}).`);
      continue;
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const ext = (anhang.path.split('.').pop() ?? '').toLowerCase();
    const istPdf = ext === 'pdf' || blob.type === 'application/pdf'
      || (bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46);

    try {
      if (istPdf) {
        // Titelseite, dann Seiten 1:1 kopieren (Kopfzeile nur auf der Titelseite —
        // kopierte Original-Seiten werden nicht überzeichnet).
        const s = neueSeite();
        s.drawText(winAnsi(titel), { x: MARGE, y: INHALT_START_Y, size: 14, font: fett, color: DUNKEL });
        s.drawText('Die folgenden Seiten sind das unveränderte Original-Dokument.',
          { x: MARGE, y: INHALT_START_Y - 24, size: 9, font, color: GRAU });
        const quelle = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const kopien = await doc.copyPages(quelle, quelle.getPageIndices());
        for (const k of kopien) doc.addPage(k);
      } else if (ext === 'png' || blob.type === 'image/png') {
        zeichneBildSeite(neueSeite(), titel, await doc.embedPng(bytes), font, fett);
      } else if (ext === 'jpg' || ext === 'jpeg' || blob.type === 'image/jpeg') {
        zeichneBildSeite(neueSeite(), titel, await doc.embedJpg(bytes), font, fett);
      } else {
        throw new Error(`Format «${ext || blob.type || 'unbekannt'}» kann nicht eingebettet werden`);
      }
    } catch (e) {
      const grund = e instanceof Error ? e.message : 'Einbetten fehlgeschlagen';
      const s = neueSeite();
      s.drawText(winAnsi(titel), { x: MARGE, y: INHALT_START_Y, size: 14, font: fett, color: DUNKEL });
      s.drawText(winAnsi(`${grund} — Original im Bucket: ${anhang.path}`),
        { x: MARGE, y: INHALT_START_Y - 24, size: 9, font, color: GRAU });
      hinweise.push(`${anhang.label}: ${grund} (${anhang.path}).`);
    }
  }

  return { bytes: await doc.save(), dateiname: inhalt.dateiname, inhalt, hinweise };
}

function zeichneBildSeite(
  seite: PDFPage,
  titel: string,
  bild: { width: number; height: number },
  font: PDFFont,
  fett: PDFFont,
): void {
  seite.drawText(winAnsi(titel), { x: MARGE, y: INHALT_START_Y, size: 14, font: fett, color: DUNKEL });
  const maxBreite = A4[0] - 2 * MARGE;
  const maxHoehe = INHALT_START_Y - 40 - FUSS_Y;
  const faktor = Math.min(maxBreite / bild.width, maxHoehe / bild.height, 1);
  const b = bild.width * faktor;
  const h = bild.height * faktor;
  // pdf-lib: PDFImage hat drawImage über die Seite — Typen hier strukturell.
  (seite as PDFPage).drawImage(bild as never, {
    x: MARGE + (maxBreite - b) / 2,
    y: INHALT_START_Y - 30 - h,
    width: b,
    height: h,
  });
}
