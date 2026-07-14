import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface BackupEmailRequest {
  backupData: string;
  backupName: string;
  timestamp: string;
}

const handler = async (req: Request): Promise<Response> => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (!RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is not configured");
    }

    const { backupData, backupName, timestamp }: BackupEmailRequest = await req.json();

    // Format date for email
    const date = new Date(timestamp);
    const formattedDate = date.toLocaleDateString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    // Calculate backup size
    const sizeKB = (backupData.length / 1024).toFixed(2);

    // Convert string to base64 for attachment
    const encoder = new TextEncoder();
    const data = encoder.encode(backupData);
    const base64Content = btoa(String.fromCharCode(...data));

    const emailResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Malena's Backup <onboarding@resend.dev>",
        to: ["dine@malenas.ch"],
        subject: `Backup: ${backupName} - ${formattedDate}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #3b82f6;">📦 Backup-Sicherung</h1>
            <p>Ein neues Backup wurde erstellt und ist dieser E-Mail angehängt.</p>
            
            <div style="background: #f3f4f6; padding: 16px; border-radius: 8px; margin: 20px 0;">
              <p style="margin: 0;"><strong>Dateiname:</strong> ${backupName}</p>
              <p style="margin: 8px 0 0;"><strong>Erstellt am:</strong> ${formattedDate}</p>
              <p style="margin: 8px 0 0;"><strong>Größe:</strong> ${sizeKB} KB</p>
            </div>
            
            <p style="color: #6b7280; font-size: 14px;">
              Diese E-Mail wurde automatisch vom Dienstplan-System generiert.
            </p>
          </div>
        `,
        attachments: [
          {
            filename: backupName,
            content: base64Content,
          },
        ],
      }),
    });

    const result = await emailResponse.json();

    if (!emailResponse.ok) {
      throw new Error(result.message || "Failed to send email");
    }

    console.log("Backup email sent successfully:", result);

    return new Response(JSON.stringify({ success: true, ...result }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders,
      },
    });
  } catch (error: any) {
    console.error("Error in send-backup-email function:", error);
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
