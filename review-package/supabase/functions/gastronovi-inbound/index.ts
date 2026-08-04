// ============================================================================
// gastronovi-inbound — Webhook-Eingang für Z-Bericht-PDFs (z. B. aus n8n)
// ============================================================================
//
// POST multipart/form-data:
//   file          PDF-Datei (application/pdf)
//   restaurant_id 'oliv' | 'beaulieu'
//
// Auth: Header `x-inbound-secret` muss dem Function-Secret
//   GASTRONOVI_INBOUND_SECRET entsprechen (verify_jwt = false, eigener Check).
//
// Ablauf: sha256 über die PDF-Bytes → Duplikat-Check (restaurant_id, file_hash)
//   → Upload nach zbericht-inbox/<restaurant_id>/<file_hash>.pdf (Service-Role)
//   → Zeile in zbericht_inbox (status 'pending').
//
// WICHTIG: Hier wird NICHT geparst. Das PDF-Parsing bleibt vollständig im
//   Browser (Import-Seite, parseGnZBerichtPdf) — diese Function nimmt nur an.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-inbound-secret",
};

const BUCKET = "zbericht-inbox";
const VALID_TENANTS = new Set(["oliv", "beaulieu"]);
/** Obergrenze für eingehende PDFs (Z-Berichte sind wenige hundert KB gross). */
const MAX_PDF_BYTES = 15 * 1024 * 1024;

/** Timing-sicherer Vergleich über sha256-Digests (Längen-Leak unkritisch). */
async function secretsMatch(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const ua = new Uint8Array(da), ub = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json(405, { error: "Nur POST wird unterstützt" });
  }

  // ── Secret-Check (eigene Auth, verify_jwt = false) ─────────────────────────
  const expected = Deno.env.get("GASTRONOVI_INBOUND_SECRET") ?? "";
  if (!expected) {
    console.error("[gastronovi-inbound] GASTRONOVI_INBOUND_SECRET ist nicht gesetzt");
    return json(500, { error: "Function-Secret nicht konfiguriert" });
  }
  const provided = req.headers.get("x-inbound-secret") ?? "";
  if (provided.length === 0 || !(await secretsMatch(provided, expected))) {
    return json(401, { error: "Unauthorized" });
  }

  try {
    // ── Multipart lesen und validieren ───────────────────────────────────────
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return json(400, { error: "Erwartet multipart/form-data mit Feldern 'file' und 'restaurant_id'" });
    }

    const restaurantId = String(form.get("restaurant_id") ?? "").trim();
    if (!VALID_TENANTS.has(restaurantId)) {
      return json(400, { error: "restaurant_id muss 'oliv' oder 'beaulieu' sein" });
    }

    const file = form.get("file");
    if (!(file instanceof File)) {
      return json(400, { error: "Feld 'file' (PDF-Datei) fehlt" });
    }
    if (file.type && file.type !== "application/pdf") {
      return json(400, { error: `Nur application/pdf erlaubt (erhalten: ${file.type})` });
    }
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength === 0) {
      return json(400, { error: "Leere Datei" });
    }
    if (bytes.byteLength > MAX_PDF_BYTES) {
      return json(400, { error: `Datei zu gross (max. ${MAX_PDF_BYTES / (1024 * 1024)} MB)` });
    }
    // Magic-Bytes prüfen: echte PDFs beginnen mit «%PDF-».
    const head = new TextDecoder().decode(new Uint8Array(bytes.slice(0, 5)));
    if (head !== "%PDF-") {
      return json(400, { error: "Datei ist kein PDF (fehlende %PDF-Signatur)" });
    }

    const fileHash = await sha256Hex(bytes);
    const fileName = (file.name || "zbericht.pdf").slice(0, 300);
    const storagePath = `${restaurantId}/${fileHash}.pdf`;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    // ── Duplikat-Check (Idempotenz über UNIQUE (restaurant_id, file_hash)) ──
    const { data: existing, error: dupErr } = await supabase
      .from("zbericht_inbox")
      .select("id, status")
      .eq("restaurant_id", restaurantId)
      .eq("file_hash", fileHash)
      .maybeSingle();
    if (dupErr) {
      console.error("[gastronovi-inbound] Duplikat-Check fehlgeschlagen:", dupErr.message);
      return json(500, { error: "Duplikat-Prüfung fehlgeschlagen: " + dupErr.message });
    }
    if (existing) {
      return json(200, { status: "duplicate", id: existing.id });
    }

    // ── PDF in den privaten Bucket laden ─────────────────────────────────────
    // upsert: derselbe Hash ergibt denselben Pfad — ein Re-Upload ist harmlos.
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, bytes, { contentType: "application/pdf", upsert: true });
    if (upErr) {
      console.error("[gastronovi-inbound] Upload fehlgeschlagen:", upErr.message);
      return json(500, { error: "Upload fehlgeschlagen: " + upErr.message });
    }

    // ── Inbox-Zeile anlegen ──────────────────────────────────────────────────
    const { data: row, error: insErr } = await supabase
      .from("zbericht_inbox")
      .insert({
        restaurant_id: restaurantId,
        file_name: fileName,
        storage_path: storagePath,
        file_hash: fileHash,
        status: "pending",
      })
      .select("id")
      .single();
    if (insErr || !row) {
      // Race: paralleler Request hat dieselbe Datei gerade eingefügt.
      if (insErr?.code === "23505") {
        const { data: raced } = await supabase
          .from("zbericht_inbox")
          .select("id")
          .eq("restaurant_id", restaurantId)
          .eq("file_hash", fileHash)
          .maybeSingle();
        return json(200, { status: "duplicate", id: raced?.id ?? null });
      }
      console.error("[gastronovi-inbound] Insert fehlgeschlagen:", insErr?.message);
      return json(500, { error: "Speichern fehlgeschlagen: " + (insErr?.message ?? "unbekannt") });
    }

    return json(200, { status: "pending", id: row.id });
  } catch (e) {
    console.error("[gastronovi-inbound] Unerwarteter Fehler:", e);
    return json(500, { error: e instanceof Error ? e.message : String(e) });
  }
});
