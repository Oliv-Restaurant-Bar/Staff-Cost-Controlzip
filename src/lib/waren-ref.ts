/**
 * waren-ref — normalisierte Rechnungs-/Belegnummer (pur, ohne Abhängigkeiten).
 * Ausgelagert aus kreditoren-abgleich, damit reine Logik-Module (Dubletten-
 * Erkennung) und node-Tests sie ohne Supabase-Importkette nutzen können.
 */

/**
 * Normalisierte Basis-Rechnungsnummer für Vergleiche.
 * FIBU-Übernahme-Referenzen sind «Beleg · Rechnungsnr» (z.B. «1132 · 26214454»)
 * — die eigentliche Rechnungsnummer steht NACH dem Trennpunkt. Ohne diese
 * Extraktion verglich die Dubletten-Wache «1132» mit «26214454» und schlug
 * dieselbe Rechnung erneut zur Übernahme vor (Doppel-Erfassung).
 */
export function normRef(ref: string | null | undefined): string | null {
  const raw = (ref ?? '').trim();
  const basis = raw.includes('·') ? raw.split('·').pop()!.trim() : raw;
  const t = basis.split(/[,\s]+/)[0]
    .replace(/[^\p{L}\p{N}]+$/u, '')
    .toLowerCase().replace(/^0+(?=\d)/, '');
  return t.length > 0 ? t : null;
}
