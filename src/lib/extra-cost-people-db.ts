/**
 * Datenbankschicht für schedule_extra_cost_people.
 *
 * Externe Aushilfen und Zusatzkosten-Ressourcen — planbar im Dienstplan,
 * aber KEIN normaler employees-Datensatz. Kein Monatslohn, kein Personalstamm.
 *
 * Tenant-Trennung analog employees:
 *   Oliv     → id ohne b-Präfix (aush_*)
 *   Beaulieu → id mit b-Präfix  (b-aush_*)
 */

import { supabase } from '@/integrations/supabase/client';
import type { Employee } from '@/types/personnel';
import type { TenantId } from '@/contexts/TenantContext';

// ─── Typen ──────────────────────────────────────────────────────────────────

export interface ExtraCostPerson {
  id: string;
  name: string;
  /** Intern 'kueche' (DB-Format) — im Frontend 'küche' */
  department: 'service' | 'kueche';
  hourlyWage: number;
  tenantId: TenantId;
  isActive: boolean;
  createdAt?: string;
  archivedAt?: string | null;
}

// ─── Konverter ───────────────────────────────────────────────────────────────

/** Konvertiert ExtraCostPerson → Employee für Verwendung im Dienstplan. */
export function extraCostPersonToEmployee(p: ExtraCostPerson): Employee {
  return {
    id: p.id,
    name: p.name,
    // Dienstplan und PersonalFix verwenden 'küche' (mit ü), DB speichert 'kueche'
    department: p.department === 'kueche' ? 'küche' : 'service',
    employmentType: 'aushilfe',
    hourlyWage: p.hourlyWage,
  };
}

function dbToExtraCostPerson(row: Record<string, unknown>): ExtraCostPerson {
  return {
    id:          String(row.id),
    name:        String(row.name),
    department:  (row.department as 'service' | 'kueche'),
    hourlyWage:  Number(row.hourly_wage ?? 0),
    tenantId:    (row.tenant_id as TenantId) ?? 'oliv',
    isActive:    Boolean(row.is_active ?? true),
    createdAt:   row.created_at as string | undefined,
    archivedAt:  row.archived_at as string | null | undefined,
  };
}

// ─── DB-Operationen ──────────────────────────────────────────────────────────

/**
 * Lädt alle aktiven Zusatzkosten-Personen für einen Mandanten.
 * Gibt leeres Array zurück bei Fehler (kein null — Tabelle evtl. noch nicht migriert).
 */
export async function loadExtraCostPeople(tenantId: TenantId): Promise<ExtraCostPerson[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from('schedule_extra_cost_people')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .order('name');

    if (error) {
      // Tabelle existiert evtl. noch nicht (Migration nicht ausgeführt)
      if (error.code === '42P01') {
        console.warn('[extra-cost-people] Tabelle schedule_extra_cost_people existiert noch nicht — Migration ausführen.');
        return [];
      }
      console.error('[extra-cost-people] loadExtraCostPeople:', error);
      return [];
    }

    return (data ?? []).map(dbToExtraCostPerson);
  } catch (e) {
    console.error('[extra-cost-people] loadExtraCostPeople exception:', e);
    return [];
  }
}

/**
 * Speichert oder aktualisiert eine Zusatzkosten-Person in Supabase.
 * Generiert eine neue ID wenn keine vorhanden (aush_<timestamp>).
 */
export async function upsertExtraCostPerson(
  person: Omit<ExtraCostPerson, 'id'> & { id?: string },
  tenantId: TenantId,
): Promise<ExtraCostPerson | null> {
  const id = person.id ?? (tenantId === 'beaulieu' ? `b-aush_${Date.now()}` : `aush_${Date.now()}`);
  const dbRow = {
    id,
    name:        person.name.trim(),
    department:  person.department,
    hourly_wage: person.hourlyWage,
    tenant_id:   tenantId,
    is_active:   true,
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from('schedule_extra_cost_people')
      .upsert(dbRow, { onConflict: 'id' })
      .select()
      .single();

    if (error) {
      console.error('[extra-cost-people] upsertExtraCostPerson:', error);
      return null;
    }

    console.log(`[extra-cost-people] upserted: id=${id} name="${person.name}" tenant=${tenantId}`);
    return dbToExtraCostPerson(data);
  } catch (e) {
    console.error('[extra-cost-people] upsertExtraCostPerson exception:', e);
    return null;
  }
}

/**
 * Archiviert eine Zusatzkosten-Person (is_active=false, archived_at=now()).
 * Löscht NICHT — Dienstplan-Einträge bleiben erhalten.
 */
export async function archiveExtraCostPerson(id: string): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from('schedule_extra_cost_people')
      .update({ is_active: false, archived_at: new Date().toISOString() })
      .eq('id', id);

    if (error) {
      console.error('[extra-cost-people] archiveExtraCostPerson:', error);
      return false;
    }

    console.log(`[extra-cost-people] archived: id=${id}`);
    return true;
  } catch (e) {
    console.error('[extra-cost-people] archiveExtraCostPerson exception:', e);
    return false;
  }
}

/**
 * Reaktiviert eine archivierte Zusatzkosten-Person.
 */
export async function reactivateExtraCostPerson(id: string): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from('schedule_extra_cost_people')
      .update({ is_active: true, archived_at: null })
      .eq('id', id);

    if (error) {
      console.error('[extra-cost-people] reactivateExtraCostPerson:', error);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[extra-cost-people] reactivateExtraCostPerson exception:', e);
    return false;
  }
}
