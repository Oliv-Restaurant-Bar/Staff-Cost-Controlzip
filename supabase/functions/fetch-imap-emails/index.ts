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

// Parse email body to extract reservation details
function parseReservationEmail(body: string): ParsedReservation | null {
  console.log('Parsing email body...');
  
  // Clean up HTML entities and normalize whitespace
  const cleanBody = body
    .replace(/&#x26;/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Extract reservation number
  const reservationMatch = cleanBody.match(/Reservationsnummer[:\s]*(\d+)/i);
  const reservationNumber = reservationMatch ? reservationMatch[1] : null;

  // Extract name
  const nameMatch = cleanBody.match(/Name[:\s]+([A-ZÄÖÜa-zäöüß\s]+?)(?=\s*E-Mail|\s*Telefon|\s*$)/i);
  let guestName = nameMatch ? nameMatch[1].trim() : null;
  
  if (!guestName) {
    const subjectMatch = cleanBody.match(/([A-ZÄÖÜa-zäöüß]+\s+[A-ZÄÖÜa-zäöüß]+)\s*-\s*\d{1,2}\.\s*[A-Za-zäöü]+\s+\d{4}/);
    guestName = subjectMatch ? subjectMatch[1].trim() : 'Unbekannt';
  }

  // Extract email
  const emailMatch = cleanBody.match(/E-Mail[:\s]+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
  const guestEmail = emailMatch ? emailMatch[1] : null;

  // Extract phone
  const phoneMatch = cleanBody.match(/Telefon[:\s]+([\+\d\s\-()]+)/i);
  const guestPhone = phoneMatch ? phoneMatch[1].trim() : null;

  // Extract date
  const dateMatch = cleanBody.match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
  const date = dateMatch ? parseGermanDate(dateMatch[1]) : null;

  // Extract time
  const timeMatch = cleanBody.match(/(\d{1,2}:\d{2})/);
  const time = timeMatch ? parseTime(timeMatch[1]) : null;

  // Extract guest count
  const guestMatch = cleanBody.match(/Gäste[:\s]*(\d+)/i) || 
                     cleanBody.match(/(\d+)\s*(?:Gäste|Personen|Pax)/i) ||
                     cleanBody.match(/\d{1,2}:\d{2}\s+(\d+)/);
  const guestCount = guestMatch ? parseInt(guestMatch[1], 10) : 1;

  // Extract comment
  const commentMatch = cleanBody.match(/Kommentar[:\s]+(.+?)(?=Letztes Feedback|Status Kontingente|$)/is);
  const comment = commentMatch ? commentMatch[1].trim() : null;

  // Extract location
  const locationMatch = cleanBody.match(/Ort[:\s]+([^\n]+)/i);
  const location = locationMatch ? locationMatch[1].trim() : null;

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

// Simple IMAP client using raw TCP/TLS sockets
class SimpleImapClient {
  private conn: Deno.TlsConn | Deno.Conn | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private buffer = '';
  private tagCounter = 0;
  private host: string;
  private port: number;
  private useTls: boolean;
  private username: string;
  private password: string;

  constructor(host: string, port: number, useTls: boolean, username: string, password: string) {
    this.host = host;
    this.port = port;
    this.useTls = useTls;
    this.username = username;
    this.password = password;
  }

  private getTag(): string {
    return `A${++this.tagCounter}`;
  }

  private async readLine(): Promise<string> {
    const decoder = new TextDecoder();
    
    while (!this.buffer.includes('\r\n')) {
      const reader = this.conn!.readable.getReader();
      const { value, done } = await reader.read();
      reader.releaseLock();
      
      if (done) break;
      this.buffer += decoder.decode(value);
    }

    const lineEnd = this.buffer.indexOf('\r\n');
    if (lineEnd === -1) return '';
    
    const line = this.buffer.substring(0, lineEnd);
    this.buffer = this.buffer.substring(lineEnd + 2);
    return line;
  }

  private async readUntilTag(tag: string): Promise<string[]> {
    const lines: string[] = [];
    
    while (true) {
      const line = await this.readLine();
      lines.push(line);
      
      if (line.startsWith(tag + ' ')) {
        break;
      }
    }
    
    return lines;
  }

  private async sendCommand(command: string): Promise<string[]> {
    const tag = this.getTag();
    const encoder = new TextEncoder();
    const writer = this.conn!.writable.getWriter();
    await writer.write(encoder.encode(`${tag} ${command}\r\n`));
    writer.releaseLock();
    
    return await this.readUntilTag(tag);
  }

  async connect(): Promise<void> {
    console.log(`Connecting to ${this.host}:${this.port} (TLS: ${this.useTls})`);
    
    if (this.useTls) {
      this.conn = await Deno.connectTls({
        hostname: this.host,
        port: this.port,
      });
    } else {
      this.conn = await Deno.connect({
        hostname: this.host,
        port: this.port,
      });
    }
    
    // Read greeting
    const greeting = await this.readLine();
    console.log('Server greeting:', greeting);
    
    // Login
    const loginResult = await this.sendCommand(`LOGIN "${this.username}" "${this.password}"`);
    const lastLine = loginResult[loginResult.length - 1];
    if (!lastLine.includes('OK')) {
      throw new Error('Login failed: ' + lastLine);
    }
    console.log('Login successful');
  }

  async selectMailbox(mailbox: string): Promise<{ exists: number }> {
    const result = await this.sendCommand(`SELECT "${mailbox}"`);
    
    let exists = 0;
    for (const line of result) {
      const match = line.match(/\* (\d+) EXISTS/);
      if (match) {
        exists = parseInt(match[1], 10);
      }
    }
    
    console.log(`Selected mailbox ${mailbox}, ${exists} messages`);
    return { exists };
  }

  async searchUnseen(): Promise<number[]> {
    const result = await this.sendCommand('SEARCH UNSEEN');
    
    for (const line of result) {
      if (line.startsWith('* SEARCH')) {
        const numbers = line.replace('* SEARCH', '').trim();
        if (!numbers) return [];
        return numbers.split(' ').map(n => parseInt(n, 10));
      }
    }
    
    return [];
  }

  async fetchMessage(seqNum: number): Promise<string> {
    const tag = this.getTag();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const writer = this.conn!.writable.getWriter();
    await writer.write(encoder.encode(`${tag} FETCH ${seqNum} BODY[]\r\n`));
    writer.releaseLock();
    
    let result = '';
    let readingBody = false;
    let bytesToRead = 0;
    
    while (true) {
      const line = await this.readLine();
      
      if (line.startsWith(tag + ' ')) {
        break;
      }
      
      // Check for literal start
      const literalMatch = line.match(/\{(\d+)\}/);
      if (literalMatch) {
        bytesToRead = parseInt(literalMatch[1], 10);
        readingBody = true;
        
        // Read the literal bytes
        let bodyData = this.buffer;
        while (bodyData.length < bytesToRead) {
          const reader = this.conn!.readable.getReader();
          const { value, done } = await reader.read();
          reader.releaseLock();
          if (done) break;
          bodyData += decoder.decode(value);
        }
        
        result = bodyData.substring(0, bytesToRead);
        this.buffer = bodyData.substring(bytesToRead);
      } else if (!line.startsWith('*')) {
        result += line + '\n';
      }
    }
    
    return result;
  }

  async storeFlag(seqNum: number, flag: string): Promise<void> {
    await this.sendCommand(`STORE ${seqNum} +FLAGS (${flag})`);
  }

  async logout(): Promise<void> {
    try {
      await this.sendCommand('LOGOUT');
    } catch {
      // Ignore logout errors
    }
    
    try {
      this.conn?.close();
    } catch {
      // Ignore close errors
    }
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('Starting IMAP email fetch...');

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get IMAP settings
    const { data: settings, error: settingsError } = await supabase
      .from('imap_email_settings')
      .select('*')
      .eq('is_enabled', true)
      .single();

    if (settingsError || !settings) {
      console.log('No enabled IMAP settings found');
      return new Response(
        JSON.stringify({ error: 'No enabled IMAP settings found', details: settingsError?.message }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Connecting to IMAP server: ${settings.host}:${settings.port}`);

    // Connect to IMAP server
    const client = new SimpleImapClient(
      settings.host,
      settings.port,
      settings.use_tls,
      settings.username,
      settings.password
    );

    await client.connect();
    console.log('Connected to IMAP server');

    // Select mailbox
    const mailbox = await client.selectMailbox(settings.mailbox || 'INBOX');
    console.log(`Selected mailbox, total messages: ${mailbox.exists}`);

    // Search for unseen messages
    const unseenMessages = await client.searchUnseen();
    console.log(`Found ${unseenMessages.length} unseen messages`);

    let importedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    const results: any[] = [];

    for (const seqNum of unseenMessages) {
      try {
        console.log(`Fetching message ${seqNum}`);
        
        // Fetch the full message
        const messageBody = await client.fetchMessage(seqNum);
        
        if (!messageBody) {
          console.log(`No body for message ${seqNum}`);
          continue;
        }

        // Parse the reservation
        const parsed = parseReservationEmail(messageBody);
        
        if (!parsed) {
          console.log(`Could not parse reservation from message ${seqNum}`);
          skippedCount++;
          // Still mark as seen
          await client.storeFlag(seqNum, '\\Seen');
          continue;
        }

        // Check if already exists
        if (parsed.reservation_number) {
          const { data: existing } = await supabase
            .from('email_imported_reservations')
            .select('id')
            .eq('reservation_number', parsed.reservation_number)
            .single();

          if (existing) {
            console.log(`Reservation ${parsed.reservation_number} already exists`);
            skippedCount++;
            await client.storeFlag(seqNum, '\\Seen');
            continue;
          }
        }

        // Insert into database
        const needsReview = parsed.guest_count >= 10;
        const { data: inserted, error: insertError } = await supabase
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
            source: 'imap',
            raw_email_content: messageBody.substring(0, 10000),
            needs_review: needsReview,
            is_processed: false
          })
          .select()
          .single();

        if (insertError) {
          console.error(`Error inserting reservation: ${insertError.message}`);
          errorCount++;
        } else {
          console.log(`Imported reservation: ${inserted.id}`);
          importedCount++;
          results.push({
            id: inserted.id,
            guest_name: parsed.guest_name,
            date: parsed.date,
            guest_count: parsed.guest_count
          });
        }

        // Mark message as seen
        await client.storeFlag(seqNum, '\\Seen');

      } catch (msgError) {
        console.error(`Error processing message ${seqNum}:`, msgError);
        errorCount++;
      }
    }

    // Update last_sync_at
    await supabase
      .from('imap_email_settings')
      .update({
        last_sync_at: new Date().toISOString()
      })
      .eq('id', settings.id);

    // Disconnect
    await client.logout();
    console.log('Disconnected from IMAP server');

    return new Response(
      JSON.stringify({
        success: true,
        imported: importedCount,
        skipped: skippedCount,
        errors: errorCount,
        results
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in IMAP fetch:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
