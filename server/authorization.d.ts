import type { IncomingMessage, ServerResponse } from 'node:http';

export type ServerCapability = 'finance' | 'cockpit-export';

export function isServerCapabilityAllowed(
  role: unknown,
  capability: ServerCapability,
): boolean;

export function createAuthorizationHandler(config?: {
  supabaseUrl?: string;
  publishableKey?: string;
}): (
  req: Pick<IncomingMessage, 'url' | 'method' | 'headers'>,
  res: ServerResponse,
) => Promise<boolean>;