// Daily Vercel Cron (see vercel.json) — keeps the Supabase project from being
// paused for inactivity (free tier). Read-only: calls a function that only
// returns now().

export default async function handler(
  req: { headers: Record<string, string | string[] | undefined> },
  res: { status: (code: number) => { json: (body: unknown) => void } },
) {
  // Vercel sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is set.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) {
    res.status(500).json({ ok: false, error: 'missing Supabase env vars' });
    return;
  }

  try {
    const response = await fetch(`${url}/rest/v1/rpc/keepalive_ping`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    if (!response.ok) {
      res.status(502).json({ ok: false, status: response.status });
      return;
    }
    res.status(200).json({ ok: true, at: await response.json() });
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'fetch failed' });
  }
}
