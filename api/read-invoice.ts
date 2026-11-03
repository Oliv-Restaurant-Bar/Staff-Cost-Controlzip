// POST /api/read-invoice — reads a scanned/photographed supplier invoice with a
// vision model via OpenRouter and returns the structured JSON. Nothing is saved
// here; the browser validates, maps, shows a preview and the user confirms.
//
// Security:
//  - OPENROUTER_API_KEY / OPENROUTER_MODEL are server-side env vars only (never VITE_).
//  - The caller must be signed in (Supabase JWT) with role admin or beaulieu_manager
//    (same as warenrechnungenPerms.canCreate in usePermissions.ts).
//  - Request size, page count and per-user rate are limited; no image data is logged.
import { INVOICE_JSON_SCHEMA, SYSTEM_PROMPT } from './_invoice-schema';

interface Req {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}
interface Res {
  status: (code: number) => { json: (body: unknown) => void };
}

export const config = { maxDuration: 120 };

const ALLOWED_ROLES = ['admin', 'beaulieu_manager'];
const MAX_PAGES = 6;
const MAX_PAGE_B64 = 1_400_000;      // ~1 MB JPEG per page
const MAX_TOTAL_B64 = 4_000_000;     // stays under Vercel's 4.5 MB body limit
const RATE_LIMIT = 20;               // reads per user per hour (best-effort, per instance)
const RATE_WINDOW_MS = 60 * 60 * 1000;

const calls = new Map<string, number[]>();

function rateLimited(userId: string): boolean {
  const now = Date.now();
  const recent = (calls.get(userId) ?? []).filter(t => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) { calls.set(userId, recent); return true; }
  recent.push(now);
  calls.set(userId, recent);
  return false;
}

function header(req: Req, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

async function authenticate(token: string): Promise<{ userId: string; role: string } | null> {
  const url = process.env.VITE_SUPABASE_URL;
  const anon = process.env.VITE_SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !anon) throw new Error('missing Supabase env vars');
  const headers = { apikey: anon, Authorization: `Bearer ${token}` };
  const userRes = await fetch(`${url}/auth/v1/user`, { headers });
  if (!userRes.ok) return null;
  const user = (await userRes.json()) as { id?: string };
  const roleRes = await fetch(`${url}/rest/v1/rpc/get_my_role`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}',
  });
  if (!roleRes.ok || !user.id) return null;
  const role = await roleRes.json();
  return typeof role === 'string' ? { userId: user.id, role } : null;
}

interface OpenRouterResult {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string };
}

async function callModel(apiKey: string, model: string, pages: string[]): Promise<{ status: number; body: OpenRouterResult }> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0,
      // Reading a printed table needs little reasoning; unbounded "thinking" cost 9k tokens / 40 s on a one-page invoice.
      reasoning: { effort: process.env.OPENROUTER_REASONING_EFFORT || 'low' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Read this supplier invoice. Pages follow in order.' },
            ...pages.map(p => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${p}` } })),
          ],
        },
      ],
      response_format: { type: 'json_schema', json_schema: INVOICE_JSON_SCHEMA },
      // Invoice images must not be used for provider training.
      provider: { data_collection: 'deny', require_parameters: true },
    }),
  });
  let body: OpenRouterResult = {};
  try { body = (await res.json()) as OpenRouterResult; } catch { /* non-JSON error body */ }
  return { status: res.status, body };
}

export default async function handler(req: Req, res: Res) {
  const started = Date.now();
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method-not-allowed' }); return; }

  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL;
  if (!apiKey || !model) { res.status(503).json({ ok: false, error: 'not-configured' }); return; }

  const token = (header(req, 'authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }

  let auth: { userId: string; role: string } | null;
  try { auth = await authenticate(token); }
  catch { res.status(500).json({ ok: false, error: 'auth-unavailable' }); return; }
  if (!auth) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
  if (!ALLOWED_ROLES.includes(auth.role)) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }

  const pages = (req.body as { pages?: unknown } | undefined)?.pages;
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > MAX_PAGES
    || !pages.every((p): p is string => typeof p === 'string' && /^[A-Za-z0-9+/=]+$/.test(p) && p.startsWith('/9j/') && p.length <= MAX_PAGE_B64)
    || pages.reduce((s: number, p: string) => s + p.length, 0) > MAX_TOTAL_B64) {
    res.status(400).json({ ok: false, error: 'bad-pages' });
    return;
  }

  if (rateLimited(auth.userId)) { res.status(429).json({ ok: false, error: 'rate-limited' }); return; }

  let outcome: { status: number; body: OpenRouterResult };
  try {
    outcome = await callModel(apiKey, model, pages);
    if (outcome.status === 429 || outcome.status >= 500) outcome = await callModel(apiKey, model, pages); // one retry
  } catch {
    log(auth.userId, model, pages.length, 'network-error', undefined, started);
    res.status(502).json({ ok: false, error: 'model-unreachable' });
    return;
  }

  const content = outcome.body.choices?.[0]?.message?.content;
  if (outcome.status !== 200 || !content) {
    log(auth.userId, model, pages.length, `model-error-${outcome.status}`, outcome.body.usage, started);
    res.status(502).json({ ok: false, error: 'model-failed' });
    return;
  }
  let data: unknown;
  try { data = JSON.parse(content); }
  catch {
    log(auth.userId, model, pages.length, 'invalid-json', outcome.body.usage, started);
    res.status(502).json({ ok: false, error: 'invalid-json' });
    return;
  }
  log(auth.userId, model, pages.length, 'ok', outcome.body.usage, started);
  res.status(200).json({ ok: true, data, model });
}

// One structured line per call; never any image data or invoice content.
function log(userId: string, model: string, pages: number, result: string, usage: OpenRouterResult['usage'], started: number) {
  console.log(JSON.stringify({
    evt: 'read-invoice', userId, model, pages, result,
    promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens, cost: usage?.cost,
    ms: Date.now() - started,
  }));
}
