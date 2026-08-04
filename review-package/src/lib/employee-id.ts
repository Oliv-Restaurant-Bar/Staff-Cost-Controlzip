/**
 * Mitarbeiter-ID-Erzeugung (REINE Logik, kein IO)
 * ================================================
 * Tenant = ID-Präfix: Beaulieu-IDs «b-<n>», Oliv-IDs rein numerisch («14»).
 * Extrahiert aus Personalstamm.tsx, damit auch die Personaleintritt-Übernahme
 * dieselbe ID-Vergabe nutzt (KEINE parallele ID-Logik).
 *
 * WICHTIG (beaulieu): Die übergebene Liste muss ALLE vergebenen b-IDs
 * enthalten — inkl. archivierter (loadAllBeaulieuIds), sonst Kollisionen.
 */

export function beaulieuNums(existingIds: string[]): number[] {
  return existingIds
    .map(id => { const m = String(id).match(/^b-(\d+)$/); return m ? parseInt(m[1]) : NaN; })
    .filter(n => !isNaN(n));
}

/** Nächste freie b-ID, nur anhand der übergebenen ID-Liste berechnet. */
export function nextBeaulieuIdFrom(existingIds: string[]): string {
  const nums = beaulieuNums(existingIds);
  const highest = nums.length > 0 ? Math.max(...nums) : 0;
  return `b-${highest + 1}`;
}

/** Nächste freie numerische Oliv-ID anhand der übergebenen ID-Liste. */
export function nextOlivIdFrom(existingIds: string[]): string {
  const nums = existingIds.map(id => parseInt(id)).filter(n => !isNaN(n));
  const maxNum = nums.length > 0 ? Math.max(...nums) : 0;
  return String(maxNum + 1);
}

/** Tenant-abhängige ID-Erzeugung (Signatur-Äquivalent zu Personalstamm generateId). */
export function generateEmployeeId(existingIds: string[], tenantId?: string): string {
  return tenantId === 'beaulieu' ? nextBeaulieuIdFrom(existingIds) : nextOlivIdFrom(existingIds);
}
