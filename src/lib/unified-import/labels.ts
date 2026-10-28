/**
 * labels.ts — client-visible German texts of the unified import (the only German in this folder).
 */

import type { ClassifyStatus, ReasonCode } from './types';
import { tr } from './strings';

export const STATUS_LABEL: Record<ClassifyStatus | 'handed' | 'forbidden', string> = {
  recognised: tr('Erkannt', 'Recognised'),
  confirm: tr('Bitte bestätigen', 'Please confirm'),
  unknown: tr('Nicht erkannt', 'Not recognised'),
  unsupported: tr('Nicht unterstützt', 'Not supported'),
  handed: tr('Geöffnet — noch nicht importiert', 'Opened — not imported yet'),
  forbidden: tr('Keine Berechtigung', 'No permission'),
};

export const REASON_TEXT: Record<ReasonCode, string> = {
  'unsupported-extension': tr('Dateityp wird nicht unterstützt (erlaubt: Excel, CSV, TXT, PDF).', 'File type not supported (allowed: Excel, CSV, TXT, PDF).'),
  'legacy-xls': tr('Altes Excel-Format (.xls) kann nicht gelesen werden — bitte als .xlsx speichern.', 'Old Excel format (.xls) cannot be read — please save as .xlsx.'),
  'file-too-large': tr('Datei ist zu gross (max. 25 MB).', 'File is too large (max. 25 MB).'),
  'read-error': tr('Datei konnte nicht gelesen werden.', 'File could not be read.'),
  'empty-file': tr('Die Datei ist leer.', 'The file is empty.'),
  'pdf-no-text-layer': tr('PDF enthält keinen lesbaren Text (Scan).', 'PDF has no readable text (scan).'),
  'pdf-kind-from-title': tr('Berichtsart aus dem Titel erkannt.', 'Report type recognised from the title.'),
  'pdf-kind-from-body-only': tr('Berichtsart nur im Text gefunden, nicht im Titel — bitte prüfen.', 'Report type found in the text only, not in the title — please check.'),
  'pdf-kind-unknown': tr('Berichtsart nicht erkannt.', 'Report type not recognised.'),
  'name-matches-content': tr('Dateiname und Inhalt passen zusammen.', 'File name and content match.'),
  'name-contradicts-content': tr('Dateiname und Inhalt passen nicht zusammen — bitte Typ wählen.', 'File name and content do not match — please choose the type.'),
  'content-only': tr('Aus dem Inhalt erkannt.', 'Recognised from the content.'),
  'amounts-without-chf-marker': tr('Zahlen ohne «CHF» und ohne «P.» — Umsatz oder Gäste? Bitte Typ wählen.', 'Numbers without «CHF» and without «P.» — revenue or guests? Please choose the type.'),
  'label-not-exact': tr('Bezeichnung nicht eindeutig («Gesamt» fehlt) — bitte prüfen.', 'Label not exact («Gesamt» missing) — please check.'),
  'average-ambiguous': tr('«Durchschnitt»: pro Bon oder pro Person? Wird im Import gewählt.', '«Durchschnitt»: per receipt or per person? Chosen in the import.'),
  'no-date-columns': tr('Keine Tagesspalten (TT.MM.) gefunden.', 'No day columns (DD.MM.) found.'),
  'header-matches-one-foratable-type': tr('Spalten passen zu genau einem Foratable-Export.', 'Columns match exactly one Foratable export.'),
  'header-matches-both-foratable-types': tr('Spalten passen zu beiden Foratable-Exporten — bitte wählen.', 'Columns match both Foratable exports — please choose.'),
  'tab-file-totals-and-products': tr('Enthält Summenzeile und viele Artikelzeilen — bitte Typ wählen.', 'Contains a totals row and many product rows — please choose the type.'),
  'tab-file-totals-only': tr('Summenzeilen Food/Beverage erkannt.', 'Food/Beverage totals rows recognised.'),
  'tab-file-products': tr('Artikelzeilen erkannt.', 'Product rows recognised.'),
  'mirus-title-found': tr('Mirus-Export «Tägliche Stunden» — Ziel wählen: Dienstplan oder Import-Center.', 'Mirus export «Tägliche Stunden» — choose the target: Schedule or Import Center.'),
  'category-sheet-found': tr('Umsatzanalyse Kategorien erkannt.', 'Revenue analysis categories recognised.'),
  'feedback-csv-found': tr('Rezensionen-CSV erkannt.', 'Reviews CSV recognised.'),
  'kpi-csv-found': tr('Gastronovi-Bericht (CSV) erkannt.', 'Gastronovi report (CSV) recognised.'),
  'nothing-recognised': tr('Bitte den Typ selbst wählen.', 'Please choose the type yourself.'),
};

/** Reasons worth showing under a row (the positive «recognised because…» ones are shown only on hover). */
export const ISSUE_REASONS: ReasonCode[] = [
  'mirus-title-found',
  'unsupported-extension', 'legacy-xls', 'file-too-large', 'read-error', 'empty-file', 'pdf-no-text-layer',
  'pdf-kind-from-body-only', 'pdf-kind-unknown', 'name-contradicts-content', 'amounts-without-chf-marker',
  'label-not-exact', 'average-ambiguous', 'no-date-columns', 'header-matches-both-foratable-types',
  'tab-file-totals-and-products', 'nothing-recognised',
];
