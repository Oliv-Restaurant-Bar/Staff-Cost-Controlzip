/**
 * Personaleintritt — Übernahme in den Personalstamm (REINE Logik, kein IO)
 * ========================================================================
 * Baut aus einem geprüften PersonaleintrittRecord einen Employee für die
 * employees-Tabelle. Der eigentliche Schreibvorgang (upsertEmployee) passiert
 * beim Aufrufer (PersonaleintrittDetail) — dokumentierte ZWEITE sanktionierte
 * employees-Schreibstelle neben dem Personalstamm-Formular.
 *
 * ID-Vergabe über die GEMEINSAME Logik in employee-id.ts (keine Parallel-Logik);
 * für Beaulieu muss die ID-Liste ALLE vergebenen b-IDs enthalten (inkl.
 * archivierter), sonst drohen Kollisionen.
 */

import type { Employee, Department } from '@/types/personnel';
import type { PersonaleintrittRecord } from './types';
import { generateEmployeeId } from '@/lib/employee-id';
import { SL_ZUSCHLAEGE, rundeLohn } from './lohn';

export interface UebernahmeErgebnis {
  employee: Employee;
  /** Hinweise für die GF (z. B. fehlende Felder, Lohn-Interpretation). */
  hinweise: string[];
}

/** Normalisierter Namensvergleich für die Duplikat-Warnung. */
export function normalisierterName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Vorhandene Mitarbeiter mit gleichem Namen (Duplikat-Warnung, kein Hard-Block). */
export function findeNamensDuplikate(
  kandidatName: string,
  bestehende: Pick<Employee, 'id' | 'name'>[],
): Pick<Employee, 'id' | 'name'>[] {
  const norm = normalisierterName(kandidatName);
  if (!norm) return [];
  return bestehende.filter(e => normalisierterName(e.name) === norm);
}

export function buildEmployeeFromEintritt(
  record: PersonaleintrittRecord,
  department: Department,
  vorhandeneIds: string[],
): UebernahmeErgebnis {
  const hinweise: string[] = [];
  const p = record.maDaten?.personalien ?? {};
  const v = record.maDaten?.vertrag ?? {};
  const l = record.maDaten?.lohnprogramm ?? {};

  const name = [p.vorname, p.name].filter(Boolean).join(' ').trim();
  if (!name) hinweise.push('Name fehlt — bitte vor der Übernahme im Datensatz ergänzen.');

  const id = generateEmployeeId(vorhandeneIds, record.restaurantId);

  const emp: Employee = {
    id,
    name,
    department,
    employmentType: 'aushilfe',
    hourlyWage: 0,
  };

  if (record.vertragstyp === 'ML') {
    const pensum = record.pensumProzent ?? 100;
    emp.employmentType = pensum >= 100 ? 'vollzeit' : 'teilzeit';
    emp.contractType = 'monthly';
    emp.weeklyHours = v.wochenstunden ?? rundeLohn((42 * pensum) / 100);
    if (record.lohnBerechnet != null) {
      const basis = rundeLohn(record.lohnBerechnet);
      emp.monthlySalary = basis;
      emp.has13thSalary = true;
      emp.monthlySalaryWith13th = rundeLohn(basis * (1 + SL_ZUSCHLAEGE.dreizehnter));
    } else {
      hinweise.push('Kein berechneter Monatslohn — Lohnfelder bleiben leer.');
    }
  } else if (record.vertragstyp === 'SL') {
    emp.employmentType = 'aushilfe';
    emp.contractType = 'hourly';
    if (record.lohnBerechnet != null) {
      // Basis-Stundenlohn OHNE Zuschläge (Ferien/Feiertag/13. werden im
      // Lohnprogramm separat abgerechnet) — konsistent zum Personalstamm.
      emp.hourlyWage = rundeLohn(record.lohnBerechnet);
      emp.has13thSalary = false;
    } else {
      hinweise.push('Kein berechneter Stundenlohn — hourlyWage = 0, bitte im Personalstamm nachtragen.');
    }
  } else {
    hinweise.push('Vertragstyp fehlt — Beschäftigungsart als Aushilfe übernommen.');
  }

  // Persönliche Daten (nur setzen, was vorhanden ist — kein ''-Clobber)
  if (p.geburtsdatum) emp.birthDate = p.geburtsdatum;
  if (p.heimatort_nationalitaet) emp.nationality = p.heimatort_nationalitaet;
  if (p.telefon) emp.phone = p.telefon;
  if (p.email) emp.email = p.email;
  if (p.strasse) emp.addressStreet = p.strasse;
  if (p.plz) emp.addressZip = p.plz;
  if (p.ort) emp.addressCity = p.ort;
  if (l.ahv_nr) emp.ahvNumber = l.ahv_nr;
  if (l.iban) emp.iban = l.iban;
  if (record.funktion) emp.positionTitle = record.funktion;
  if (record.eintritt) emp.contractStart = record.eintritt;
  if (v.ferientage != null) emp.vacationDaysPerYear = v.ferientage;

  return { employee: emp, hinweise };
}
