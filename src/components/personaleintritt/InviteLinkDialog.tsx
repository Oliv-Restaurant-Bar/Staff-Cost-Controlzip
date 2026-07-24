/**
 * InviteLinkDialog — zeigt den persönlichen Einladungslink GENAU EINMAL an
 * (in der DB liegt nur der Hash) mit Kopieren + WhatsApp/SMS-Teilen.
 */
import { useState } from 'react';
import { Check, Copy, MessageCircle, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { HintBox } from '@/components/ui/hint-box';
import { INVITE_GUELTIGKEIT_TAGE } from '@/lib/personaleintritt/token';

function einladungsText(link: string): string {
  return (
    'Guten Tag\n\n' +
    'Für Ihren Stellenantritt benötigen wir noch einige Angaben. ' +
    'Bitte füllen Sie das Formular über Ihren persönlichen Link aus:\n\n' +
    `${link}\n\n` +
    `Der Link ist ${INVITE_GUELTIGKEIT_TAGE} Tage gültig. Vielen Dank!`
  );
}

export function InviteLinkDialog({
  open,
  onClose,
  link,
}: {
  open: boolean;
  /** Schliessen (der Link ist danach nicht mehr abrufbar — nur der Hash liegt in der DB). */
  onClose: () => void;
  link: string | null;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      toast.success('Link kopiert');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Kopieren nicht möglich — Link bitte manuell markieren.');
    }
  };

  const text = link ? einladungsText(link) : '';

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Einladung erstellt</DialogTitle>
          <DialogDescription>
            Persönlicher Link für den neuen Mitarbeiter — per WhatsApp oder SMS teilen
            oder kopieren.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border bg-muted px-2 py-1.5 text-xs" data-testid="text-invite-link">
              {link ?? '—'}
            </code>
            <Button size="sm" variant="outline" onClick={copy} data-testid="button-copy-invite-link">
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              <span className="ml-1.5">Kopieren</span>
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button asChild variant="outline" size="sm" disabled={!link}>
              <a
                href={`https://wa.me/?text=${encodeURIComponent(text)}`}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="link-share-whatsapp"
              >
                <MessageCircle className="mr-1.5 h-4 w-4" /> WhatsApp
              </a>
            </Button>
            <Button asChild variant="outline" size="sm" disabled={!link}>
              <a href={`sms:?&body=${encodeURIComponent(text)}`} data-testid="link-share-sms">
                <MessageSquare className="mr-1.5 h-4 w-4" /> SMS
              </a>
            </Button>
          </div>

          <HintBox tone="warn" title="Wichtig">
            Der Link wird nur jetzt angezeigt. Bei Verlust später einfach einen neuen
            Link erzeugen (der alte wird dabei ungültig).
          </HintBox>
        </div>

        <DialogFooter>
          <Button onClick={onClose} data-testid="button-close-invite-dialog">Fertig</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
