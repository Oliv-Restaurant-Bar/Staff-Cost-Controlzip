import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { Link2, Copy, Check, Clock, Eye, EyeOff, Users } from 'lucide-react';
import { toast } from 'sonner';
import { sha256Hex, encodeGuestToken } from '@/contexts/GuestSessionContext';

const DURATIONS = [
  { label: '1 Stunde', ms: 1 * 60 * 60 * 1000 },
  { label: '2 Stunden', ms: 2 * 60 * 60 * 1000 },
  { label: '4 Stunden', ms: 4 * 60 * 60 * 1000 },
  { label: '8 Stunden', ms: 8 * 60 * 60 * 1000 },
  { label: '1 Tag', ms: 24 * 60 * 60 * 1000 },
];

export function GuestLinkGenerator() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [durationMs, setDurationMs] = useState(DURATIONS[1].ms);
  const [generatedLink, setGeneratedLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [generating, setGenerating] = useState(false);

  const handleGenerate = async () => {
    if (!password.trim()) {
      toast.error('Bitte ein Passwort eingeben');
      return;
    }
    setGenerating(true);
    try {
      const exp = Date.now() + durationMs;
      const hash = await sha256Hex(password.trim());
      const token = encodeGuestToken({ exp, hash });
      const base = window.location.origin;
      const link = `${base}/gast?t=${token}`;
      setGeneratedLink(link);
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(generatedLink);
    setCopied(true);
    toast.success('Link in Zwischenablage kopiert');
    setTimeout(() => setCopied(false), 2500);
  };

  const reset = () => {
    setPassword('');
    setGeneratedLink('');
    setCopied(false);
  };

  return (
    <Dialog open={open} onOpenChange={v => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 border-violet-300 text-violet-700 hover:bg-violet-50">
          <Users className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Gastlink</span>
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-5 w-5 text-violet-600" />
            Gastlink für Sitzung generieren
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5 pt-1">
          {!generatedLink ? (
            <>
              <div className="space-y-2">
                <Label>Sitzungs-Passwort</Label>
                <div className="relative">
                  <Input
                    type={showPw ? 'text' : 'password'}
                    placeholder="Passwort für die Teilnehmenden"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="pr-10"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Dieses Passwort teilen Sie den Teilnehmenden mit.
                </p>
              </div>

              <div className="space-y-2">
                <Label>Gültigkeitsdauer</Label>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                  {DURATIONS.map(d => (
                    <button
                      key={d.ms}
                      onClick={() => setDurationMs(d.ms)}
                      className={`py-1.5 px-2 rounded border text-xs font-medium transition-colors ${
                        durationMs === d.ms
                          ? 'bg-violet-600 text-white border-violet-600'
                          : 'bg-card border-border text-muted-foreground hover:border-violet-400'
                      }`}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>

              <Button
                className="w-full"
                onClick={handleGenerate}
                disabled={generating || !password}
              >
                <Link2 className="h-4 w-4 mr-2" />
                {generating ? 'Generiere…' : 'Link generieren'}
              </Button>
            </>
          ) : (
            <Card className="border-violet-200 bg-violet-50/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2 text-violet-800">
                  <Check className="h-4 w-4" />
                  Link bereit
                </CardTitle>
                <CardDescription className="text-xs">
                  Gültig für{' '}
                  {DURATIONS.find(d => d.ms === durationMs)?.label ?? '?'} ·
                  Passwortgeschützt
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-2">
                  <Clock className="h-3.5 w-3.5 text-violet-600 flex-shrink-0" />
                  <code className="text-[10px] break-all text-violet-900 leading-relaxed">
                    {generatedLink}
                  </code>
                </div>
                <Button
                  className="w-full gap-2"
                  variant={copied ? 'outline' : 'default'}
                  onClick={handleCopy}
                >
                  {copied
                    ? <><Check className="h-4 w-4" />Kopiert!</>
                    : <><Copy className="h-4 w-4" />Link kopieren</>
                  }
                </Button>
                <button
                  onClick={reset}
                  className="w-full text-xs text-muted-foreground hover:text-foreground underline"
                >
                  Neuen Link generieren
                </button>
              </CardContent>
            </Card>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
