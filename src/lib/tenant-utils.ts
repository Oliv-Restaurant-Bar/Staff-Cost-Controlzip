/**
 * tenant-utils – Mandantenspezifische Hilfsfunktionen
 * =====================================================
 * Kapselt den Zugriff auf localStorage und den Supabase-KV-Store
 * mit automatischem Mandanten-Präfix.
 *
 * Schlüsselprinzip:
 *   - Oliv      → Keys unverändert (volle Rückwärtskompatibilität mit bestehenden Daten)
 *   - Beaulieu  → Keys mit Präfix "beaulieu:"
 *
 * Debug-Logs: [TENANT]
 */

import { kvGet, kvSet } from './supabase-kv';
import type { TenantId } from '@/contexts/TenantContext';

/**
 * Berechnet den mandantenspezifischen Key.
 * Oliv nutzt keine Präfix, um bestehende Daten nicht zu migrieren.
 */
export function tenantKey(tenantId: TenantId, key: string): string {
  return tenantId === 'oliv' ? key : `${tenantId}:${key}`;
}

// ─── localStorage ─────────────────────────────────────────────────────────────

export function tlsGet(tenantId: TenantId, key: string): string | null {
  const k = tenantKey(tenantId, key);
  return localStorage.getItem(k);
}

export function tlsGetJson<T>(tenantId: TenantId, key: string): T | null {
  const raw = tlsGet(tenantId, key);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export function tlsSet(tenantId: TenantId, key: string, value: string): void {
  const k = tenantKey(tenantId, key);
  localStorage.setItem(k, value);
}

export function tlsSetJson(tenantId: TenantId, key: string, value: unknown): void {
  tlsSet(tenantId, key, JSON.stringify(value));
}

export function tlsRemove(tenantId: TenantId, key: string): void {
  const k = tenantKey(tenantId, key);
  localStorage.removeItem(k);
}

// ─── Supabase KV Store ────────────────────────────────────────────────────────

export async function tkvGet(tenantId: TenantId, key: string): Promise<unknown | null> {
  const k = tenantKey(tenantId, key);
  return kvGet(k);
}

export async function tkvSet(tenantId: TenantId, key: string, value: unknown): Promise<void> {
  const k = tenantKey(tenantId, key);
  return kvSet(k, value);
}

// ─── Bekannte schlüssel ───────────────────────────────────────────────────────

export const TENANT_KEYS = {
  scheduleEmployees:        'schedule-employees',
  dailyBudgets:             'dailyBudgets',
  dailyRevenueOverrides:    'dailyRevenueOverrides',
  reportingV1:              'reporting_v1',
  personalFixVarHours:      'personal_fix_var_hours_v1',
  laborCostThreshold:       'labor_cost_threshold',
  scheduleMonth:            (monthKey: string) => `schedule-v2-${monthKey}`,
  actualHoursMonth:         (monthKey: string) => `actual-hours-${monthKey}`,
  absenceKvPrefix:          'schedule_absences_',
  absenceMonth:             (monthKey: string) => `schedule_absences_${monthKey}`,
} as const;
