import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Lock, Eye, EyeOff, Clock, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  sha256Hex, decodeGuestToken, GUEST_SESSION_KEY,
} from '@/contexts/GuestSessionContext';

export default function GuestAccess() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<'prompt' | 'expired' | 'invalid'>('prompt');
  const [expiresLabel, setExpiresLabel] = useState('');

  const rawToken = params.get('t') ?? '';

  useEffect(() => {
    if (!rawToken) { setStatus('invalid'); return; }
    const token = decodeGuestToken(rawToken);
    if (!token) { setStatus('invalid'); return; }
    if (token.exp <= Date.now()) { setStatus('expired'); return; }

    const ms = token.exp - Date.now();
    const h = Math.floor(ms / 3600000);
    const m = Math.round((ms % 3600000) / 60000);
    setExpiresLabel(h > 0 ? `${h}h ${m}min` : `${m} Minuten`);
  }, [rawToken]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const token = decodeGuestToken(rawToken)!;
      const hash = await sha256Hex(password);
      if (hash !== token.hash) {
        toast.error('Falsches Passwort');
        setPassword('');
        return;
      }
      sessionStorage.setItem(GUEST_SESSION_KEY, JSON.stringify({
        expiresAt: token.exp,
        token: rawToken,
      }));
      toast.success('Willkommen! Sie sind als Gast eingeloggt.');
      navigate('/', { replace: true });
    } finally {
      setLoading(false);
    }
  };

  if (status === 'invalid') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-sm text-center">
          <CardHeader>
            <AlertTriangle className="h-10 w-10 text-amber-500 mx-auto mb-2" />
            <CardTitle>Ungültiger Link</CardTitle>
            <CardDescription>Dieser Gastlink ist ungültig oder beschädigt.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (status === 'expired') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-sm text-center">
          <CardHeader>
            <Clock className="h-10 w-10 text-red-500 mx-auto mb-2" />
            <CardTitle>Link abgelaufen</CardTitle>
            <CardDescription>
              Dieser Gastlink ist nicht mehr gültig. Bitte kontaktieren Sie den Administrator für einen neuen Link.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-3 h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
            <Lock className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-lg">Gast-Zugang</CardTitle>
          <CardDescription>
            Personalkostentracker · oLiv Gastro AG
          </CardDescription>
          {expiresLabel && (
            <div className="mt-2 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              Gültig noch ca. <strong>{expiresLabel}</strong>
            </div>
          )}
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="relative">
              <Input
                type={showPw ? 'text' : 'password'}
                placeholder="Sitzungs-Passwort eingeben"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="pr-10"
                autoFocus
                required
              />
              <button
                type="button"
                onClick={() => setShowPw(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <Button type="submit" className="w-full" disabled={loading || !password}>
              {loading
                ? 'Prüfe…'
                : <><CheckCircle2 className="h-4 w-4 mr-2" />Zugang öffnen</>
              }
            </Button>
          </form>
          <p className="text-xs text-muted-foreground text-center mt-4">
            Das Passwort erhalten Sie vom Sitzungsleiter.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
