import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface ParsedReservation {
  reservation_number: string | null;
  guest_name: string;
  guest_email: string | null;
  guest_phone: string | null;
  date: string;
  time: string;
  guest_count: number;
  comment: string | null;
  location: string | null;
}

// Parse German date format (30.01.2026) to ISO format (2026-01-30)
function parseGermanDate(dateStr: string): string | null {
  const match = dateStr.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (match) {
    const [, day, month, year] = match;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  return null;
}

// Parse time format (19:00) to time string
function parseTime(timeStr: string): string | null {
  const match = timeStr.match(/(\d{1,2}):(\d{2})/);
  if (match) {
    const [, hours, minutes] = match;
    return `${hours.padStart(2, '0')}:${minutes}`;
  }
  return null;
}

// Determine shift based on time
function determineShift(time: string): 'mittag' | 'abend' {
  const hours = parseInt(time.split(':')[0], 10);
  return hours < 15 ? 'mittag' : 'abend';
}

// Parse the email body to extract reservation details
function parseForatableEmail(body: string): ParsedReservation | null {
  console.log('Parsing email body...');
  
  // Clean up HTML entities and normalize whitespace
  const cleanBody = body
    .replace(/&#x26;/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/Ã¤/g, 'ä')
    .replace(/Ã¶/g, 'ö')
    .replace(/Ã¼/g, 'ü')
    .replace(/Ã„/g, 'Ä')
    .replace(/Ã–/g, 'Ö')
    .replace(/Ãœ/g, 'Ü')
    .replace(/ÃŸ/g, 'ß')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  console.log('Cleaned body preview:', cleanBody.substring(0, 500));

  // Extract reservation number
  const reservationMatch = cleanBody.match(/Reservationsnummer[:\s]*(\d+)/i);
  const reservationNumber = reservationMatch ? reservationMatch[1] : null;
  console.log('Reservation number:', reservationNumber);

  // Extract name - look for "Name" followed by the value
  const nameMatch = cleanBody.match(/Name[:\s]+([A-ZÄÖÜa-zäöüß\s]+?)(?=\s*E-Mail|\s*Telefon|\s*$)/i);
  let guestName = nameMatch ? nameMatch[1].trim() : null;
  
  // Alternative: extract from subject line pattern
  if (!guestName) {
    const subjectMatch = cleanBody.match(/([A-ZÄÖÜa-zäöüß]+\s+[A-ZÄÖÜa-zäöüß]+)\s*-\s*\d{1,2}\.\s*[A-Za-zäöü]+\s+\d{4}/);
    guestName = subjectMatch ? subjectMatch[1].trim() : 'Unbekannt';
  }
  console.log('Guest name:', guestName);

  // Extract email
  const emailMatch = cleanBody.match(/E-Mail[:\s]+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
  const guestEmail = emailMatch ? emailMatch[1] : null;
  console.log('Guest email:', guestEmail);

  // Extract phone
  const phoneMatch = cleanBody.match(/Telefon[:\s]+([\+\d\s\-()]+)/i);
  const guestPhone = phoneMatch ? phoneMatch[1].trim() : null;
  console.log('Guest phone:', guestPhone);

  // Extract date - look for date pattern in "Datum" section or general pattern
  const dateMatch = cleanBody.match(/Datum[:\s]*(\d{1,2}\.\d{1,2}\.\d{4})/i) ||
                    cleanBody.match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
  const date = dateMatch ? parseGermanDate(dateMatch[1]) : null;
  console.log('Date:', date);

  // Extract time - look for "Zeit" section first
  const timeMatch = cleanBody.match(/Zeit[:\s]*(\d{1,2}:\d{2})/i) ||
                    cleanBody.match(/(\d{1,2}:\d{2})/);
  const time = timeMatch ? parseTime(timeMatch[1]) : null;
  console.log('Time:', time);

  // IMPROVED: Extract guest count with multiple strategies
  let guestCount = 1;
  
  // Strategy 1: Look for "Gäste" label followed by number (most reliable for Foratable)
  const guestLabelMatch = cleanBody.match(/G[äa]ste[:\s]*(\d+)/i);
  if (guestLabelMatch) {
    guestCount = parseInt(guestLabelMatch[1], 10);
    console.log('Guest count from Gäste label:', guestCount);
  } else {
    // Strategy 2: Look for number followed by "Gäste" or "Personen"
    const guestSuffixMatch = cleanBody.match(/(\d+)\s*(?:G[äa]ste|Personen|Pax)/i);
    if (guestSuffixMatch) {
      guestCount = parseInt(guestSuffixMatch[1], 10);
      console.log('Guest count from suffix pattern:', guestCount);
    } else {
      // Strategy 3: Look for pattern "Zeit HH:MM Gäste N" in table format
      const tableMatch = cleanBody.match(/Zeit\s*\d{1,2}:\d{2}\s*G[äa]ste\s*(\d+)/i);
      if (tableMatch) {
        guestCount = parseInt(tableMatch[1], 10);
        console.log('Guest count from table pattern:', guestCount);
      } else {
        // Strategy 4: Look for isolated number after time that looks like guest count
        // Pattern: "19:00 ... Gäste 10" or similar table structure
        const timeGuestMatch = cleanBody.match(/\d{1,2}:\d{2}[^0-9]*?(\d{1,3})\s*(?:Kommentar|$)/i);
        if (timeGuestMatch && parseInt(timeGuestMatch[1], 10) <= 200) {
          guestCount = parseInt(timeGuestMatch[1], 10);
          console.log('Guest count from time-guest pattern:', guestCount);
        } else {
          // Strategy 5: Look for "Plätze" context with numbers
          const plaetzeMatch = cleanBody.match(/(\d+)\/\d+\s*Pl[äa]tze/i);
          if (plaetzeMatch) {
            // This is booked/total, so use the first number
            guestCount = parseInt(plaetzeMatch[1], 10) || 1;
            console.log('Guest count from Plätze context:', guestCount);
          }
        }
      }
    }
  }
  
  // Sanity check: guest count should be between 1 and 500
  if (guestCount < 1 || guestCount > 500) {
    console.log('Guest count out of range, defaulting to 1');
    guestCount = 1;
  }
  
  console.log('Final guest count:', guestCount);

  // Extract comment
  const commentMatch = cleanBody.match(/Kommentar[:\s]+(.+?)(?=Letztes Feedback|Status Kontingente|$)/is);
  const comment = commentMatch ? commentMatch[1].trim() : null;
  console.log('Comment:', comment);

  // Extract location - improved to get just the restaurant name
  const locationMatch = cleanBody.match(/Ort[:\s]+([^\n]+?)(?=\s*Datum|\s*\d{1,2}\.\d{1,2}\.)/i) ||
                        cleanBody.match(/Ort[:\s]+([^\n]+)/i);
  const location = locationMatch ? locationMatch[1].trim() : null;
  console.log('Location:', location);

  if (!date || !time || !guestName) {
    console.log('Missing required fields - date:', date, 'time:', time, 'name:', guestName);
    return null;
  }

  return {
    reservation_number: reservationNumber,
    guest_name: guestName,
    guest_email: guestEmail,
    guest_phone: guestPhone,
    date,
    time,
    guest_count: guestCount,
    comment,
    location
  };
}

// Parse Mailgun webhook payload
function extractEmailContent(payload: any): { subject: string; body: string; from: string } | null {
  console.log('Payload keys:', Object.keys(payload));
  
  // Mailgun sends different formats
  let body = '';
  let subject = '';
  let from = '';

  // Standard Mailgun fields
  if (payload['body-html']) {
    body = payload['body-html'];
  } else if (payload['body-plain']) {
    body = payload['body-plain'];
  } else if (payload['stripped-html']) {
    body = payload['stripped-html'];
  } else if (payload['stripped-text']) {
    body = payload['stripped-text'];
  } else if (payload.body) {
    body = payload.body;
  } else if (payload.html) {
    body = payload.html;
  } else if (payload.text) {
    body = payload.text;
  }

  subject = payload.subject || payload.Subject || '';
  from = payload.from || payload.From || payload.sender || '';

  if (!body) {
    console.log('No body found in payload');
    return null;
  }

  return { subject, body, from };
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('Received webhook request');
    console.log('Content-Type:', req.headers.get('content-type'));

    let payload: any;
    const contentType = req.headers.get('content-type') || '';

    // Mailgun can send as form-data or JSON
    if (contentType.includes('multipart/form-data') || contentType.includes('application/x-www-form-urlencoded')) {
      const formData = await req.formData();
      payload = Object.fromEntries(formData);
    } else {
      payload = await req.json();
    }

    console.log('Parsed payload keys:', Object.keys(payload));

    // Extract email content from Mailgun payload
    const emailContent = extractEmailContent(payload);
    if (!emailContent) {
      console.log('Could not extract email content');
      return new Response(
        JSON.stringify({ error: 'Could not extract email content' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('Email subject:', emailContent.subject);
    console.log('Email from:', emailContent.from);

    // Parse the reservation details
    const parsed = parseForatableEmail(emailContent.body);
    if (!parsed) {
      console.log('Could not parse reservation from email');
      return new Response(
        JSON.stringify({ error: 'Could not parse reservation details from email' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('Parsed reservation:', parsed);

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Check if reservation already exists (by reservation number or date+time+name combo)
    if (parsed.reservation_number) {
      const { data: existing } = await supabase
        .from('email_imported_reservations')
        .select('id')
        .eq('reservation_number', parsed.reservation_number)
        .single();

      if (existing) {
        console.log('Reservation already exists:', parsed.reservation_number);
        return new Response(
          JSON.stringify({ message: 'Reservation already imported', id: existing.id }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Determine if needs review (10+ guests)
    const needsReview = parsed.guest_count >= 10;
    console.log('Needs review (10+ guests):', needsReview);

    // Insert into database
    const { data, error } = await supabase
      .from('email_imported_reservations')
      .insert({
        reservation_number: parsed.reservation_number,
        guest_name: parsed.guest_name,
        guest_email: parsed.guest_email,
        guest_phone: parsed.guest_phone,
        date: parsed.date,
        time: parsed.time,
        guest_count: parsed.guest_count,
        comment: parsed.comment,
        location: parsed.location,
        source: 'foratable',
        raw_email_content: emailContent.body.substring(0, 10000), // Limit stored content
        needs_review: needsReview,
        is_processed: false
      })
      .select()
      .single();

    if (error) {
      console.error('Database insert error:', error);
      throw error;
    }

    console.log('Reservation saved:', data.id);

    return new Response(
      JSON.stringify({ 
        success: true, 
        id: data.id,
        needs_review: needsReview,
        guest_count: parsed.guest_count,
        parsed 
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error processing webhook:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
