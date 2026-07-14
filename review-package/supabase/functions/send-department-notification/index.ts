import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { Resend } from "https://esm.sh/resend@2.0.0";

const resend = new Resend(Deno.env.get("RESEND_API_KEY"));

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface DepartmentNotificationRequest {
  eventId: string;
  eventData: {
    date: string;
    shift: string;
    group_name: string | null;
    guest_count: number;
    location: string | null;
    notes: string | null;
    revenue_per_person: number;
  };
}

interface DepartmentEmail {
  department: string;
  email: string | null;
  is_active: boolean;
}

const departmentLabels: Record<string, string> = {
  geschaeftsfuehrer: "Geschäftsführer",
  dekoration: "Dekoration",
  service: "Service",
  bar: "Bar",
  kueche: "Küche",
};

// Generate special email for CEO (Geschäftsführer) with acceptance action
const generateGfEmail = (
  eventData: DepartmentNotificationRequest["eventData"]
): string => {
  const shiftLabel = eventData.shift === "mittag" ? "Mittag" : "Abend";

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #f59e0b, #d97706); color: white; padding: 24px; border-radius: 12px 12px 0 0; text-align: center; }
    .header h1 { margin: 0; font-size: 24px; }
    .content { background: #f8fafc; padding: 24px; border-radius: 0 0 12px 12px; border: 1px solid #e2e8f0; border-top: none; }
    .event-card { background: white; padding: 20px; border-radius: 8px; border-left: 4px solid #f59e0b; margin-bottom: 16px; }
    .event-title { font-size: 18px; font-weight: 600; color: #1e293b; margin-bottom: 12px; }
    .detail-row { display: flex; margin-bottom: 8px; }
    .detail-label { font-weight: 500; color: #64748b; width: 140px; }
    .detail-value { color: #1e293b; }
    .action-box { background: #fef3c7; border: 2px solid #f59e0b; padding: 20px; border-radius: 8px; margin-top: 16px; text-align: center; }
    .action-title { font-weight: 700; color: #92400e; margin-bottom: 12px; font-size: 16px; }
    .status-badge { display: inline-block; background: #fef3c7; border: 1px solid #fcd34d; color: #92400e; padding: 4px 12px; border-radius: 20px; font-weight: 600; font-size: 12px; }
    .footer { text-align: center; margin-top: 24px; color: #94a3b8; font-size: 12px; }
    .revenue-box { background: #ecfdf5; border: 1px solid #10b981; padding: 12px; border-radius: 8px; margin-top: 12px; }
    .revenue-title { font-weight: 600; color: #059669; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🔔 Neues Event - Ihre Annahme erforderlich</h1>
  </div>
  <div class="content">
    <p>Guten Tag,</p>
    <p>Ein neues Event wurde erstellt und wartet auf Ihre <strong>Annahme</strong>.</p>
    
    <div class="event-card">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
        <div class="event-title">${eventData.group_name || "Gruppenreservation"}</div>
        <span class="status-badge">⏳ Wartet auf Annahme</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">📅 Datum:</span>
        <span class="detail-value">${formatDate(eventData.date)}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">${eventData.shift === "mittag" ? "☀️" : "🌙"} Schicht:</span>
        <span class="detail-value">${shiftLabel}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">👥 Gäste:</span>
        <span class="detail-value">${eventData.guest_count} Personen</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">📍 Ort:</span>
        <span class="detail-value">${eventData.location || "EG Restaurant"}</span>
      </div>
      ${
        eventData.notes
          ? `
      <div class="detail-row">
        <span class="detail-label">📝 Notizen:</span>
        <span class="detail-value">${eventData.notes}</span>
      </div>
      `
          : ""
      }
      
      <div class="revenue-box">
        <div class="revenue-title">💰 Erwarteter Umsatz</div>
        <div style="font-size: 18px; font-weight: 600; color: #059669; margin-top: 4px;">
          CHF ${(eventData.guest_count * eventData.revenue_per_person).toLocaleString('de-CH')}
        </div>
        <div style="font-size: 12px; color: #6b7280;">
          (${eventData.guest_count} Gäste × CHF ${eventData.revenue_per_person}/Person)
        </div>
      </div>
    </div>
    
    <div class="action-box">
      <div class="action-title">✅ Aktion erforderlich</div>
      <p style="margin: 0; color: #92400e;">
        Bitte öffnen Sie das System und bestätigen Sie die <strong>Annahme</strong> dieses Events.<br>
        Nach Ihrer Annahme werden die Abteilungen automatisch benachrichtigt.
      </p>
    </div>
  </div>
  <div class="footer">
    <p>Diese Nachricht wurde automatisch generiert.</p>
    <p>Malena's Restaurant - Event Management</p>
  </div>
</body>
</html>
`;
};

const formatDate = (dateStr: string): string => {
  const date = new Date(dateStr);
  const options: Intl.DateTimeFormatOptions = {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  };
  return date.toLocaleDateString("de-CH", options);
};

const generateDepartmentEmail = (
  department: string,
  eventData: DepartmentNotificationRequest["eventData"]
): string => {
  const shiftLabel = eventData.shift === "mittag" ? "Mittag" : "Abend";
  const departmentLabel = departmentLabels[department] || department;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; padding: 24px; border-radius: 12px 12px 0 0; text-align: center; }
    .header h1 { margin: 0; font-size: 24px; }
    .content { background: #f8fafc; padding: 24px; border-radius: 0 0 12px 12px; border: 1px solid #e2e8f0; border-top: none; }
    .event-card { background: white; padding: 20px; border-radius: 8px; border-left: 4px solid #6366f1; margin-bottom: 16px; }
    .event-title { font-size: 18px; font-weight: 600; color: #1e293b; margin-bottom: 12px; }
    .detail-row { display: flex; margin-bottom: 8px; }
    .detail-label { font-weight: 500; color: #64748b; width: 120px; }
    .detail-value { color: #1e293b; }
    .action-box { background: #fef3c7; border: 1px solid #fcd34d; padding: 16px; border-radius: 8px; margin-top: 16px; }
    .action-title { font-weight: 600; color: #92400e; margin-bottom: 8px; }
    .footer { text-align: center; margin-top: 24px; color: #94a3b8; font-size: 12px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🎉 Neues Event - ${departmentLabel}</h1>
  </div>
  <div class="content">
    <p>Hallo ${departmentLabel}-Team,</p>
    <p>Ein neues Event wurde erstellt. Bitte prüfen Sie die Details und bestätigen Sie Ihre Bereitschaft im System.</p>
    
    <div class="event-card">
      <div class="event-title">${eventData.group_name || "Gruppenreservation"}</div>
      <div class="detail-row">
        <span class="detail-label">📅 Datum:</span>
        <span class="detail-value">${formatDate(eventData.date)}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">${eventData.shift === "mittag" ? "☀️" : "🌙"} Schicht:</span>
        <span class="detail-value">${shiftLabel}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">👥 Gäste:</span>
        <span class="detail-value">${eventData.guest_count} Personen</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">📍 Ort:</span>
        <span class="detail-value">${eventData.location || "EG Restaurant"}</span>
      </div>
      ${
        eventData.notes
          ? `
      <div class="detail-row">
        <span class="detail-label">📝 Notizen:</span>
        <span class="detail-value">${eventData.notes}</span>
      </div>
      `
          : ""
      }
    </div>
    
    <div class="action-box">
      <div class="action-title">⚡ Aktion erforderlich</div>
      <p style="margin: 0; color: #92400e;">
        Bitte bestätigen Sie im System, dass ${departmentLabel} für dieses Event bereit ist.
      </p>
    </div>
  </div>
  <div class="footer">
    <p>Diese Nachricht wurde automatisch generiert.</p>
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
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { eventId, eventData }: DepartmentNotificationRequest = await req.json();

    if (!eventId || !eventData) {
      return new Response(
        JSON.stringify({ error: "eventId and eventData are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch department email settings
    const { data: departmentEmails, error: fetchError } = await supabase
      .from("department_notification_emails")
      .select("*")
      .eq("is_active", true);

    if (fetchError) {
      console.error("Error fetching department emails:", fetchError);
      throw fetchError;
    }

    const emailsToSend = (departmentEmails as DepartmentEmail[]).filter(
      (d) => d.email && d.is_active
    );

    if (emailsToSend.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: "Keine aktiven Abteilungs-E-Mails konfiguriert",
          emailsSent: 0,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const shiftLabel = eventData.shift === "mittag" ? "Mittag" : "Abend";
    const results: { department: string; success: boolean; error?: string }[] = [];

    for (const dept of emailsToSend) {
      try {
        const isGf = dept.department === "geschaeftsfuehrer";
        const emailContent = isGf 
          ? generateGfEmail(eventData)
          : generateDepartmentEmail(dept.department, eventData);
        const departmentLabel = departmentLabels[dept.department] || dept.department;

        const subject = isGf
          ? `🔔 Neues Event wartet auf Annahme: ${eventData.group_name || "Gruppenreservation"} am ${formatDate(eventData.date)} (${shiftLabel})`
          : `🎉 Neues Event für ${departmentLabel}: ${eventData.group_name || "Gruppenreservation"} am ${formatDate(eventData.date)} (${shiftLabel})`;

        await resend.emails.send({
          from: "Malena's Events <onboarding@resend.dev>",
          to: [dept.email!],
          subject,
          html: emailContent,
        });

        results.push({ department: dept.department, success: true });
        console.log(`Email sent to ${dept.department}: ${dept.email}`);
      } catch (emailError: any) {
        console.error(`Error sending email to ${dept.department}:`, emailError);
        results.push({
          department: dept.department,
          success: false,
          error: emailError.message,
        });
      }
    }

    const successCount = results.filter((r) => r.success).length;

    return new Response(
      JSON.stringify({
        success: true,
        emailsSent: successCount,
        totalDepartments: emailsToSend.length,
        results,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    console.error("Error in send-department-notification:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
};

serve(handler);
