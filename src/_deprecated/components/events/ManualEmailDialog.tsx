import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Mail, Send, Loader2, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface ManualEmailDialogProps {
  activeEmails: string[];
}

export const ManualEmailDialog = ({ activeEmails }: ManualEmailDialogProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [additionalRecipients, setAdditionalRecipients] = useState('');

  const handleSendManualEmail = async () => {
    if (!subject.trim()) {
      toast.error('Bitte Betreff eingeben');
      return;
    }
    if (!message.trim()) {
      toast.error('Bitte Nachricht eingeben');
      return;
    }

    // Parse additional recipients
    const extraEmails = additionalRecipients
      .split(/[,;\s]+/)
      .map(e => e.trim())
      .filter(e => e.includes('@'));

    const allRecipients = [...new Set([...activeEmails, ...extraEmails])];

    if (allRecipients.length === 0) {
      toast.error('Keine E-Mail-Empfänger vorhanden');
      return;
    }

    setIsSending(true);
    try {
      const response = await supabase.functions.invoke('send-event-notifications', {
        body: {
          manual: true,
          customEmail: true,
          subject: subject,
          message: message,
          recipients: allRecipients,
        },
      });

      if (response.error) throw response.error;

      const result = response.data;
      if (result.success) {
        toast.success(`E-Mail an ${result.emailsSent} Empfänger gesendet`);
        setIsOpen(false);
        setSubject('');
        setMessage('');
        setAdditionalRecipients('');
      } else {
        toast.error(result.message || 'Fehler beim Senden');
      }
    } catch (error: any) {
      console.error('Error sending manual email:', error);
      toast.error(error.message || 'Fehler beim Senden der E-Mail');
    } finally {
      setIsSending(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1">
          <Mail className="h-4 w-4" />
          Eigene E-Mail
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            Manuelle E-Mail-Benachrichtigung
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Recipients info */}
          <div className="p-3 bg-muted/50 rounded-lg">
            <div className="flex items-center gap-2 mb-2">
              <Users className="h-4 w-4 text-primary" />
              <span className="font-medium text-sm">Aktive Empfänger</span>
              <Badge variant="secondary">{activeEmails.length}</Badge>
            </div>
            {activeEmails.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {activeEmails.map(email => (
                  <Badge key={email} variant="outline" className="text-xs">
                    {email}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Keine aktiven Empfänger konfiguriert
              </p>
            )}
          </div>

          {/* Additional recipients */}
          <div className="space-y-2">
            <Label>Zusätzliche Empfänger (optional)</Label>
            <Input
              placeholder="email1@beispiel.ch, email2@beispiel.ch"
              value={additionalRecipients}
              onChange={(e) => setAdditionalRecipients(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Mehrere Adressen mit Komma oder Semikolon trennen
            </p>
          </div>

          {/* Subject */}
          <div className="space-y-2">
            <Label>Betreff *</Label>
            <Input
              placeholder="z.B. Wichtige Info für morgen"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>

          {/* Message */}
          <div className="space-y-2">
            <Label>Nachricht *</Label>
            <Textarea
              placeholder="Ihre Nachricht an das Team..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={6}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setIsOpen(false)}>
            Abbrechen
          </Button>
          <Button 
            onClick={handleSendManualEmail} 
            disabled={isSending || !subject.trim() || !message.trim()}
            className="gap-2"
          >
            {isSending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            E-Mail senden
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
