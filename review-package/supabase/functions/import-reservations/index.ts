import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key",
};

interface ReservationInput {
  external_id?: string;
  guest_name: string;
  date: string; // YYYY-MM-DD format
  time: string; // HH:MM format
  guest_count: number;
  guest_email?: string;
  guest_phone?: string;
  comment?: string;
  location?: string;
  menu_selection?: string;
  is_confirmed?: boolean;
}

interface ImportRequest {
  reservations: ReservationInput[];
  source_system?: string;
}

// Determine shift based on time
function determineShift(time: string): 'mittag' | 'abend' {
  const hours = parseInt(time.split(':')[0], 10);
  return hours < 15 ? 'mittag' : 'abend';
}

// Validate reservation data
function validateReservation(res: ReservationInput, index: number): string | null {
  if (!res.guest_name || res.guest_name.trim() === '') {
    return `Reservierung ${index + 1}: Name fehlt`;
  }
  if (!res.date || !/^\d{4}-\d{2}-\d{2}$/.test(res.date)) {
    return `Reservierung ${index + 1}: Ungültiges Datum (Format: YYYY-MM-DD)`;
  }
  if (!res.time || !/^\d{1,2}:\d{2}$/.test(res.time)) {
    return `Reservierung ${index + 1}: Ungültige Uhrzeit (Format: HH:MM)`;
  }
  if (!res.guest_count || res.guest_count < 1 || res.guest_count > 500) {
    return `Reservierung ${index + 1}: Ungültige Gästeanzahl (1-500)`;
  }
  return null;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('External import request received');
    
    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Validate API key
    const apiKey = req.headers.get('x-api-key');
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'API-Key fehlt. Bitte im Header x-api-key angeben.' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check API key in database
    const { data: apiKeyData, error: apiKeyError } = await supabase
      .from('external_api_settings')
      .select('*')
      .eq('api_key', apiKey)
      .eq('is_active', true)
      .single();

    if (apiKeyError || !apiKeyData) {
      console.log('Invalid API key:', apiKey.substring(0, 8) + '...');
      return new Response(
        JSON.stringify({ error: 'Ungültiger API-Key' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('API key validated:', apiKeyData.api_key_name);

    // Parse request body
    const body: ImportRequest = await req.json();
    
    if (!body.reservations || !Array.isArray(body.reservations)) {
      return new Response(
        JSON.stringify({ error: 'Ungültiges Format. Erwartet: { reservations: [...] }' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (body.reservations.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Keine Reservierungen zum Importieren' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (body.reservations.length > 100) {
      return new Response(
        JSON.stringify({ error: 'Maximal 100 Reservierungen pro Anfrage erlaubt' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Processing ${body.reservations.length} reservations`);

    const results = {
      success: [] as { external_id?: string; id: string; guest_name: string }[],
      errors: [] as { index: number; external_id?: string; error: string }[],
      updated: [] as { external_id: string; id: string; guest_name: string }[]
    };

    for (let i = 0; i < body.reservations.length; i++) {
      const res = body.reservations[i];
      
      // Validate
      const validationError = validateReservation(res, i);
      if (validationError) {
        results.errors.push({ index: i, external_id: res.external_id, error: validationError });
        continue;
      }

      try {
        const shift = determineShift(res.time);
        const groupType = res.guest_count >= 10 ? 'laufzettel' : 'alacarte';

        // Check if reservation with external_id already exists
        if (res.external_id) {
          const { data: existing } = await supabase
            .from('group_reservations')
            .select('id')
            .eq('external_id', res.external_id)
            .single();

          if (existing) {
            // Update existing reservation
            const { error: updateError } = await supabase
              .from('group_reservations')
              .update({
                group_name: res.guest_name,
                date: res.date,
                shift,
                guest_count: res.guest_count,
                location: res.location || null,
                notes: [res.comment, res.menu_selection].filter(Boolean).join('\n') || null,
                is_confirmed: res.is_confirmed ?? true,
                updated_at: new Date().toISOString()
              })
              .eq('id', existing.id);

            if (updateError) {
              results.errors.push({ index: i, external_id: res.external_id, error: updateError.message });
            } else {
              results.updated.push({ external_id: res.external_id, id: existing.id, guest_name: res.guest_name });
            }
            continue;
          }
        }

        // Insert new reservation
        const { data: inserted, error: insertError } = await supabase
          .from('group_reservations')
          .insert({
            external_id: res.external_id || null,
            group_name: res.guest_name,
            date: res.date,
            shift,
            guest_count: res.guest_count,
            revenue_per_person: 50, // Default value
            location: res.location || null,
            notes: [res.comment, res.menu_selection].filter(Boolean).join('\n') || null,
            group_type: groupType,
            is_confirmed: res.is_confirmed ?? true,
            source: body.source_system || 'external_api'
          })
          .select('id')
          .single();

        if (insertError) {
          results.errors.push({ index: i, external_id: res.external_id, error: insertError.message });
        } else {
          results.success.push({ external_id: res.external_id, id: inserted.id, guest_name: res.guest_name });
        }
      } catch (e) {
        results.errors.push({ 
          index: i, 
          external_id: res.external_id, 
          error: e instanceof Error ? e.message : 'Unbekannter Fehler' 
        });
      }
    }

    // Update API key usage stats
    await supabase
      .from('external_api_settings')
      .update({
        last_used_at: new Date().toISOString(),
        request_count: apiKeyData.request_count + 1
      })
      .eq('id', apiKeyData.id);

    // Log the import
    await supabase
      .from('external_api_import_log')
      .insert({
        api_key_id: apiKeyData.id,
        source_system: body.source_system || null,
        import_type: 'api',
        reservations_count: body.reservations.length,
        success_count: results.success.length + results.updated.length,
        error_count: results.errors.length,
        errors: results.errors.length > 0 ? results.errors : null
      });

    console.log(`Import complete: ${results.success.length} new, ${results.updated.length} updated, ${results.errors.length} errors`);

    return new Response(
      JSON.stringify({
        success: true,
        summary: {
          total: body.reservations.length,
          created: results.success.length,
          updated: results.updated.length,
          errors: results.errors.length
        },
        created: results.success,
        updated: results.updated,
        errors: results.errors
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error processing import:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unbekannter Fehler' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
