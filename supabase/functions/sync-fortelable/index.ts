import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

interface ForatableReservation {
  id: string;
  date: string;
  time: string;
  persons: number;
  name?: string;
  status: string;
  table_numbers?: string;
  comment?: string;
}

interface ForatableApiResponse {
  data: ForatableReservation[];
  meta?: {
    total: number;
    per_page: number;
    current_page: number;
  };
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { date_from, date_to } = await req.json();
    
    if (!date_from) {
      return new Response(
        JSON.stringify({ error: 'date_from is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get Foratable settings
    const { data: settings, error: settingsError } = await supabase
      .from('fortelable_settings')
      .select('*')
      .limit(1)
      .maybeSingle();

    if (settingsError) {
      console.error('Settings error:', settingsError);
      return new Response(
        JSON.stringify({ error: 'Failed to fetch settings' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!settings) {
      return new Response(
        JSON.stringify({ error: 'Settings not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!settings.restaurant_hash) {
      return new Response(
        JSON.stringify({ error: 'Restaurant hash not configured' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get API key from environment (secret)
    const apiKey = Deno.env.get('FORATABLE_API_KEY');
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'FORATABLE_API_KEY not configured' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Use date_to if provided, otherwise same as date_from
    const endDate = date_to || date_from;

    // Call Foratable API
    // API endpoint from documentation: GET https://foratable.com/api3/reservations
    const apiUrl = new URL('https://foratable.com/api3/reservations');
    apiUrl.searchParams.set('filter[restaurant_hash]', settings.restaurant_hash);
    apiUrl.searchParams.set('filter[date_from]', date_from);
    apiUrl.searchParams.set('filter[date_to]', endDate);

    console.log('Calling Foratable API:', apiUrl.toString());

    const foratableResponse = await fetch(apiUrl.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    });

    if (!foratableResponse.ok) {
      const errorText = await foratableResponse.text();
      console.error('Foratable API error:', foratableResponse.status, errorText);
      
      return new Response(
        JSON.stringify({ 
          error: 'Failed to fetch from Foratable',
          details: `Status: ${foratableResponse.status}`,
          message: errorText
        }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const foratableData: ForatableApiResponse = await foratableResponse.json();
    const reservations = foratableData.data || [];

    console.log(`Received ${reservations.length} reservations from Foratable`);

    // Clear existing Foratable reservations for this date range
    const { error: deleteError } = await supabase
      .from('fortelable_reservations')
      .delete()
      .gte('date', date_from)
      .lte('date', endDate);

    if (deleteError) {
      console.error('Delete error:', deleteError);
    }

    // Transform and insert new reservations
    const reservationsToInsert = reservations
      .filter((r) => r.status !== 'cancelled' && r.status !== 'storniert')
      .map((r) => {
        // Determine shift based on time (before 15:00 = mittag, after = abend)
        const hour = parseInt(r.time.split(':')[0], 10);
        const shift = hour < 15 ? 'mittag' : 'abend';

        return {
          external_id: r.id,
          date: r.date,
          shift,
          guest_count: r.persons || 0,
          reservation_name: r.name || null,
          synced_at: new Date().toISOString(),
        };
      });

    if (reservationsToInsert.length > 0) {
      const { error: insertError } = await supabase
        .from('fortelable_reservations')
        .insert(reservationsToInsert);

      if (insertError) {
        console.error('Insert error:', insertError);
        throw insertError;
      }
    }

    // Update last sync time
    await supabase
      .from('fortelable_settings')
      .update({ last_sync_at: new Date().toISOString() })
      .eq('id', settings.id);

    return new Response(
      JSON.stringify({ 
        success: true, 
        synced: reservationsToInsert.length,
        total_received: reservations.length,
        message: `${reservationsToInsert.length} Reservationen synchronisiert`
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Sync error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
