/**
 * Block «Wie die Kosten entstehen» (Etappe 4). Reine Darstellung aus Kernwerten.
 *  a) Zwei horizontale Balken untereinander: «Budget» und «Hochrechnung»
 *     (HR gestapelt FIX + FLEX), mit senkrechter Budget-Marker-Linie über dem
 *     HR-Balken. Legende FIX / FLEX / Budget.
 *  b) PKQ-Brücke (Wasserfall) aus buildPkqBruecke: Ziel → Umsatz-Effekt →
 *     Zwischen-PKQ → Personal-Effekt → PKQ-Hochrechnung.
 */
import { PK_COLORS } from './pk-colors';
import type { PkqBrueckeErgebnis } from '@/lib/personalkosten-darstellung';
import { cn } from '@/lib/utils';

export interface PkKostenentstehungProps {
  budgetCHF: number | null;
  hrFixCHF: number;
  hrFlexCHF: number;
  hrTotalCHF: number;
  bruecke: PkqBrueckeErgebnis;
  fmtCHF: (n: number) => string;
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

export function PkKostenentstehung(props: PkKostenentstehungProps) {
  const { budgetCHF, hrFixCHF, hrFlexCHF, hrTotalCHF, bruecke, fmtCHF } = props;
  const hasBudget = budgetCHF != null && budgetCHF > 0;

  // Gemeinsame Skala für beide Balken (grösster Wert = 100 %).
  const scaleMax = Math.max(hrTotalCHF, budgetCHF ?? 0, 1);
  const pctOf = (v: number) => `${(v / scaleMax) * 100}%`;

  // PKQ-Brücke: gemeinsame Y-Skala über alle Endwerte.
  const brueckeMax = Math.max(40, ...bruecke.steps.map(s => s.endPp)) * 1.1;

  return (
    <section
      data-testid="pk-kostenentstehung"
      className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-5"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Wie die Kosten entstehen</h2>
        <div className="flex flex-wrap gap-3">
          <LegendDot color={PK_COLORS.fix} label="FIX = Monatslöhne (fest)" />
          <LegendDot color={PK_COLORS.flex} label="FLEX = Stundenlöhne" />
          <LegendDot color={PK_COLORS.budget} label="Budget" />
        </div>
      </div>

      {/* a) Horizontale Balken -------------------------------------------- */}
      <div className="space-y-3" data-testid="pk-balken">
        {/* Budget-Balken */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-muted-foreground">Budget</span>
            <span className="tabular-nums font-semibold">{hasBudget ? fmtCHF(budgetCHF) : '—'}</span>
          </div>
          <div className="relative h-6 w-full rounded bg-muted/40 overflow-hidden">
            {hasBudget && (
              <div
                className="absolute inset-y-0 left-0 rounded"
                style={{ width: pctOf(budgetCHF), backgroundColor: PK_COLORS.budget, opacity: 0.85 }}
              />
            )}
          </div>
        </div>

        {/* Hochrechnung-Balken (gestapelt FIX + FLEX) */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-muted-foreground">Hochrechnung</span>
            <span className="tabular-nums font-semibold">{fmtCHF(hrTotalCHF)}</span>
          </div>
          <div className="relative h-6 w-full rounded bg-muted/40 overflow-hidden">
            <div className="absolute inset-y-0 left-0 flex" style={{ width: pctOf(hrTotalCHF) }}>
              <div
                className="h-full flex items-center justify-center text-[10px] font-semibold text-white/90 overflow-hidden"
                style={{ width: hrTotalCHF > 0 ? `${(hrFixCHF / hrTotalCHF) * 100}%` : '0%', backgroundColor: PK_COLORS.fix }}
                title={`FIX ${fmtCHF(hrFixCHF)}`}
              >
                {hrFixCHF / scaleMax > 0.12 && 'FIX'}
              </div>
              <div
                className="h-full flex items-center justify-center text-[10px] font-semibold text-white/90 overflow-hidden"
                style={{ width: hrTotalCHF > 0 ? `${(hrFlexCHF / hrTotalCHF) * 100}%` : '0%', backgroundColor: PK_COLORS.flex }}
                title={`FLEX ${fmtCHF(hrFlexCHF)}`}
              >
                {hrFlexCHF / scaleMax > 0.12 && 'FLEX'}
              </div>
            </div>
            {/* Senkrechte Budget-Marker-Linie über dem HR-Balken */}
            {hasBudget && (
              <div
                data-testid="pk-budget-marker"
                className="absolute inset-y-0 w-0.5"
                style={{ left: pctOf(budgetCHF), backgroundColor: PK_COLORS.budget }}
                title={`Budget-Marke ${fmtCHF(budgetCHF)}`}
              />
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            FIX {fmtCHF(hrFixCHF)} · FLEX {fmtCHF(hrFlexCHF)}
            {hasBudget && ` · Budget-Marke bei ${fmtCHF(budgetCHF)}`}
          </p>
        </div>
      </div>

      {/* b) PKQ-Brücke (Wasserfall) --------------------------------------- */}
      <div className="space-y-2 border-t border-border/60 pt-4" data-testid="pk-pkq-bruecke">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          PKQ-Brücke: von der Ziel-Quote zur Hochrechnung
        </h3>
        {bruecke.incomplete ? (
          <p className="text-sm text-muted-foreground">
            Ohne Umsatz-Budget / Umsatz-Hochrechnung ist keine Brücke berechenbar —
            nur die Ziel-Personalquote {bruecke.steps[0]?.valuePp.toFixed(1)} % ist bekannt.
          </p>
        ) : (
          <>
            <div className="flex items-end gap-1 sm:gap-2 h-40 overflow-x-auto pb-1">
              {bruecke.steps.map(step => {
                const bottom = (step.startPp / brueckeMax) * 100;
                const height = (Math.abs(step.endPp - step.startPp) / brueckeMax) * 100;
                const levelHeight = (step.endPp / brueckeMax) * 100;
                const color = step.kind === 'level'
                  ? (step.key === 'ziel' ? PK_COLORS.budget
                    : step.key === 'zwischen' ? PK_COLORS.plan
                    : step.endPp > 40 ? PK_COLORS.critical : PK_COLORS.ist)
                  : step.tone === 'warn' ? PK_COLORS.critical
                    : step.tone === 'good' ? PK_COLORS.good
                    : PK_COLORS.plan;
                return (
                  <div key={step.key} className="flex-1 min-w-[64px] flex flex-col items-center justify-end h-full">
                    <span className={cn(
                      'text-[11px] font-bold tabular-nums mb-1',
                      step.kind === 'effect' && step.tone === 'warn' && 'text-red-600 dark:text-red-400',
                      step.kind === 'effect' && step.tone === 'good' && 'text-green-600 dark:text-green-400',
                    )}>
                      {step.kind === 'effect'
                        ? `${step.valuePp >= 0 ? '+' : '−'}${Math.abs(step.valuePp).toFixed(1)}`
                        : `${step.valuePp.toFixed(1)} %`}
                    </span>
                    <div className="relative w-full flex-1">
                      <div
                        className="absolute left-1/2 -translate-x-1/2 w-3/4 rounded-sm"
                        style={
                          step.kind === 'level'
                            ? { bottom: 0, height: `${levelHeight}%`, backgroundColor: color, opacity: 0.9 }
                            : { bottom: `${bottom}%`, height: `${Math.max(height, 1.5)}%`, backgroundColor: color, opacity: 0.9 }
                        }
                      />
                    </div>
                    <span className="mt-1 text-[10px] text-center text-muted-foreground leading-tight">
                      {step.label}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Zwischen-PKQ (Budget ÷ Umsatz-Hochrechnung) = {bruecke.zwischenPkqPct.toFixed(1)} %,
              End-PKQ (Personal-HR ÷ Umsatz-HR) = {bruecke.hochrechnungPkqPct.toFixed(1)} %.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
