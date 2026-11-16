// POST /api/authz/finance | /api/authz/cockpit-export — server-side role check
// right before protected downloads. Reuses the same handler the Vite dev/preview
// middleware uses (server/authorization.js) so there is one implementation.
// Without this file Vercel has no route for /api/authz/* and the call 404s.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAuthorizationHandler } from '../../server/authorization.js';

const handle = createAuthorizationHandler();

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const handled = await handle(req, res);
  if (!handled) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not_found' }));
  }
}
