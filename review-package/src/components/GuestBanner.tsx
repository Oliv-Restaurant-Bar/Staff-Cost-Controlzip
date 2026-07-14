import { useGuestSession } from '@/contexts/GuestSessionContext';
import { Clock, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

export function GuestBanner() {
  const { isGuest, guestMinutesLeft, clearGuestSession } = useGuestSession();

  if (!isGuest) return null;

  const h = Math.floor(guestMinutesLeft / 60);
  const m = guestMinutesLeft % 60;
  const timeLabel = h > 0 ? `${h}h ${m}min` : `${m} Min.`;

  const handleLeave = () => {
    clearGuestSession();
    toast.success('Gast-Sitzung beendet');
    window.location.href = '/gast';
  };

  return (
    <div className="w-full bg-violet-600 text-white px-4 py-1.5 flex items-center justify-between gap-3 text-xs z-50">
      <div className="flex items-center gap-2">
        <Clock className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="font-medium">Gast-Zugang aktiv</span>
        <span className="opacity-80 hidden sm:inline">·  Lesezugriff  ·  Gültig noch ca. {timeLabel}</span>
        <span className="opacity-80 sm:hidden">{timeLabel}</span>
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-white hover:bg-white/20 hover:text-white"
        onClick={handleLeave}
      >
        <LogOut className="h-3 w-3 mr-1" />
        Beenden
      </Button>
    </div>
  );
}
