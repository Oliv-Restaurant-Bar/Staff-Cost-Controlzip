import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface NotificationRequest {
  manual?: boolean;
  targetDate?: string; // For manual: specific date to notify about
  daysAhead?: number; // For automatic: how many days to look ahead
  customEmail?: boolean; // For custom manual emails
  subject?: string; // Custom email subject
  message?: string; // Custom email message
  recipients?: string[]; // Custom recipients list
}

interface GroupReservation {
  id: string;
  date: string;
  shift: string;
  group_name: string | null;
  guest_count: number;
  revenue_per_person: number;
  notes: string | null;
  location: string | null;
  exclude_walk_in: boolean;
}

interface NotificationSettings {
  email: string;
  notify_group_reservations: boolean;
  notify_regular_reservations: boolean;
}

const formatCurrency = (value: number): string => {
  return new Intl.NumberFormat('de-CH', {
    style: 'decimal',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value) + ' CHF';
};

const formatDate = (dateStr: string): string => {
  const date = new Date(dateStr);
  return date.toLocaleDateString('de-DE', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  });
};

const generateCustomEmailContent = (subject: string, message: string): string => {
  // Convert newlines to <br> for HTML
  const formattedMessage = message.replace(/\n/g, '<br>');
  
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #ffffff;">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #1e40af; margin: 0;">📧 ${subject}</h1>
      </div>
      
      <div style="background: #f9fafb; padding: 24px; border-radius: 12px; border: 1px solid #e5e7eb; margin-bottom: 24px;">
        <div style="font-size: 15px; line-height: 1.6; color: #374151;">
          ${formattedMessage}
        </div>
      </div>
      
      <div style="text-align: center; padding: 20px; background: #f3f4f6; border-radius: 8px; font-size: 12px; color: #6b7280;">
        <p style="margin: 0;">Diese E-Mail wurde vom Personalkostentracker gesendet.</p>
        <p style="margin: 8px 0 0;">Malena's Restaurant</p>
      </div>
    </body>
    </html>
  `;
};

const generateEmailContent = (
  reservations: GroupReservation[],
  startDate: string,
  endDate: string,
  walkInPercentage: number = 20,
  defaultRevenuePerPerson: number = 35
): string => {
  // Separate group reservations and calculate walk-in estimates
  const groupReservations = reservations.filter(r => r.group_name || r.guest_count > 10);
  const regularReservations = reservations.filter(r => !r.group_name && r.guest_count <= 10);
  
  // Calculate totals
  const totalGroupGuests = groupReservations.reduce((sum, r) => sum + r.guest_count, 0);
  const totalGroupRevenue = groupReservations.reduce((sum, r) => sum + (r.guest_count * r.revenue_per_person), 0);
  
  // Walk-in calculation (only for reservations without exclude_walk_in)
  const guestsForWalkIn = groupReservations
    .filter(r => !r.exclude_walk_in)
    .reduce((sum, r) => sum + r.guest_count, 0);
  const estimatedWalkIns = Math.round(guestsForWalkIn * (walkInPercentage / 100));
  const walkInRevenue = estimatedWalkIns * defaultRevenuePerPerson;
  
  const totalGuests = totalGroupGuests + estimatedWalkIns;
  const totalRevenue = totalGroupRevenue + walkInRevenue;
  
  // Group by date
  const byDate: Record<string, GroupReservation[]> = {};
  reservations.forEach(r => {
    if (!byDate[r.date]) byDate[r.date] = [];
    byDate[r.date].push(r);
  });
  
  const sortedDates = Object.keys(byDate).sort();
  
  let eventsHtml = '';
  sortedDates.forEach(date => {
    const dateReservations = byDate[date];
    const dayGuests = dateReservations.reduce((sum, r) => sum + r.guest_count, 0);
    const dayRevenue = dateReservations.reduce((sum, r) => sum + (r.guest_count * r.revenue_per_person), 0);
    
    eventsHtml += `
      <div style="margin-bottom: 20px; border-left: 4px solid #3b82f6; padding-left: 16px;">
        <h3 style="margin: 0 0 8px 0; color: #1e40af;">${formatDate(date)}</h3>
        <p style="margin: 0 0 12px 0; color: #6b7280; font-size: 14px;">
          ${dateReservations.length} Event(s) · ${dayGuests} Gäste · ${formatCurrency(dayRevenue)}
        </p>
    `;
    
    dateReservations.forEach(r => {
      const isGroup = r.group_name || r.guest_count > 10;
      const shiftLabel = r.shift === 'mittag' ? '🌞 Mittag' : '🌙 Abend';
      const shiftColor = r.shift === 'mittag' ? '#f59e0b' : '#6366f1';
      
      eventsHtml += `
        <div style="background: #f9fafb; padding: 12px; border-radius: 8px; margin-bottom: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span style="font-weight: bold; color: #111827;">${r.group_name || 'Reservation'}</span>
            <span style="background: ${shiftColor}20; color: ${shiftColor}; padding: 2px 8px; border-radius: 4px; font-size: 12px;">
              ${shiftLabel}
            </span>
          </div>
          <div style="font-size: 14px; color: #4b5563;">
            <span>👥 ${r.guest_count} Gäste</span>
            <span style="margin-left: 16px;">📍 ${r.location || 'EG Restaurant'}</span>
            <span style="margin-left: 16px;">💰 ${formatCurrency(r.guest_count * r.revenue_per_person)}</span>
          </div>
          ${r.exclude_walk_in ? '<div style="margin-top: 4px; font-size: 12px; color: #9ca3af;">⚠️ Kein Walk-In berechnet</div>' : ''}
          ${r.notes ? `<div style="margin-top: 8px; font-size: 13px; color: #6b7280; font-style: italic;">📝 ${r.notes}</div>` : ''}
        </div>
      `;
    });
    
    eventsHtml += '</div>';
  });
  
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #ffffff;">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #1e40af; margin: 0;">🎉 Event-Übersicht</h1>
        <p style="color: #6b7280; margin: 8px 0 0;">Kommende Reservationen</p>
      </div>
      
      <div style="background: linear-gradient(135deg, #3b82f6 0%, #1e40af 100%); color: white; padding: 20px; border-radius: 12px; margin-bottom: 24px;">
        <h2 style="margin: 0 0 16px 0; font-size: 18px;">Zusammenfassung</h2>
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px;">
          <div style="background: rgba(255,255,255,0.1); padding: 12px; border-radius: 8px;">
            <div style="font-size: 24px; font-weight: bold;">${reservations.length}</div>
            <div style="font-size: 12px; opacity: 0.9;">Events</div>
          </div>
          <div style="background: rgba(255,255,255,0.1); padding: 12px; border-radius: 8px;">
            <div style="font-size: 24px; font-weight: bold;">${totalGuests}</div>
            <div style="font-size: 12px; opacity: 0.9;">Erwartete Gäste</div>
          </div>
          <div style="background: rgba(255,255,255,0.1); padding: 12px; border-radius: 8px;">
            <div style="font-size: 24px; font-weight: bold;">${totalGroupGuests}</div>
            <div style="font-size: 12px; opacity: 0.9;">Gruppen-Gäste</div>
          </div>
          <div style="background: rgba(255,255,255,0.1); padding: 12px; border-radius: 8px;">
            <div style="font-size: 24px; font-weight: bold;">${formatCurrency(totalRevenue)}</div>
            <div style="font-size: 12px; opacity: 0.9;">Erw. Umsatz</div>
          </div>
        </div>
        ${estimatedWalkIns > 0 ? `
          <div style="margin-top: 12px; padding: 8px; background: rgba(255,255,255,0.1); border-radius: 6px; font-size: 13px;">
            📊 Geschätzte Walk-Ins: ~${estimatedWalkIns} Gäste (${walkInPercentage}% von ${guestsForWalkIn})
          </div>
        ` : ''}
      </div>
      
      <div style="margin-bottom: 24px;">
        <h2 style="color: #1e40af; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px;">
          📅 Events im Detail
        </h2>
        ${eventsHtml || '<p style="color: #6b7280;">Keine Events in diesem Zeitraum.</p>'}
      </div>
      
      <div style="text-align: center; padding: 20px; background: #f3f4f6; border-radius: 8px; font-size: 12px; color: #6b7280;">
        <p style="margin: 0;">Diese E-Mail wurde automatisch vom Personalkostentracker generiert.</p>
        <p style="margin: 8px 0 0;">Zeitraum: ${formatDate(startDate)} - ${formatDate(endDate)}</p>
      </div>
    </body>
    </html>
  `;
};

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is not configured");
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Supabase credentials not configured");
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    
    const { 
      manual = false, 
      targetDate, 
      daysAhead = 7,
      customEmail = false,
      subject: customSubject,
      message: customMessage,
      recipients: customRecipients
    }: NotificationRequest = await req.json();

    // Handle custom email sending
    if (customEmail && customSubject && customMessage && customRecipients) {
      const customEmailHtml = generateCustomEmailContent(customSubject, customMessage);
      
      const emailResponse = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Malena's Team <onboarding@resend.dev>",
          to: customRecipients,
          subject: customSubject,
          html: customEmailHtml,
        }),
      });

      const result = await emailResponse.json();

      if (!emailResponse.ok) {
        throw new Error(result.message || "Failed to send custom email");
      }

      // Log the notification
      await supabase.from('event_notifications_log').insert({
        reservation_id: '00000000-0000-0000-0000-000000000000', // Placeholder for custom emails
        notification_type: 'custom_manual',
        recipients: customRecipients,
        success: true,
      });

      console.log("Custom email sent successfully:", result);

      return new Response(
        JSON.stringify({ 
          success: true, 
          message: `${customRecipients.length} E-Mail(s) gesendet`,
          emailsSent: customRecipients.length,
          ...result 
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
    }

    // Get notification settings (active emails)
    const { data: settings, error: settingsError } = await supabase
      .from('event_notification_settings')
      .select('*')
      .eq('is_active', true);

    if (settingsError) throw settingsError;

    if (!settings || settings.length === 0) {
      return new Response(
        JSON.stringify({ success: false, message: 'Keine aktiven E-Mail-Empfänger konfiguriert' }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Calculate date range
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    let startDate: Date;
    let endDate: Date;

    if (manual && targetDate) {
      // For manual: send for specific date or week
      startDate = new Date(targetDate);
      endDate = new Date(targetDate);
      endDate.setDate(endDate.getDate() + 6); // Include full week
    } else {
      // For automatic: look ahead X days
      startDate = new Date(today);
      startDate.setDate(startDate.getDate() + 1); // Start tomorrow
      endDate = new Date(today);
      endDate.setDate(endDate.getDate() + daysAhead);
    }

    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];

    // Fetch reservations
    const { data: reservations, error: resError } = await supabase
      .from('group_reservations')
      .select('*')
      .gte('date', startStr)
      .lte('date', endStr)
      .order('date')
      .order('shift');

    if (resError) throw resError;

    if (!reservations || reservations.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: 'Keine Events im Zeitraum gefunden', emailsSent: 0 }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Get fortelable settings for walk-in percentage
    const { data: fortelableSettings } = await supabase
      .from('fortelable_settings')
      .select('walk_in_percentage, default_revenue_per_person')
      .limit(1)
      .maybeSingle();

    const walkInPercentage = fortelableSettings?.walk_in_percentage || 20;
    const defaultRevenue = fortelableSettings?.default_revenue_per_person || 35;

    // Generate email content
    const emailHtml = generateEmailContent(
      reservations,
      startStr,
      endStr,
      walkInPercentage,
      defaultRevenue
    );

    // Send emails to all active recipients
    const emailResults: Array<{ email: string; success: boolean; error?: string }> = [];
    const recipients = settings.map((s: NotificationSettings) => s.email);

    const emailResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Malena's Events <onboarding@resend.dev>",
        to: recipients,
        subject: `🎉 Event-Übersicht: ${reservations.length} Events vom ${startStr} bis ${endStr}`,
        html: emailHtml,
      }),
    });

    const result = await emailResponse.json();

    if (!emailResponse.ok) {
      throw new Error(result.message || "Failed to send emails");
    }

    // Log the notification
    await supabase.from('event_notifications_log').insert({
      reservation_id: reservations[0].id, // Reference first reservation
      notification_type: manual ? 'manual' : 'automatic',
      recipients: recipients,
      success: true,
    });

    console.log("Event notification emails sent successfully:", result);

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: `${recipients.length} E-Mail(s) gesendet`,
        emailsSent: recipients.length,
        eventsIncluded: reservations.length,
        ...result 
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  } catch (error: any) {
    console.error("Error in send-event-notifications function:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  }
};

serve(handler);
