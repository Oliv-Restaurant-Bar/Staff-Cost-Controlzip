/**
 * Echte Beaulieu-Mitarbeitende (Seed-Daten)
 * ==========================================
 * Quelle: Mirus Tägliche Stunden + Benutzerdefinierte Korrekturen
 *
 * Diese Liste wird von seedBeaulieuEmployees() (src/lib/supabase-db.ts)
 * verwendet, um die Mitarbeitenden einmalig in Supabase zu schreiben.
 * Im normalen Betrieb werden Daten direkt aus Supabase geladen
 * (employees WHERE restaurant_id = 'beaulieu').
 *
 * Abteilungs-Mapping:
 *   1 Küche         → küche
 *   3 Hilfsarbeiter → küche  (Elmazi + Ramadani in beiden Listen → je 1 Eintrag)
 *   2 Service       → service
 *   4 Geschäftsltg. → service (nur Marcel Krebs)
 *
 * IDs: Präfix "b-" verhindert Kollisionen mit Oliv-IDs (integer 1–24)
 * Lohn: 0 als Platzhalter → in Personalstamm nachpflegen
 */

import { Employee } from '@/types/personnel';

export const defaultEmployeesBeaulieu: Employee[] = [

  // ── KÜCHE ────────────────────────────────────────────────────────────────
  // (1 Küche + 3 Hilfsarbeiter → beide Abteilungen = küche)
  {
    id: 'b-1',
    name: 'Barrera Hinestroza Jonathan Filipe',
    department: 'küche',
    employmentType: 'vollzeit',
    hourlyWage: 0,
    weeklyHours: 42,
  },
  {
    id: 'b-2',
    name: 'Elmazi Fatmire',
    department: 'küche',
    employmentType: 'vollzeit',
    hourlyWage: 0,
    weeklyHours: 42,
  },
  {
    id: 'b-3',
    name: 'Hadzija Hatidze',
    department: 'küche',
    employmentType: 'vollzeit',
    hourlyWage: 0,
    weeklyHours: 42,
  },
  {
    id: 'b-4',
    name: 'Horvath Robert Stefan',
    department: 'küche',
    employmentType: 'vollzeit',
    hourlyWage: 0,
    weeklyHours: 42,
  },
  {
    id: 'b-5',
    name: 'Ramadani Naip',
    department: 'küche',
    employmentType: 'vollzeit',
    hourlyWage: 0,
    weeklyHours: 42,
  },
  {
    id: 'b-6',
    name: 'Santana Cristo Barreto',
    department: 'küche',
    employmentType: 'vollzeit',
    hourlyWage: 0,
    weeklyHours: 42,
  },

  // ── SERVICE ───────────────────────────────────────────────────────────────
  // (2 Service + Marcel Krebs aus 4 Geschäftsleitung)
  {
    id: 'b-7',
    name: 'Burkhalter Nadica',
    department: 'service',
    employmentType: 'vollzeit',
    hourlyWage: 0,
    weeklyHours: 42,
  },
  {
    id: 'b-8',
    name: 'Filipovic Maja',
    department: 'service',
    employmentType: 'teilzeit',
    hourlyWage: 0,
  },
  {
    id: 'b-9',
    name: 'Syvrydovych Varvara',
    department: 'service',
    employmentType: 'vollzeit',
    hourlyWage: 0,
    weeklyHours: 42,
  },
  {
    id: 'b-10',
    name: 'Krebs Marcel',
    department: 'service',
    employmentType: 'vollzeit',
    hourlyWage: 0,
    weeklyHours: 42,
  },
];
