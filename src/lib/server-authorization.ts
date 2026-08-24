import { supabase } from '@/integrations/supabase/client';

export type ServerCapability = 'finance' | 'cockpit-export';

export class ServerAuthorizationError extends Error {
  constructor(public readonly status: number) {
    super(status === 403 ? 'Keine Berechtigung für diese Aktion.' : 'Berechtigung konnte nicht geprüft werden.');
    this.name = 'ServerAuthorizationError';
  }
}

/**
 * Fail-closed Autorisierung unmittelbar vor geschützten Downloads/Aktionen.
 * Die UI-Ausblendung ist nur Komfort; der Server entscheidet anhand des
 * aktuellen Supabase-JWT und der DB-Rolle.
 */
export async function requireServerCapability(capability: ServerCapability): Promise<void> {
  const { data, error } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (error || !token) throw new ServerAuthorizationError(401);

  const response = await fetch(`/api/authz/${capability}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new ServerAuthorizationError(response.status);
}