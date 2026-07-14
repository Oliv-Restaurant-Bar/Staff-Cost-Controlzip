/**
 * Kernaussagen 5+5 (Spez. Phase 2 §9) — regelbasierte positive Punkte und
 * Verbesserungspotenziale, je max. 5. Keine KI-/Freitexte.
 */
import { InfoTip } from '@/components/ui/info-tip';
import { TONE_TEXT } from '@/components/ui/tones';
import type { BankKernaussagenPlus } from '@/lib/bank-investor-analysis';
import { SectionCard } from './bank-phase2-ui';

function AussagenListe({ items, marker, markerClass, empty }: {
  items: string[]; marker: string; markerClass: string; empty: string;
}) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-1.5 text-sm">
      {items.map((s, i) => (
        <li key={i} className="flex gap-2">
          <span className={`shrink-0 ${markerClass}`} aria-hidden>{marker}</span>
          <span>{s}</span>
        </li>
      ))}
    </ul>
  );
}

export function BankKernaussagenSection({ kernaussagen }: { kernaussagen: BankKernaussagenPlus }) {
  return (
    <SectionCard
      title="Kernaussagen"
      testId="bank-kernaussagen"
      info={<InfoTip text="Regelbasiert aus den Vergleichszahlen abgeleitet (je max. 5 Punkte) — keine Freitexte, keine Schätzungen." />}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div data-testid="bank-kernaussagen-positive">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Positive Entwicklungen</h4>
          <AussagenListe items={kernaussagen.positive} marker="✓" markerClass={TONE_TEXT.good} empty="Keine positiven Auffälligkeiten im Vergleichszeitraum." />
        </div>
        <div data-testid="bank-kernaussagen-potenziale">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Verbesserungspotenziale</h4>
          <AussagenListe items={kernaussagen.potenziale} marker="!" markerClass={TONE_TEXT.warn} empty="Keine Auffälligkeiten — alle beobachteten Kennzahlen sind stabil oder besser." />
        </div>
      </div>
    </SectionCard>
  );
}
