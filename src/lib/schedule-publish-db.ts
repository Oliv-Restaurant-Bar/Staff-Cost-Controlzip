/**
 * Dienstplan veröffentlichen — Supabase-Zugriff (nur über RPC, siehe
 * supabase/migrations/20261023_schedule_share.sql).
 *
 * Datenbank zuerst: kein localStorage-Cache. Jeder Fehler wird als Error
 * geworfen, damit die UI ihn anzeigen kann (kein stilles Scheitern).
 */
import { supabase } from '@/integrations/supabase/client';
import type { ShareDepartment, WeekPayload } from '@/lib/schedule-publish-payload';

type RpcResult = PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
const rpc = supabase.rpc.bind(supabase) as unknown as (fn: string, args: Record<string, unknown>) => RpcResult;

const TIMEOUT_MS = 12_000;

async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Zeitüberschreitung — bitte erneut versuchen')), TIMEOUT_MS);
  });
  try {
    const { data, error } = await Promise.race([rpc(fn, args), timeout]);
    if (error) {
      throw new Error(error.code === '42501' ? 'Keine Berechtigung für diese Abteilung' : error.message);
    }
    return data as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface PublishedWeekRecord {
  payload: WeekPayload;
  revision: number;
  published_at: string;
}

export interface PublicScheduleResponse {
  tenant: string;
  department: ShareDepartment;
  weeks: Array<{
    week_start: string;
    revision: number;
    published_at: string;
    payload: WeekPayload;
  }>;
}

export const getShareToken = (tenant: string, department: ShareDepartment) =>
  call<string>('schedule_share_get_link', { p_tenant: tenant, p_department: department });

export const rotateShareToken = (tenant: string, department: ShareDepartment) =>
  call<string>('schedule_share_rotate_link', { p_tenant: tenant, p_department: department });

export const publishWeek = (
  tenant: string,
  department: ShareDepartment,
  weekStart: string,
  payload: WeekPayload,
) =>
  call<number>('schedule_share_publish_week', {
    p_tenant: tenant,
    p_department: department,
    p_week_start: weekStart,
    p_payload: payload,
  });

export const getPublishedWeek = (tenant: string, department: ShareDepartment, weekStart: string) =>
  call<PublishedWeekRecord | null>('schedule_share_get_week', {
    p_tenant: tenant,
    p_department: department,
    p_week_start: weekStart,
  });

/** Öffentlich (anon): liefert null bei unbekanntem/zurückgesetztem Token. */
export const fetchPublicSchedule = (token: string) =>
  call<PublicScheduleResponse | null>('schedule_public_get', { p_token: token });
