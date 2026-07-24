// ============================================================================
// personaleintritt-public — öffentliche Phase-2-API (Mitarbeiter per Token)
// ============================================================================
//
// verify_jwt = false. Auth = Einladungs-Token: Der Klartext-Token steht NUR im
// Link; in der DB liegt der sha256-Hex-Hash (invite_token_hash). Jede Aktion
// hasht den Token und sucht den Datensatz — kein direkter Tabellenzugriff aus
// dem Browser (RLS bleibt authenticated-only, hier Service-Role).
//
// Aktionen (POST):
//   JSON  { action: 'get',    token }
//   JSON  { action: 'save',   token, maDaten }        — Zwischenspeichern
//   JSON  { action: 'submit', token, maDaten }        — Absenden ⇒ ausgefuellt
//   multipart form: action=upload, token, typ, file   — Dokument-Upload
//
// Regeln:
//   - Ablauf: invite_expires < now ⇒ 410 (Link abgelaufen).
//   - save/upload/submit NUR aus status='eingeladen' (einmalige Nutzung:
//     nach Absenden ist der Link «verbraucht» — get meldet dann submitted).
//   - get liefert NUR die für Phase 2 nötigen Eckdaten + ma_daten,
//     KEINE Lohnfelder, keine internen Pfade (Datenminimierung).
//   - Uploads: Bucket mitarbeiter-dokumente/<tenant>/<id>/<typ>.<ext>,
//     Bild/PDF, max. 10 MB; Pfad wird in ma_daten.dokumente[typ] vermerkt.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BUCKET = "mitarbeiter-dokumente";
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const DOKUMENT_TYPEN = new Set([
  "ahv_karte", "ausweis_vorne", "ausweis_hinten", "bankkarte", "foto",
]);

const CONTENT_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
};

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

/** Öffentliche Projektion: nur was Phase 2 wirklich braucht (kein Lohn). */
function publicView(row: Row): Record<string, unknown> {
  return {
    status: row.status,
    vertragstyp: row.vertragstyp,
    betrieb: row.betrieb,
    funktion: row.funktion,
    eintritt: row.eintritt,
    pensumProzent: row.pensum_prozent,
    probezeitTage: row.probezeit_tage,
    vertragsdauer: row.vertragsdauer,
    befristetBis: row.befristet_bis,
    maDaten: row.ma_daten ?? {},
  };
}

/** ma_daten-Merge: Formularteile vom Client, dokumente bleibt server-autoritativ. */
function mergeMaDaten(existing: Row | null, incoming: Row | null): Row {
  const base = existing ?? {};
  const inc = incoming ?? {};
  return {
    personalien: inc.personalien ?? base.personalien ?? {},
    vertrag: inc.vertrag ?? base.vertrag ?? {},
    lohnprogramm: inc.lohnprogramm ?? base.lohnprogramm ?? {},
    dokumente: base.dokumente ?? {},   // NIE vom Client — nur Upload-Aktion schreibt hier
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Nur POST wird unterstützt" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return json(500, { error: "Function nicht konfiguriert" });
  }
  const sb = createClient(supabaseUrl, serviceKey);

  try {
    // ── Request lesen: JSON oder multipart (upload) ──────────────────────────
    let action = "";
    let token = "";
    let maDaten: Row | null = null;
    let uploadTyp = "";
    let uploadFile: File | null = null;

    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      action = String(form.get("action") ?? "");
      token = String(form.get("token") ?? "");
      uploadTyp = String(form.get("typ") ?? "");
      const f = form.get("file");
      uploadFile = f instanceof File ? f : null;
    } else {
      let body: Row;
      try {
        body = await req.json();
      } catch {
        return json(400, { error: "Ungültiger Request-Body (JSON erwartet)" });
      }
      action = String(body.action ?? "");
      token = String(body.token ?? "");
      maDaten = body.maDaten && typeof body.maDaten === "object" ? body.maDaten : null;
    }

    if (!["get", "save", "upload", "submit"].includes(action)) {
      return json(400, { error: "Unbekannte Aktion" });
    }
    if (!token || token.length < 20) {
      return json(401, { error: "Token fehlt oder ist ungültig" });
    }

    // ── Datensatz über Token-Hash finden ─────────────────────────────────────
    const tokenHash = await sha256Hex(token);
    const { data: rows, error: findError } = await sb
      .from("personaleintritt")
      .select("*")
      .eq("invite_token_hash", tokenHash)
      .limit(1);
    if (findError) {
      console.error("[personaleintritt-public] find failed:", findError.message);
      return json(500, { error: "Datenbankfehler" });
    }
    const row = rows?.[0] as Row | undefined;
    if (!row) return json(404, { error: "Link ungültig" });

    const expired = row.invite_expires && new Date(row.invite_expires).getTime() < Date.now();

    // ── get ──────────────────────────────────────────────────────────────────
    if (action === "get") {
      if (row.status === "eingeladen" && expired) {
        return json(410, { error: "Link abgelaufen", status: "abgelaufen" });
      }
      if (row.status !== "eingeladen") {
        // Nach dem Absenden (oder weiterem Fortschritt): Link «verbraucht».
        return json(200, { submitted: true, status: row.status });
      }
      return json(200, { submitted: false, record: publicView(row) });
    }

    // ── Schreibaktionen: nur eingeladen + nicht abgelaufen ───────────────────
    if (row.status !== "eingeladen") {
      return json(409, { error: "Die Daten wurden bereits übermittelt.", status: row.status });
    }
    if (expired) {
      return json(410, { error: "Link abgelaufen", status: "abgelaufen" });
    }

    if (action === "save" || action === "submit") {
      const merged = mergeMaDaten(row.ma_daten, maDaten);
      const patch: Row = { ma_daten: merged, updated_at: new Date().toISOString() };
      if (action === "submit") {
        patch.status = "ausgefuellt";
        patch.ausgefuellt_am = new Date().toISOString();
      }
      const { data: updated, error: upError } = await sb
        .from("personaleintritt")
        .update(patch)
        .eq("id", row.id)
        .eq("status", "eingeladen")   // Guard gegen Doppel-Submit/Race
        .select("id");
      if (upError) {
        console.error("[personaleintritt-public] update failed:", upError.message);
        return json(500, { error: "Speichern fehlgeschlagen" });
      }
      if (!updated || updated.length === 0) {
        return json(409, { error: "Die Daten wurden bereits übermittelt." });
      }
      return json(200, { ok: true, submitted: action === "submit" });
    }

    // ── upload ───────────────────────────────────────────────────────────────
    if (!DOKUMENT_TYPEN.has(uploadTyp)) {
      return json(400, { error: "Unbekannter Dokumenttyp" });
    }
    if (!uploadFile) {
      return json(400, { error: "Datei fehlt" });
    }
    const ext = CONTENT_EXT[uploadFile.type ?? ""];
    if (!ext) {
      return json(400, { error: `Nur Bilder (JPG/PNG/WebP/HEIC) oder PDF erlaubt (erhalten: ${uploadFile.type || "unbekannt"})` });
    }
    const bytes = await uploadFile.arrayBuffer();
    if (bytes.byteLength === 0) return json(400, { error: "Leere Datei" });
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      return json(400, { error: "Datei zu gross (max. 10 MB)" });
    }

    const path = `${row.restaurant_id}/${row.id}/${uploadTyp}.${ext}`;
    const { error: storageError } = await sb.storage
      .from(BUCKET)
      .upload(path, bytes, { contentType: uploadFile.type, upsert: true });
    if (storageError) {
      console.error("[personaleintritt-public] upload failed:", storageError.message);
      return json(500, { error: "Upload fehlgeschlagen" });
    }

    const dokumente = { ...(row.ma_daten?.dokumente ?? {}), [uploadTyp]: path };
    const mergedDaten = { ...(row.ma_daten ?? {}), dokumente };
    const { data: updated, error: upError } = await sb
      .from("personaleintritt")
      .update({ ma_daten: mergedDaten, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", "eingeladen")
      .select("id");
    if (upError || !updated || updated.length === 0) {
      console.error("[personaleintritt-public] doc-path update failed:", upError?.message);
      return json(500, { error: "Dokument-Verweis konnte nicht gespeichert werden" });
    }
    return json(200, { ok: true, typ: uploadTyp, path });
  } catch (err) {
    console.error("[personaleintritt-public] unerwarteter Fehler:", err);
    return json(500, { error: "Unerwarteter Fehler" });
  }
});
