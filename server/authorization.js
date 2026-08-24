const CAPABILITY_BY_PATH = new Map([
  ['/api/authz/finance', 'finance'],
  ['/api/authz/cockpit-export', 'cockpit-export'],
]);

export function isServerCapabilityAllowed(role, capability) {
  // Beide servergeschützten Fähigkeiten sind bewusst ausschliesslich Admin.
  return role === 'admin' && (capability === 'finance' || capability === 'cockpit-export');
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

/**
 * Baut einen Middleware-kompatiblen Handler. Rückgabe `true` bedeutet, dass
 * die Anfrage vollständig beantwortet wurde; `false` lässt den SPA-Server
 * beziehungsweise Vite normal weiterarbeiten.
 */
export function createAuthorizationHandler(config = {}) {
  const supabaseUrl = config.supabaseUrl || process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const publishableKey = config.publishableKey
    || process.env.VITE_SUPABASE_PUBLISHABLE_KEY
    || process.env.VITE_SUPABASE_ANON_KEY
    || process.env.SUPABASE_ANON_KEY;

  return async function handleAuthorization(req, res) {
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    const capability = CAPABILITY_BY_PATH.get(path);
    if (!capability) return false;

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      sendJson(res, 405, { error: 'method_not_allowed' });
      return true;
    }

    const authorization = req.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      sendJson(res, 401, { error: 'authentication_required' });
      return true;
    }
    if (!supabaseUrl || !publishableKey) {
      console.error('[authz] Supabase URL/public key missing');
      sendJson(res, 503, { error: 'authorization_unavailable' });
      return true;
    }

    try {
      const upstream = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/get_my_role`, {
        method: 'POST',
        headers: {
          apikey: publishableKey,
          Authorization: authorization,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      if (!upstream.ok) {
        sendJson(res, upstream.status === 401 ? 401 : 403, { error: 'authorization_denied' });
        return true;
      }
      const role = await upstream.json();
      if (!isServerCapabilityAllowed(role, capability)) {
        sendJson(res, 403, { error: 'forbidden' });
        return true;
      }
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return true;
    } catch (error) {
      console.error('[authz] Role verification failed:', error instanceof Error ? error.message : error);
      sendJson(res, 503, { error: 'authorization_unavailable' });
      return true;
    }
  };
}