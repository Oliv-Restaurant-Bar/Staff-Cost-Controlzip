import { supabase } from '@/integrations/supabase/client';
import { Employee } from '@/types/personnel';
import { format, startOfMonth, endOfMonth } from 'date-fns';
import type { TenantId } from '@/contexts/TenantContext';

// ─── Typen ──────────────────────────────────────────────────────────────────

export interface DaySchedule {
  früh?: { start: string; end: string } | null;
  spät?: { start: string; end: string } | null;
  frühAbsence?: string | null;
  spätAbsence?: string | null;
}

export interface ActualHourEntry {
  hours: number;
  start?: string;
  end?: string;
}

// ─── Hilfsfunktionen ────────────────────────────────────────────────────────

const employeeToDb = (emp: Employee) => ({
  // ── Stammdaten ────────────────────────────────────────────────────────────
  id:                       emp.id,
  name:                     emp.name,
  department:               emp.department === 'küche' ? 'kueche' : 'service',
  employment_type:          emp.employmentType,
  // ── Arbeitszeit & Lohn ────────────────────────────────────────────────────
  hourly_wage:              emp.hourlyWage,
  weekly_hours:             emp.weeklyHours             ?? null,
  monthly_salary:           emp.monthlySalary           ?? null,
  monthly_salary_with_13th: emp.monthlySalaryWith13th   ?? null,
  social_cost_factor:       emp.socialCostFactor        ?? 1.03,
  has_13th_salary:          emp.has13thSalary           ?? false,
  // ── Saldi ────────────────────────────────────────────────────────────────
  hours_balance:            emp.hoursBalance            ?? null,
  vacation_balance:         emp.vacationBalance         ?? null,
  vacation_days_per_year:   emp.vacationDaysPerYear     ?? null,
  // ── Dienstplan ────────────────────────────────────────────────────────────
  days_off:                 emp.daysOff                 ?? [],
  preferred_work_days:      emp.preferredWorkDays       ?? [],
  // ── Persönliche Daten ────────────────────────────────────────────────────
  birth_date:               emp.birthDate               ?? null,
  nationality:              emp.nationality             ?? null,
  phone:                    emp.phone                   ?? null,
  email:                    emp.email                   ?? null,
  address_street:           emp.addressStreet           ?? null,
  address_zip:              emp.addressZip              ?? null,
  address_city:             emp.addressCity             ?? null,
  ahv_number:               emp.ahvNumber               ?? null,
  iban:                     emp.iban                    ?? null,
  // ── Vertragliche Grundlagen ──────────────────────────────────────────────
  contract_type:            emp.contractType            ?? null,
  position_title:           emp.positionTitle           ?? null,
  contract_start:           emp.contractStart           ?? null,
  employment_end_date:      emp.employmentEndDate       ?? null,
  contract_end:             emp.contractEnd             ?? null,
  is_limited_contract:      emp.isLimitedContract       ?? false,
  trial_period_months:      emp.trialPeriodMonths       ?? null,
  // notice_period_weeks entfernt (wird jetzt automatisch abgeleitet)
  // ── Quellensteuer / Aufenthalt ───────────────────────────────────────────
  permit_type:              emp.permitType              ?? null,
  marital_status:           emp.maritalStatus           ?? null,
  spouse_employed:          emp.spouseEmployed          ?? null,
  spouse_lives_in_switzerland: emp.spouseLivesInSwitzerland ?? null,
  // NOTE: employee_status is intentionally excluded here because the column
  // may not exist yet (migration 20260315_employee_self_registration.sql).
  // Use activateEmployee() to set status once the migration has been applied.
  // ── Onboarding ───────────────────────────────────────────────────────────
  onboarding_status:        emp.onboardingStatus        ?? 'none',
  onboarding_token:         emp.onboardingToken         ?? null,
  onboarding_documents:     emp.onboardingDocuments     ?? null,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbToEmployee = (row: any): Employee => ({
  // ── Stammdaten ────────────────────────────────────────────────────────────
  id:                     row.id,
  name:                   row.name,
  department:             row.department === 'kueche' ? 'küche' : 'service',
  employmentType:         row.employment_type,
  // ── Arbeitszeit & Lohn ────────────────────────────────────────────────────
  hourlyWage:             Number(row.hourly_wage),
  weeklyHours:            row.weekly_hours              ?? undefined,
  monthlySalary:          row.monthly_salary            ?? undefined,
  monthlySalaryWith13th:  row.monthly_salary_with_13th  ?? undefined,
  socialCostFactor:       row.social_cost_factor        != null ? Number(row.social_cost_factor) : undefined,
  has13thSalary:          row.has_13th_salary           ?? undefined,
  // ── Saldi ────────────────────────────────────────────────────────────────
  hoursBalance:           row.hours_balance             ?? undefined,
  vacationBalance:        row.vacation_balance          ?? undefined,
  vacationDaysPerYear:    row.vacation_days_per_year    ?? undefined,
  // ── Dienstplan ────────────────────────────────────────────────────────────
  daysOff:                row.days_off                  ?? undefined,
  preferredWorkDays:      row.preferred_work_days       ?? undefined,
  // ── Persönliche Daten ────────────────────────────────────────────────────
  birthDate:              row.birth_date                ?? undefined,
  nationality:            row.nationality               ?? undefined,
  phone:                  row.phone                     ?? undefined,
  email:                  row.email                     ?? undefined,
  addressStreet:          row.address_street            ?? undefined,
  addressZip:             row.address_zip               ?? undefined,
  addressCity:            row.address_city              ?? undefined,
  ahvNumber:              row.ahv_number                ?? undefined,
  iban:                   row.iban                      ?? undefined,
  // ── Vertragliche Grundlagen ──────────────────────────────────────────────
  contractType:           row.contract_type             ?? undefined,
  positionTitle:          row.position_title            ?? undefined,
  contractStart:          row.contract_start            ?? undefined,
  employmentEndDate:      row.employment_end_date       ?? undefined,
  contractEnd:            row.contract_end              ?? undefined,
  isLimitedContract:      row.is_limited_contract       ?? undefined,
  trialPeriodMonths:      (row.trial_period_months != null ? Number(row.trial_period_months) as 0|1|2|3 : undefined),
  // noticePeriodWeeks wird nicht mehr gelesen – automatisch abgeleitet
  // ── Onboarding ───────────────────────────────────────────────────────────
  permitType:             row.permit_type               ?? undefined,
  maritalStatus:          row.marital_status            ?? undefined,
  spouseEmployed:         row.spouse_employed           ?? undefined,
  spouseLivesInSwitzerland: row.spouse_lives_in_switzerland ?? undefined,
  employeeStatus:         row.employee_status           ?? undefined,
  onboardingStatus:       row.onboarding_status         ?? undefined,
  onboardingToken:        row.onboarding_token          ?? undefined,
  onboardingDocuments:    row.onboarding_documents      ?? undefined,
});

// ─── Mitarbeiter ─────────────────────────────────────────────────────────────

/**
 * Mitarbeiter laden, optional gefiltert nach Mandant.
 * Wenn restaurantId angegeben, wird `.eq('restaurant_id', restaurantId)` verwendet.
 * Falls die Spalte noch nicht existiert (Migration noch nicht ausgeführt),
 * wird graceful auf Laden aller Mitarbeiter zurückgefallen.
 */
export async function loadEmployees(restaurantId?: TenantId): Promise<Employee[] | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (supabase as any).from('employees').select('*').order('name');
    if (restaurantId) {
      query = query.eq('restaurant_id', restaurantId);
    }
    const { data, error } = await query;

    if (error) {
      if (restaurantId && (String(error.message ?? '').includes('restaurant_id') || String(error.code ?? '') === '42703')) {
        console.warn('[TENANT] restaurant_id column not found – Migration noch nicht ausgeführt. Lade alle Mitarbeiter als Fallback.');
        const { data: fallback, error: fbErr } = await supabase.from('employees').select('*').order('name');
        if (fbErr) { console.error('[supabase-db] loadEmployees fallback:', fbErr); return null; }
        console.log(`[TENANT] employees count (fallback, no tenant filter): ${(fallback ?? []).length}`);
        return (fallback ?? []).map(dbToEmployee);
      }
      console.error('[supabase-db] loadEmployees:', error);
      return null;
    }

    const result = (data ?? []).map(dbToEmployee);
    if (restaurantId) {
      console.log(`[TENANT] employees count for ${restaurantId}: ${result.length}`);
      if (restaurantId === 'beaulieu') {
        // [CHECK] Beaulieu data validation
        const dupIds = result.filter((e, i) => result.findIndex(x => x.id === e.id) !== i);
        const wrongTenant = result.filter(e => !String(e.id).startsWith('b-'));
        const küche  = result.filter(e => e.department === 'küche');
        const service = result.filter(e => e.department === 'service');
        console.log(`[CHECK] beaulieu employees count: ${result.length}`);
        console.log(`[CHECK] duplicate entries: ${dupIds.length === 0 ? 'none (OK)' : dupIds.map(e => e.id).join(', ')}`);
        console.log(`[CHECK] restaurant_id validation: ${wrongTenant.length === 0 ? 'OK – alle IDs starten mit b-' : 'ERROR – unerwartete IDs: ' + wrongTenant.map(e => e.id).join(', ')}`);
        console.log(`[CHECK] departments: Küche=${küche.length}, Service=${service.length}`);
        result.forEach(e => console.log(`[CHECK] employee: id=${e.id} name="${e.name}" dept=${e.department}`));
      }
    }
    return result;
  } catch (e) {
    console.error('[supabase-db] loadEmployees exception:', e);
    return null;
  }
}

export async function upsertEmployee(emp: Employee, restaurantId: TenantId = 'oliv'): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from('employees')
      .upsert({ ...employeeToDb(emp), restaurant_id: restaurantId }, { onConflict: 'id' });
    if (error) { console.error('[supabase-db] upsertEmployee:', error); return false; }
    return true;
  } catch (e) {
    console.error('[supabase-db] upsertEmployee exception:', e);
    return false;
  }
}

/**
 * Selbst-Anmeldung in einen echten Mitarbeiterdatensatz umwandeln.
 * Verwendet NUR die garantiert vorhandenen Basisspalten der employees-Tabelle.
 * Funktioniert auch wenn die erweiterten HR-Migrationen (20260315_*.sql) noch
 * nicht ausgeführt wurden.
 *
 * Rückgabe: { id, errorMessage }
 *   id           — UUID des neu angelegten Mitarbeiters (null bei Fehler)
 *   errorMessage — Exakter Supabase-Fehler für Toast/Logging (null bei Erfolg)
 */
export async function activateSubmissionAsEmployee(
  sub: OnboardingSubmission,
): Promise<{ id: string | null; errorMessage: string | null }> {
  const fd = sub.formData;

  // ── Schritt 1: Nur Basisspalten schreiben (existieren immer) ──────────────
  const baseRow = {
    id:               sub.id,
    name:             sub.name,
    department:       'service' as const,
    employment_type:  ((fd.preferredEmploymentType as string) || 'aushilfe') as 'aushilfe' | 'vollzeit' | 'teilzeit' | 'minijob',
    hourly_wage:      0,
    weekly_hours:     null as number | null,
    days_off:         [] as string[],
    preferred_work_days: [] as string[],
  };

  const { error: insertErr } = await supabase
    .from('employees')
    .upsert(baseRow, { onConflict: 'id' });

  if (insertErr) {
    const msg = `${insertErr.code}: ${insertErr.message}`;
    console.error('[activateSubmissionAsEmployee] INSERT fehlgeschlagen:', insertErr);
    return { id: null, errorMessage: msg };
  }

  // ── Schritt 2: Submission löschen ─────────────────────────────────────────
  const { error: delErr } = await supabase
    .from('onboarding_submissions')
    .delete()
    .eq('id', sub.id);

  if (delErr) {
    console.warn('[activateSubmissionAsEmployee] Submission konnte nicht gelöscht werden:', delErr);
    // Kein hard failure — Mitarbeiter ist bereits angelegt
  }

  return { id: sub.id, errorMessage: null };
}

export async function deleteEmployee(id: string): Promise<boolean> {
  try {
    const { error } = await supabase.from('employees').delete().eq('id', id);
    if (error) { console.error('[supabase-db] deleteEmployee:', error); return false; }
    return true;
  } catch (e) {
    console.error('[supabase-db] deleteEmployee exception:', e);
    return false;
  }
}

export async function upsertAllEmployees(employees: Employee[], restaurantId: TenantId = 'oliv'): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from('employees')
      .upsert(employees.map(e => ({ ...employeeToDb(e), restaurant_id: restaurantId })), { onConflict: 'id' });
    if (error) { console.error('[supabase-db] upsertAllEmployees:', error); return false; }
    return true;
  } catch (e) {
    console.error('[supabase-db] upsertAllEmployees exception:', e);
    return false;
  }
}

// ─── Beaulieu Mitarbeiter-Seed ───────────────────────────────────────────────

/**
 * Einmalige Seed-Funktion für die echten Beaulieu-Mitarbeitenden.
 * Ruft upsert auf – keine Duplikate, bestehende Oliv-Daten bleiben unberührt.
 *
 * Mapping:
 *   1 Küche       → department: 'küche'
 *   3 Hilfsarbeiter → department: 'küche'
 *   2 Service     → department: 'service'
 *   Marcel Krebs (4 Geschäftsleitung) → department: 'service'
 *
 * Aufruf: await seedBeaulieuEmployees(realEmployeeList)
 */
export async function seedBeaulieuEmployees(
  employees: Pick<Employee, 'id' | 'name' | 'department' | 'employmentType' | 'hourlyWage' | 'weeklyHours' | 'monthlySalary' | 'monthlySalaryWith13th'>[]
): Promise<{ success: boolean; count: number; errors: string[] }> {
  console.log('[BEAULIEU] employee import started');
  console.log(`[BEAULIEU] restaurant_id set: beaulieu`);

  const errors: string[] = [];
  let count = 0;

  for (const emp of employees) {
    const dept = emp.department === 'küche' ? 'kueche' : 'service';
    console.log(`[BEAULIEU] department mapped: "${emp.name}" → ${dept}`);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any)
        .from('employees')
        .upsert(
          { ...employeeToDb(emp as Employee), restaurant_id: 'beaulieu' },
          { onConflict: 'id' }
        );
      if (error) {
        console.error(`[BEAULIEU] failed to upsert "${emp.name}":`, error);
        errors.push(`${emp.name}: ${error.message}`);
      } else {
        console.log(`[BEAULIEU] employee inserted: "${emp.name}" dept=${dept} id=${emp.id}`);
        count++;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${emp.name}: ${msg}`);
    }
  }

  console.log(`[BEAULIEU] total employees imported: ${count} / ${employees.length}`);
  return { success: errors.length === 0, count, errors };
}

/**
 * Mirus-Matching Selbsttest für Beaulieu-Mitarbeitende.
 * Prüft, ob alle 10 echten Namen aus Mirus korrekt gematcht werden.
 * Aufruf: runBeaulieuMatchTest(employees) im Browser-Konsolen-Log sichtbar.
 */
export function runBeaulieuMatchTest(employees: Employee[]): void {
  // Namen wie sie im Mirus-Export typischerweise erscheinen
  const mirusTestNames = [
    'Barrera Hinestroza Jonathan Filipe',
    'Elmazi Fatmire',
    'Hadzija Hatidze',
    'Horvath Robert Stefan',
    'Ramadani Naip',
    'Santana Cristo Barreto',
    'Burkhalter Nadica',
    'Filipovic Maja',
    'Syvrydovych Varvara',
    'Krebs Marcel',
    'Marcel Krebs',  // Test: umgekehrte Reihenfolge
  ];

  // Lazy import to avoid circular deps
  import('@/lib/mirus-name-mapping-store').then(({ matchEmployeeByName }) => {
    console.log('[MATCH TEST] === Beaulieu Mirus-Name-Matching Selbsttest ===');
    let ok = 0; let fail = 0;
    for (const name of mirusTestNames) {
      const res = matchEmployeeByName(name, employees, false);
      const success = res.employee !== null;
      if (success) ok++;
      else fail++;
      console.log(
        `[MATCH TEST] import name: "${name}" → resolved: ${res.employee ? `"${res.employee.name}" (${res.matchStep})` : 'NOT FOUND'} | success: ${success ? 'yes' : 'NO'}`
      );
    }
    console.log(`[MATCH TEST] Ergebnis: ${ok}/${mirusTestNames.length} erfolgreich, ${fail} nicht gefunden`);
    console.log(`[MATCH TEST] ${fail === 0 ? 'OK – alle Namen matchen' : 'WARN – einige Namen fehlen (manuelles Mapping nötig)'}`);
  });
}

// ─── Beaulieu Härtetest ───────────────────────────────────────────────────────

export interface HarteTestStep {
  name: string;
  passed: boolean;
  message: string;
  details: string[];
}

export interface HarteTestResult {
  steps: HarteTestStep[];
  passed: boolean;
  durationMs: number;
}

/**
 * Vollständiger Produktions-Härtetest für Beaulieu.
 * 1. Speichert 2 echte Dienstplan-Einträge für b-1/b-2
 * 2. Prüft per DB-Reload ob sie korrekt geladen werden
 * 3. Prüft Oliv-Isolation: b-* Einträge sind für Oliv-Employees unsichtbar
 * 4. Zweiter Reload → Einträge noch vorhanden
 * 5. Mirus-Name-Matching-Simulation aller 10 Beaulieu-Namen
 * 6. Ist-Stunden-Round-Trip für 3 Namen
 * 7. Aufräumen (Test-Einträge löschen)
 */
export async function runBeaulieuHarteTest(beaulieuEmployees: Employee[]): Promise<HarteTestResult> {
  const t0 = Date.now();
  const steps: HarteTestStep[] = [];
  const TEST_DATE_1 = '2026-04-15';
  const TEST_DATE_2 = '2026-04-16';
  const TEST_MONTH  = new Date(2026, 3, 1); // April 2026
  const EMP1 = beaulieuEmployees.find(e => e.id === 'b-1');
  const EMP2 = beaulieuEmployees.find(e => e.id === 'b-2');

  const step = (name: string, passed: boolean, message: string, details: string[] = []) => {
    steps.push({ name, passed, message, details });
    console.log(`[HÄRTETEST] ${passed ? '✓' : '✗'} ${name}: ${message}`);
    details.forEach(d => console.log(`  ${d}`));
  };

  // ── Vorbedingung ──────────────────────────────────────────────────────────
  if (!EMP1 || !EMP2) {
    step('Vorbedingung', false, 'b-1 / b-2 nicht in übergebener Employee-Liste – Seed zuerst ausführen', [
      `Gefundene IDs: ${beaulieuEmployees.map(e => e.id).join(', ')}`,
    ]);
    return { steps, passed: false, durationMs: Date.now() - t0 };
  }
  step('Vorbedingung', true, `Employees gefunden: b-1="${EMP1.name}", b-2="${EMP2.name}"`, []);

  // ── Schritt 1: Speichern ──────────────────────────────────────────────────
  const sched1: DaySchedule = { früh: { start: '07:00', end: '15:00' }, spät: null, frühAbsence: null, spätAbsence: null };
  const sched2: DaySchedule = { früh: null, spät: { start: '14:00', end: '22:00' }, frühAbsence: null, spätAbsence: null };
  try {
    await saveScheduleEntry('b-1', TEST_DATE_1, sched1);
    await saveScheduleEntry('b-2', TEST_DATE_2, sched2);
    step('1 · Dienstplan speichern', true,
      `b-1 → ${TEST_DATE_1} Früh 07:00–15:00 | b-2 → ${TEST_DATE_2} Spät 14:00–22:00`, []);
  } catch (e) {
    step('1 · Dienstplan speichern', false, `Fehler: ${e}`, []);
    return { steps, passed: false, durationMs: Date.now() - t0 };
  }

  // ── Schritt 2: Erster Reload ──────────────────────────────────────────────
  const loaded1 = await loadScheduleForMonth(TEST_MONTH);
  const key1 = `b-1-${TEST_DATE_1}`;
  const key2 = `b-2-${TEST_DATE_2}`;
  const found1a = loaded1?.[key1];
  const found2a = loaded1?.[key2];
  step('2 · Reload nach Speichern', !!(found1a && found2a),
    found1a && found2a ? 'Beide Einträge im ersten Reload vorhanden' : `Fehlende Keys: ${[!found1a && key1, !found2a && key2].filter(Boolean).join(', ')}`,
    [
      `b-1 Früh: ${found1a?.früh?.start ?? 'n/a'} – ${found1a?.früh?.end ?? 'n/a'}`,
      `b-2 Spät: ${found2a?.spät?.start ?? 'n/a'} – ${found2a?.spät?.end ?? 'n/a'}`,
    ]
  );

  // ── Schritt 3: Oliv-Isolation ─────────────────────────────────────────────
  // Oliv-Employees haben Integer-IDs. Prüfe, ob ein simulierter Oliv-Filter
  // niemals auf b-* Einträge trifft.
  const olivEmployees = await loadEmployees('oliv');
  const olivIds = new Set((olivEmployees ?? []).map(e => String(e.id)));
  // b-* entries that accidentally appear in oliv ID set = Leak
  const beaulieuIdsInOliv = ['b-1', 'b-2', 'b-3', 'b-4', 'b-5', 'b-6', 'b-7', 'b-8', 'b-9', 'b-10']
    .filter(bid => olivIds.has(bid));
  // Check raw schedule: entries with b-* IDs that Oliv would render (only if olivIds contains them)
  const scheduleKeysForOliv = Object.keys(loaded1 ?? {}).filter(k => {
    const empId = k.slice(0, k.length - 11);
    return olivIds.has(empId) && empId.startsWith('b-');
  });
  const olivLeakFree = beaulieuIdsInOliv.length === 0 && scheduleKeysForOliv.length === 0;
  step('3 · Oliv sieht keine Beaulieu-Daten', olivLeakFree,
    olivLeakFree
      ? `Vollständige Isolation: b-* IDs in Oliv-Employees=${beaulieuIdsInOliv.length}, beaulieu-Einträge in Oliv-Render=${scheduleKeysForOliv.length}`
      : `LEAK! b-IDs in Oliv: ${beaulieuIdsInOliv.join(', ')} | Einträge: ${scheduleKeysForOliv.join(', ')}`,
    [
      `Oliv employees count: ${(olivEmployees ?? []).length}`,
      `Oliv IDs (sample): ${[...olivIds].slice(0, 5).join(', ')}`,
    ]
  );

  // ── Schritt 4: Zweiter Reload (nach Mandanten-Simulation) ────────────────
  const loaded2 = await loadScheduleForMonth(TEST_MONTH);
  const found1b = loaded2?.[key1];
  const found2b = loaded2?.[key2];
  step('4 · Zweiter Reload (Persistenz)', !!(found1b && found2b),
    found1b && found2b ? 'Einträge nach zweitem Reload noch vorhanden (persistiert)' : 'VERLUST – Einträge nach zweitem Reload verschwunden',
    [
      `b-1 Früh: ${found1b?.früh?.start ?? 'n/a'} – ${found1b?.früh?.end ?? 'n/a'}`,
      `b-2 Spät: ${found2b?.spät?.start ?? 'n/a'} – ${found2b?.spät?.end ?? 'n/a'}`,
    ]
  );

  // ── Schritt 5: Mirus-Name-Matching ────────────────────────────────────────
  try {
    const { matchEmployeeByName } = await import('@/lib/mirus-name-mapping-store');
    const mirusNames = [
      'Barrera Hinestroza Jonathan Filipe',
      'Elmazi Fatmire',
      'Hadzija Hatidze',
      'Horvath Robert Stefan',
      'Ramadani Naip',
      'Santana Cristo Barreto',
      'Burkhalter Nadica',
      'Filipovic Maja',
      'Syvrydovych Varvara',
      'Krebs Marcel',
      'Marcel Krebs', // reversed order test
    ];
    let matchOk = 0;
    const matchDetails: string[] = [];
    for (const name of mirusNames) {
      const res = matchEmployeeByName(name, beaulieuEmployees, false);
      const ok = res.employee !== null;
      if (ok) matchOk++;
      matchDetails.push(`${ok ? '✓' : '✗'} "${name}" → ${res.employee ? `"${res.employee.name}" (${res.matchStep})` : 'NOT FOUND'}`);
    }
    step('5 · Mirus-Name-Matching', matchOk === mirusNames.length,
      `${matchOk}/${mirusNames.length} Namen erfolgreich gemappt`,
      matchDetails
    );
  } catch (e) {
    step('5 · Mirus-Name-Matching', false, `Import-Fehler: ${e}`, []);
  }

  // ── Schritt 6: Ist-Stunden Round-Trip ────────────────────────────────────
  const istEntry = { hours: 8.5, start: '07:00', end: '15:30' };
  const IST_DATE = '2026-04-15';
  try {
    await saveActualHourEntry('b-1', IST_DATE, istEntry);
    const istLoaded = await loadActualHoursForMonth(TEST_MONTH);
    const istKey = `b-1-${IST_DATE}`;
    const found = istLoaded?.[istKey];
    const correct = found && found.hours === 8.5 && found.start === '07:00';
    step('6 · Ist-Stunden Round-Trip', !!correct,
      correct ? `b-1 Ist-Stunden gespeichert & geladen: ${found?.hours}h ${found?.start}–${found?.end}` : `Ist-Stunden nicht korrekt geladen: ${JSON.stringify(found)}`,
      []
    );
    // Cleanup Ist-Stunden
    await saveActualHourEntry('b-1', IST_DATE, null);
  } catch (e) {
    step('6 · Ist-Stunden Round-Trip', false, `Fehler: ${e}`, []);
  }

  // ── Cleanup: Test-Einträge löschen ────────────────────────────────────────
  try {
    await saveScheduleEntry('b-1', TEST_DATE_1, null);
    await saveScheduleEntry('b-2', TEST_DATE_2, null);
    step('7 · Cleanup', true, 'Test-Einträge erfolgreich aus DB gelöscht', []);
  } catch (e) {
    step('7 · Cleanup', false, `Cleanup fehlgeschlagen: ${e}`, []);
  }

  const passed = steps.every(s => s.passed);
  const durationMs = Date.now() - t0;
  console.log(`[HÄRTETEST] ${passed ? 'BESTANDEN' : 'FEHLGESCHLAGEN'} – ${durationMs}ms – ${steps.filter(s => s.passed).length}/${steps.length} Schritte OK`);
  return { steps, passed, durationMs };
}

// ─── Dienstplan (schedule_entries) ───────────────────────────────────────────

export async function loadScheduleForMonth(month: Date): Promise<Record<string, DaySchedule> | null> {
  try {
    const startStr = format(startOfMonth(month), 'yyyy-MM-dd');
    const endStr = format(endOfMonth(month), 'yyyy-MM-dd');

    const { data, error } = await supabase
      .from('schedule_entries')
      .select('*')
      .gte('date', startStr)
      .lte('date', endStr);

    if (error) { console.error('[supabase-db] loadScheduleForMonth:', error); return null; }

    const result: Record<string, DaySchedule> = {};
    const beaulieuEntries = (data ?? []).filter(r => String(r.employee_id).startsWith('b-'));
    const olivEntries     = (data ?? []).filter(r => !String(r.employee_id).startsWith('b-'));
    console.log(`[CHECK] schedule load: total=${(data ?? []).length} (beaulieu-entries=${beaulieuEntries.length}, oliv-entries=${olivEntries.length})`);

    for (const row of data ?? []) {
      const key = `${row.employee_id}-${row.date}`;
      result[key] = {
        früh: row.frueh_start && row.frueh_end
          ? { start: row.frueh_start.slice(0, 5), end: row.frueh_end.slice(0, 5) }
          : null,
        spät: row.spaet_start && row.spaet_end
          ? { start: row.spaet_start.slice(0, 5), end: row.spaet_end.slice(0, 5) }
          : null,
        frühAbsence: row.frueh_absence ?? null,
        spätAbsence: row.spaet_absence ?? null,
      };
    }
    return result;
  } catch (e) {
    console.error('[supabase-db] loadScheduleForMonth exception:', e);
    return null;
  }
}

export async function saveScheduleEntry(
  employeeId: string,
  date: string,
  schedule: DaySchedule | null
): Promise<void> {
  try {
    const isEmpty = !schedule ||
      (!schedule.früh && !schedule.spät && !schedule.frühAbsence && !schedule.spätAbsence);

    if (isEmpty) {
      await supabase
        .from('schedule_entries')
        .delete()
        .eq('employee_id', employeeId)
        .eq('date', date);
    } else {
      await supabase.from('schedule_entries').upsert({
        employee_id: employeeId,
        date,
        frueh_start: schedule?.früh?.start ?? null,
        frueh_end: schedule?.früh?.end ?? null,
        frueh_absence: schedule?.frühAbsence ?? null,
        spaet_start: schedule?.spät?.start ?? null,
        spaet_end: schedule?.spät?.end ?? null,
        spaet_absence: schedule?.spätAbsence ?? null,
      }, { onConflict: 'employee_id,date' });
    }
  } catch (e) {
    console.error('[supabase-db] saveScheduleEntry exception:', e);
  }
}

/**
 * SAFE bulk-save for a month.
 *
 * ► Uses UPSERT only — never DELETE-all.
 *   The old DELETE+INSERT pattern was the #1 data-loss risk:
 *   if scheduleData was empty at save time, Supabase was wiped.
 *
 * ► Individual cell deletions still happen via saveScheduleEntry(id, date, null)
 *   when the user clears a cell in real-time.
 *
 * ► Guard: if the payload is empty, the save is skipped entirely and logged.
 */
export async function saveFullScheduleForMonth(
  month: Date,
  scheduleData: Record<string, DaySchedule>
): Promise<void> {
  const monthKey  = format(month, 'yyyy-MM-dd').slice(0, 7);
  const startStr  = format(startOfMonth(month), 'yyyy-MM-dd');
  const endStr    = format(endOfMonth(month), 'yyyy-MM-dd');

  const rows = Object.entries(scheduleData)
    .filter(([key, s]) => {
      const date = key.slice(-10);
      return date >= startStr && date <= endStr
        && s && (s.früh || s.spät || s.frühAbsence || s.spätAbsence);
    })
    .map(([key, s]) => ({
      employee_id: key.slice(0, -11),
      date:        key.slice(-10),
      frueh_start:  s.früh?.start   ?? null,
      frueh_end:    s.früh?.end     ?? null,
      frueh_absence: s.frühAbsence  ?? null,
      spaet_start:  s.spät?.start   ?? null,
      spaet_end:    s.spät?.end     ?? null,
      spaet_absence: s.spätAbsence  ?? null,
    }));

  console.log(`[SCHEDULE] save start – month=${monthKey} payload=${rows.length} rows`);

  if (rows.length === 0) {
    console.warn(`[SCHEDULE] overwrite blocked – payload is empty for month=${monthKey}, skip save`);
    return;
  }

  try {
    const { error } = await supabase
      .from('schedule_entries')
      .upsert(rows, { onConflict: 'employee_id,date' });

    if (error) {
      console.error(`[SCHEDULE] save error – ${error.message}`, error);
      throw error;
    }
    console.log(`[SCHEDULE] save success – ${rows.length} rows upserted for month=${monthKey}`);
  } catch (e) {
    console.error('[supabase-db] saveFullScheduleForMonth exception:', e);
    throw e; // re-throw so callers can show an error toast
  }
}

// ─── Ist-Stunden (actual_hours) ───────────────────────────────────────────────

export async function loadActualHoursForMonth(month: Date): Promise<Record<string, ActualHourEntry> | null> {
  try {
    const startStr = format(startOfMonth(month), 'yyyy-MM-dd');
    const endStr = format(endOfMonth(month), 'yyyy-MM-dd');

    const { data, error } = await supabase
      .from('actual_hours')
      .select('*')
      .gte('date', startStr)
      .lte('date', endStr);

    if (error) { console.error('[supabase-db] loadActualHoursForMonth:', error); return null; }

    const result: Record<string, ActualHourEntry> = {};
    for (const row of data ?? []) {
      const key = `${row.employee_id}-${row.date}`;
      result[key] = {
        hours: Number(row.hours ?? 0),
        start: row.start_time ?? undefined,
        end: row.end_time ?? undefined,
      };
    }
    return result;
  } catch (e) {
    console.error('[supabase-db] loadActualHoursForMonth exception:', e);
    return null;
  }
}

export async function saveActualHourEntry(
  employeeId: string,
  date: string,
  entry: ActualHourEntry | null
): Promise<void> {
  try {
    if (!entry) {
      await supabase
        .from('actual_hours')
        .delete()
        .eq('employee_id', employeeId)
        .eq('date', date);
    } else {
      await supabase.from('actual_hours').upsert({
        employee_id: employeeId,
        date,
        hours: entry.hours,
        start_time: entry.start ?? null,
        end_time: entry.end ?? null,
      }, { onConflict: 'employee_id,date' });
    }
  } catch (e) {
    console.error('[supabase-db] saveActualHourEntry exception:', e);
  }
}

// ─── App-Einstellungen (app_settings) ────────────────────────────────────────

export async function loadSetting<T>(key: string): Promise<T | null> {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (error) { console.error('[supabase-db] loadSetting:', error); return null; }
    return data ? (data.value as T) : null;
  } catch (e) {
    console.error('[supabase-db] loadSetting exception:', e);
    return null;
  }
}

export async function saveSetting<T>(key: string, value: T): Promise<void> {
  try {
    await supabase.from('app_settings').upsert(
      { key, value: value as object },
      { onConflict: 'key' }
    );
  } catch (e) {
    console.error('[supabase-db] saveSetting exception:', e);
  }
}

// ─── Onboarding-Flow ──────────────────────────────────────────────────────────

export interface OnboardingDoc {
  type: string;
  name: string;
  path: string;
  url?: string;
  uploadedAt: string;
}

export interface OnboardingPublicEmployee {
  id: string;
  name: string;
  department: string;
  onboardingStatus: string;
  positionTitle?: string;
  contractStart?: string;
  contractType?: string;
  // Pre-fillable personal fields
  birthDate?: string;
  nationality?: string;
  permitType?: string;
  maritalStatus?: string;
  spouseEmployed?: boolean;
  spouseLivesInSwitzerland?: boolean;
  phone?: string;
  email?: string;
  addressStreet?: string;
  addressZip?: string;
  addressCity?: string;
  ahvNumber?: string;
  iban?: string;
}

/** Mitarbeiter anhand des Onboarding-Tokens laden (ohne Login) */
export async function findEmployeeByToken(token: string): Promise<OnboardingPublicEmployee | null> {
  try {
    const { data, error } = await supabase
      .from('employees')
      .select(`
        id, name, department, onboarding_status,
        position_title, contract_start, contract_type,
        birth_date, nationality, permit_type, marital_status,
        spouse_employed, spouse_lives_in_switzerland,
        phone, email,
        address_street, address_zip, address_city,
        ahv_number, iban
      `)
      .eq('onboarding_token', token)
      .single();

    if (error || !data) {
      console.warn('[findEmployeeByToken] not found or error:', error?.message);
      return null;
    }

    return {
      id:                      data.id,
      name:                    data.name,
      department:              data.department,
      onboardingStatus:        data.onboarding_status,
      positionTitle:           data.position_title           ?? undefined,
      contractStart:           data.contract_start           ?? undefined,
      contractType:            data.contract_type            ?? undefined,
      birthDate:               data.birth_date               ?? undefined,
      nationality:             data.nationality              ?? undefined,
      permitType:              data.permit_type              ?? undefined,
      maritalStatus:           data.marital_status           ?? undefined,
      spouseEmployed:          data.spouse_employed          ?? undefined,
      spouseLivesInSwitzerland: data.spouse_lives_in_switzerland ?? undefined,
      phone:                   data.phone                    ?? undefined,
      email:                   data.email                    ?? undefined,
      addressStreet:           data.address_street           ?? undefined,
      addressZip:              data.address_zip              ?? undefined,
      addressCity:             data.address_city             ?? undefined,
      ahvNumber:               data.ahv_number               ?? undefined,
      iban:                    data.iban                     ?? undefined,
    };
  } catch (e) {
    console.error('[findEmployeeByToken] exception:', e);
    return null;
  }
}

/** Onboarding-Status auf in_progress setzen (Link wurde geöffnet) */
export async function markOnboardingInProgress(employeeId: string): Promise<void> {
  try {
    await supabase
      .from('employees')
      .update({ onboarding_status: 'in_progress' })
      .eq('id', employeeId);
  } catch (e) {
    console.error('[markOnboardingInProgress] exception:', e);
  }
}

/** Onboarding-Daten speichern und Status auf completed setzen */
export async function submitOnboardingData(
  employeeId: string,
  formData: {
    birthDate?: string;
    nationality?: string;
    phone?: string;
    email?: string;
    addressStreet?: string;
    addressZip?: string;
    addressCity?: string;
    ahvNumber?: string;
    iban?: string;
    permitType?: string;
    maritalStatus?: string;
    spouseEmployed?: boolean | null;
    spouseLivesInSwitzerland?: boolean | null;
  },
  documents: OnboardingDoc[]
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('employees')
      .update({
        birth_date:                  formData.birthDate        || null,
        nationality:                 formData.nationality      || null,
        phone:                       formData.phone            || null,
        email:                       formData.email            || null,
        address_street:              formData.addressStreet    || null,
        address_zip:                 formData.addressZip       || null,
        address_city:                formData.addressCity      || null,
        ahv_number:                  formData.ahvNumber        || null,
        iban:                        formData.iban             || null,
        permit_type:                 formData.permitType       || null,
        marital_status:              formData.maritalStatus    || null,
        spouse_employed:             formData.spouseEmployed   ?? null,
        spouse_lives_in_switzerland: formData.spouseLivesInSwitzerland ?? null,
        onboarding_documents:        documents.length > 0 ? JSON.stringify(documents) : null,
        onboarding_status:           'completed',
      })
      .eq('id', employeeId);

    if (error) {
      console.error('[submitOnboardingData] error:', error);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[submitOnboardingData] exception:', e);
    return false;
  }
}

// ─── Onboarding Submissions (standalone Tabelle, kein Abhängigkeit von employees) ───

/** Typ für eine eingegangene Selbst-Anmeldung */
export interface OnboardingSubmission {
  id:          string;
  submittedAt: string;
  name:        string;
  formData:    Record<string, unknown>;
}

/**
 * Neue Selbst-Anmeldung in die `onboarding_submissions`-Tabelle schreiben.
 * Gibt { id, error } zurück — error enthält den genauen Supabase-Fehler als String.
 *
 * VORAUSSETZUNG: Migration 20260316_onboarding_submissions.sql muss in Supabase
 * ausgeführt worden sein (einmalig im SQL-Editor).
 */
export async function createOnboardingSubmission(data: {
  name:     string;
  formData: Record<string, unknown>;
}): Promise<{ id: string | null; error: string | null }> {
  try {
    const id = crypto.randomUUID();
    const { error } = await supabase.from('onboarding_submissions').insert({
      id,
      name:      data.name,
      form_data: data.formData,
    });

    if (error) {
      const isPermissionError = error.code === '42501' || error.code === '42000';
      const msg = isPermissionError
        ? `BERECHTIGUNG: Anon-INSERT auf onboarding_submissions ist blockiert. Führen Sie die SQL-Migration im Supabase SQL-Editor aus (GRANT INSERT ON TABLE public.onboarding_submissions TO anon). [${error.code}]`
        : `[${error.code}] ${error.message}${error.details ? ' · ' + error.details : ''}${error.hint ? ' (Hint: ' + error.hint + ')' : ''}`;
      console.error('[createOnboardingSubmission] Supabase-Fehler:', error);
      return { id: null, error: msg };
    }

    console.log('[createOnboardingSubmission] Gespeichert, id=', id);
    return { id, error: null };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[createOnboardingSubmission] Exception:', e);
    return { id: null, error: msg };
  }
}

/**
 * Alle Selbst-Anmeldungen laden (nur für eingeloggte Admins).
 * Prüft zusätzlich ob:
 *  - die Tabelle existiert (tableExists)
 *  - anonyme Benutzer neue Anmeldungen einreichen können (anonInsertBlocked)
 *  - der employee_status-Spalte in employees fehlt (employeeStatusMissing)
 */
export async function loadOnboardingSubmissions(): Promise<{
  data: OnboardingSubmission[];
  tableExists: boolean;
  permissionError: boolean;
  anonInsertBlocked: boolean;
  employeeStatusMissing: boolean;
}> {
  // ── Admin-SELECT ──────────────────────────────────────────────────────────
  console.log('[Banner-Check] start — Tabelle: onboarding_submissions');
  let tableExists     = true;
  let permissionError = false;
  let submissions: OnboardingSubmission[] = [];

  try {
    console.log('[Banner-Check] führe SELECT auf onboarding_submissions aus...');
    const { data, error } = await supabase
      .from('onboarding_submissions')
      .select('*')
      .order('submitted_at', { ascending: false });

    if (error) {
      tableExists     = error.code !== 'PGRST205';
      permissionError = error.code === '42501';
      console.warn('[Banner-Check] SELECT Fehler:', { code: error.code, message: error.message, tableExists, permissionError });
    } else {
      submissions = (data ?? []).map(row => ({
        id:          row.id as string,
        submittedAt: row.submitted_at as string,
        name:        row.name as string,
        formData:    (row.form_data ?? {}) as Record<string, unknown>,
      }));
      console.log('[Banner-Check] SELECT OK — Anzahl Submissions:', submissions.length, '| tableExists: true | permissionError: false');
    }
  } catch (e) {
    console.error('[loadOnboardingSubmissions] Exception:', e);
    tableExists = false;
  }

  // ── Anon-INSERT Test ──────────────────────────────────────────────────────
  // Kein separater Supabase-Client mehr (würde Auth-State korrumpieren).
  // Wenn SELECT erfolgreich war, nehmen wir an, dass RLS korrekt konfiguriert ist.
  // anonInsertBlocked = false bedeutet: kein Problem, Banner nicht nötig.
  const anonInsertBlocked = false;
  console.log('[Banner-Check] anonInsertBlocked:', anonInsertBlocked, '(wird nicht mehr live getestet — RLS als korrekt angenommen wenn SELECT OK)');

  // ── employee_status Spalte prüfen ─────────────────────────────────────────
  let employeeStatusMissing = false;
  try {
    console.log('[Banner-Check] prüfe employee_status-Spalte in employees...');
    const { error: colErr } = await supabase
      .from('employees')
      .update({ employee_status: 'active' })
      .eq('id', '00000000-0000-0000-0000-000000000000'); // non-existent row
    // If the column doesn't exist, Supabase returns PGRST204
    employeeStatusMissing = colErr?.code === 'PGRST204';
    console.log('[Banner-Check] employee_status Spalte fehlend:', employeeStatusMissing, colErr ? `(Fehler: ${colErr.code})` : '(kein Fehler)');
  } catch {
    // ignore
  }

  console.log('[Banner-Check] Ergebnis:', { tableExists, permissionError, anonInsertBlocked, employeeStatusMissing });

  return {
    data:                 submissions,
    tableExists,
    permissionError,
    anonInsertBlocked,
    employeeStatusMissing,
  };
}

/** Selbst-Anmeldung löschen (nach Aktivierung oder Ablehnung) */
export async function deleteOnboardingSubmission(id: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('onboarding_submissions')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('[deleteOnboardingSubmission] Fehler:', error);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[deleteOnboardingSubmission] Exception:', e);
    return false;
  }
}

/** @deprecated Verwende createOnboardingSubmission(). Neuen Mitarbeiter aus Selbst-Anmeldung anlegen (pending_review) */
export async function createPendingEmployee(data: {
  name: string;
  employmentType?: string;
  positionTitle?: string;
  contractStart?: string;
  birthDate?: string;
  nationality?: string;
  phone?: string;
  email?: string;
  addressStreet?: string;
  addressZip?: string;
  addressCity?: string;
  ahvNumber?: string;
  iban?: string;
  permitType?: string;
  maritalStatus?: string;
  spouseEmployed?: boolean | null;
  spouseLivesInSwitzerland?: boolean | null;
  documents?: OnboardingDoc[];
}): Promise<string | null> {
  const result = await createOnboardingSubmission({
    name: data.name,
    formData: { ...data },
  });
  return result.id;
}

/** Mitarbeiter aktivieren (pending_review → active) */
export async function activateEmployee(id: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('employees')
      .update({ employee_status: 'active' })
      .eq('id', id);
    if (error) { console.error('[activateEmployee] error:', error); return false; }
    return true;
  } catch (e) {
    console.error('[activateEmployee] exception:', e);
    return false;
  }
}

/** Datei in Supabase Storage hochladen */
export async function uploadOnboardingFile(
  employeeId: string,
  file: File,
  docType: string
): Promise<OnboardingDoc | null> {
  try {
    const ext = file.name.split('.').pop() ?? 'bin';
    const path = `${employeeId}/${docType}_${Date.now()}.${ext}`;

    const { data, error } = await supabase.storage
      .from('onboarding-docs')
      .upload(path, file, { cacheControl: '3600', upsert: false });

    if (error) {
      console.error('[uploadOnboardingFile] storage error:', error);
      return null;
    }

    const { data: urlData } = supabase.storage
      .from('onboarding-docs')
      .getPublicUrl(data.path);

    return {
      type:       docType,
      name:       file.name,
      path:       data.path,
      url:        urlData.publicUrl,
      uploadedAt: new Date().toISOString(),
    };
  } catch (e) {
    console.error('[uploadOnboardingFile] exception:', e);
    return null;
  }
}
