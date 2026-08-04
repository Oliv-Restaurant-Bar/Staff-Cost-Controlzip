/**
 * Personaleintritt — Status→Ton-Zuordnung (Designsystem-Töne, §3).
 * Grün = abgeschlossen/gut, orange = Handlung nötig, blau = läuft,
 * grau = neutral, rot = abgebrochen.
 */
import type { Tone } from '@/components/ui/tones';
import type { PersonaleintrittStatus } from '@/lib/personaleintritt/types';

export const STATUS_TONES: Record<PersonaleintrittStatus, Tone> = {
  entwurf: 'neutral',
  eingeladen: 'info',
  ausgefuellt: 'warn',        // wartet auf Prüfung durchs Backoffice
  geprueft: 'info',
  vertrag_gesendet: 'info',
  unterzeichnet: 'good',
  uebernommen: 'good',
  abgebrochen: 'critical',
};
