/**
 * Ehrliche Erfolgsmeldung des MIRUS-Reconcile-Imports (pure, testbar).
 * =====================================================================
 * Trennt klar: zugeordnet importiert / geparkt-offen / bewusst übersprungen /
 * ausserhalb des Import-Monats (out-of-scope). «Summe im Importumfang» ist die
 * Summe der Datei-Stunden INNERHALB des gewählten Monats — out-of-scope-Zeilen
 * werden separat ausgewiesen, nie stillschweigend mitgezählt oder unterschlagen.
 */

export interface MirusSuccessMessageInput {
  assignedEmployeeCount: number;
  /** Datei-Stunden der zugeordneten MA im Monats-Scope. */
  assignedHours: number;
  writtenCells: number;
  parkedCount: number;
  parkedHours: number;
  skippedHours: number;
  /** Datei-Stunden ausserhalb des Import-Monats (skippedOutOfScope). */
  outOfScopeHours: number;
  warnCount: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export function buildMirusSuccessMessage(i: MirusSuccessMessageInput): string {
  const inScopeTotal = r2(i.assignedHours + i.parkedHours + i.skippedHours);
  const parts = [
    `MIRUS-Import: ${i.assignedEmployeeCount} MA zugeordnet importiert (${r2(i.assignedHours).toFixed(2)} h), ${i.writtenCells} Zellen geschrieben, Backup angelegt.`,
  ];
  if (i.parkedCount > 0) {
    parts.push(`${i.parkedCount} Eintrag/Einträge geparkt/offen (${r2(i.parkedHours).toFixed(2)} h, nicht zugeordnet — siehe «Offene Stunden»).`);
  }
  if (i.skippedHours > 0) {
    parts.push(`${r2(i.skippedHours).toFixed(2)} h bewusst übersprungen (nicht importiert).`);
  }
  if (i.parkedCount > 0 || i.skippedHours > 0) {
    parts.push(`Summe im Importumfang (Monat): ${inScopeTotal.toFixed(2)} h.`);
  }
  if (i.outOfScopeHours > 0) {
    parts.push(`${r2(i.outOfScopeHours).toFixed(2)} h liegen ausserhalb des Import-Monats und wurden nicht geschrieben (siehe Hinweis im Bericht).`);
  }
  if (i.warnCount > 0) {
    parts.push(`${i.warnCount} Warnung(en) in der Gegenprüfung!`);
  }
  return parts.join(' ');
}
