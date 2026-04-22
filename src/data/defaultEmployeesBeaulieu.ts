/**
 * Echte Beaulieu-Mitarbeitende (Seed-Daten)
 * ==========================================
 * Quelle: Mirus Personalstamm (Stand 22.04.2026) + Lohnblatt.pdf (22.04.2026)
 *
 * Nur aktive Mitarbeitende (kein Austrittsdatum im Mirus-Export):
 *   10 Personen — Barrera, Burkhalter, Elmazi, Firlovic, Hadzija,
 *                  Horvath, Krebs, Ramadani, Redzepi, Svyrydovych
 *
 * Ausgeschlossen wegen Austrittsdatum:
 *   - Bröcker Christin Susann (Austritt 22.03.2026)
 *   - Makhiouba Djamal (Austritt 29.03.2026)
 *   - Santana Cristo Barreto (vom GF nicht übernommen)
 *
 * Abteilungs-Mapping:
 *   1 Küche          → küche
 *   3 Hilfsarbeiter  → küche  (Elmazi, Ramadani)
 *   2 Service        → service
 *   4 Geschäftsleitr → service (Krebs, Redzepi)
 *
 * IDs: b-{MirusPNR} — starten alle mit "b-" für Beaulieu-Erkennung
 *
 * Löhne (Quelle: Lohnblatt.pdf):
 *   - Barrera, Burkhalter, Elmazi, Horvath: komplett aus Lohnblatt
 *   - Firlovic, Hadzija: variabel (hourly) – Stundenlohn noch offen
 *   - Krebs, Ramadani, Redzepi, Svyrydovych: nicht im Lohnblatt
 *
 * [BEAULIEU-STAFF] Logs werden vom seedBeaulieuEmployees emittiert.
 */

import { Employee } from '@/types/personnel';

export const defaultEmployeesBeaulieu: Employee[] = [

  // ── KÜCHE ────────────────────────────────────────────────────────────────
  // (Kostenstelle 1 Küche + 3 Hilfsarbeiter → department: küche)
  {
    id: 'b-169',
    name: 'Barrera Hinestroza Jonathan Filipe',
    department: 'küche',
    employmentType: 'vollzeit',
    weeklyHours: 42,
    // Lohnblatt: Festlohn 4'500 + 13. Mon. 375 = Bruttolohn 4'875
    monthlySalary: 4500,
    monthlySalaryWith13th: 4875,
    has13thSalary: true,
    hourlyWage: 0,
    // Stammdaten aus Mirus
    birthDate: '1991-09-08',
    ahvNumber: '756.4606.8290.43',
    contractStart: '2025-05-16',
    addressZip: '3012',
    addressCity: 'Bern',
  },
  {
    id: 'b-41',
    name: 'Elmazi Fatmire',
    department: 'küche',
    employmentType: 'vollzeit',
    weeklyHours: 42,
    // Lohnblatt: Festlohn 3'895.80 + 13. Mon. 324.65 = Bruttolohn 4'220.45
    monthlySalary: 3895.80,
    monthlySalaryWith13th: 4220.45,
    has13thSalary: true,
    hourlyWage: 0,
    birthDate: '1973-03-04',
    ahvNumber: '756.2698.8108.33',
    contractStart: '2021-09-01',
    addressStreet: 'Allmendstrasse 2',
    addressZip: '3800',
    addressCity: 'Interlaken',
  },
  {
    id: 'b-181',
    name: 'Hadzija Hatidze',
    department: 'küche',
    employmentType: 'vollzeit',
    weeklyHours: 42,
    // Lohnblatt: variabel (hourly) – Stundenlohn bitte im Personalstamm nachtragen
    hourlyWage: 0,
    birthDate: '1968-11-07',
    ahvNumber: '756.4106.1054.70',
    contractStart: '2025-08-28',
    addressZip: '3014',
    addressCity: 'Bern',
  },
  {
    id: 'b-207',
    name: 'Horvath Robert Stefan',
    department: 'küche',
    employmentType: 'vollzeit',
    weeklyHours: 42,
    // Lohnblatt: Festlohn 5'500/Mt (Eintritt 23.03.2026, kein 13. im Lohnblatt)
    monthlySalary: 5500,
    monthlySalaryWith13th: 5500,
    has13thSalary: false,
    hourlyWage: 0,
    birthDate: '1980-11-07',
    ahvNumber: '756.7794.9978.53',
    contractStart: '2026-03-23',
    addressZip: '3280',
    addressCity: 'Greng',
  },
  {
    id: 'b-77',
    name: 'Ramadani Naip',
    department: 'küche',
    employmentType: 'vollzeit',
    weeklyHours: 42,
    // Lohnblatt: nicht enthalten – Stundenlohn bitte im Personalstamm nachtragen
    hourlyWage: 0,
    birthDate: '1964-02-08',
    ahvNumber: '756.2968.1568.07',
    contractStart: '2021-12-01',
    addressStreet: 'Weimattweg 13',
    addressZip: '3018',
    addressCity: 'Bern',
  },

  // ── SERVICE ───────────────────────────────────────────────────────────────
  // (Kostenstelle 2 Service + 4 Geschäftsleitung → department: service)
  {
    id: 'b-62',
    name: 'Burkhalter Nadica',
    department: 'service',
    employmentType: 'vollzeit',
    weeklyHours: 42,
    // Lohnblatt: Gesamtlohn 4'338.45 + 13. Mon. 361.55 = Bruttolohn 4'700
    monthlySalary: 4338.45,
    monthlySalaryWith13th: 4700,
    has13thSalary: true,
    hourlyWage: 0,
    birthDate: '1982-07-27',
    ahvNumber: '756.8069.5931.83',
    contractStart: '2021-11-01',
    addressZip: '1700',
    addressCity: 'Fribourg',
  },
  {
    id: 'b-50',
    name: 'Firlovic Maja',
    department: 'service',
    employmentType: 'teilzeit',
    // Lohnblatt: variabel (hourly, Teilzeit) – Stundenlohn bitte im Personalstamm nachtragen
    hourlyWage: 0,
    birthDate: '1998-08-05',
    ahvNumber: '756.7725.5375.09',
    contractStart: '2023-10-01',
    addressZip: '1700',
    addressCity: 'Fribourg',
  },
  {
    id: 'b-200',
    name: 'Krebs Marcel',
    department: 'service',
    employmentType: 'vollzeit',
    weeklyHours: 42,
    // Lohnblatt: nicht enthalten – Stundenlohn bitte im Personalstamm nachtragen
    hourlyWage: 0,
    birthDate: '1985-10-30',
    ahvNumber: '756.4789.6865.49',
    contractStart: '2026-01-01',
    addressZip: '3019',
    addressCity: 'Bern',
  },
  {
    id: 'b-161',
    name: 'Redzepi Nehat',
    department: 'service',
    employmentType: 'vollzeit',
    weeklyHours: 42,
    // Lohnblatt: nicht enthalten – Stundenlohn bitte im Personalstamm nachtragen
    hourlyWage: 0,
    birthDate: '1976-11-24',
    ahvNumber: '756.4825.9938.15',
    contractStart: '2025-03-01',
    addressZip: '3098',
    addressCity: 'Köniz',
  },
  {
    id: 'b-183',
    name: 'Svyrydovych Varvara',
    department: 'service',
    employmentType: 'vollzeit',
    weeklyHours: 42,
    // Lohnblatt: nicht enthalten – Stundenlohn bitte im Personalstamm nachtragen
    hourlyWage: 0,
    birthDate: '2004-03-01',
    ahvNumber: '756.3543.1068.73',
    contractStart: '2025-08-01',
    addressStreet: 'Pappelweg 36',
    addressZip: '3084',
    addressCity: 'Wabern',
  },
];
