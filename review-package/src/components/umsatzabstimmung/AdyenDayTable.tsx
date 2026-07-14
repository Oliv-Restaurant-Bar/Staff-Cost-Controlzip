/**
 * AdyenDayTable.tsx — Tages-Tabelle des Adyen-Abgleichs.
 * ======================================================
 * Zeigt pro Tag Karten/TWINT laut Z-Bericht vs. Adyen mit Differenz-Farben,
 * aufklappbarem Zahlungsarten-Detail, Overrides, Kommentaren und
 * Tagesbestätigung. Sämtliche Logik lebt in src/lib/adyen-abstimmung.ts.
 */

import { Fragment, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import {
  canConfirmDay,
  type DayComparison,
  type DayConfirmation,
} from '@/lib/adyen-abstimmung';
import {
  AmountCell, CommentButton, DayStateBadges, DiffCell, diffColorClass, fmtChf,
} from './adyen-ui';

const WEEKDAYS_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

function fmtDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const wd = WEEKDAYS_DE[new Date(y, m - 1, d).getDay()];
  return `${wd} ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.`;
}

interface AdyenDayTableProps {
  days: DayComparison[];
  disabled: boolean;
  onOverride: (fieldKey: string, originalValue: number, corrected: number | null, comment: string) => void;
  onComment: (fieldKey: string, text: string) => void;
  onConfirm: (date: string, confirmation: DayConfirmation | null) => void;
}

export function AdyenDayTable({ days, disabled, onOverride, onComment, onConfirm }: AdyenDayTableProps) {
  const [openDays, setOpenDays] = useState<Record<string, boolean>>({});
  const [confirmComments, setConfirmComments] = useState<Record<string, string>>({});

  const toggle = (date: string) => setOpenDays(o => ({ ...o, [date]: !o[date] }));

  if (days.length === 0) {
    return (
      <p className="text-xs text-muted-foreground/60 italic py-4 text-center">
        Für diesen Monat liegen weder Z-Bericht-Tagesimporte noch Adyen-Daten vor.
      </p>
    );
  }

  return (
    <table className="w-full text-xs border-collapse min-w-[680px]">
      <thead>
        <tr className="border-b-2 border-border text-muted-foreground">
          <th className="text-left py-2 px-2 font-semibold w-[90px]">Tag</th>
          <th className="text-right py-2 px-2 font-semibold">
            Karten/TWINT<span className="block text-[10px] font-normal">laut Z-Bericht</span>
          </th>
          <th className="text-right py-2 px-2 font-semibold">
            Karten/TWINT<span className="block text-[10px] font-normal">laut Adyen</span>
          </th>
          <th className="text-right py-2 px-2 font-semibold">
            Differenz<span className="block text-[10px] font-normal">Z − Adyen</span>
          </th>
          <th className="text-left py-2 px-2 font-semibold">Status</th>
          <th className="w-[30px]" />
        </tr>
      </thead>
      <tbody>
        {days.map(cmp => {
          const open = !!openDays[cmp.date];
          const confirmed = !!cmp.confirmation?.confirmed;
          const cashCounted = !!cmp.confirmation?.cashCounted;
          const check = canConfirmDay(cmp, cashCounted);

          return (
            <Fragment key={cmp.date}>
              <tr
                className={cn(
                  'border-b border-border/40 cursor-pointer hover:bg-muted/30 transition-colors',
                  confirmed && 'bg-emerald-50/50 dark:bg-emerald-950/20',
                )}
                onClick={() => toggle(cmp.date)}
                aria-expanded={open}
              >
                <td className="py-1.5 px-2 font-medium whitespace-nowrap">{fmtDay(cmp.date)}</td>
                <td className="py-1.5 px-2 text-right font-mono">
                  {cmp.cardTotalZ ? (
                    <span className={cn(cmp.cardTotalZ.overridden && 'bg-yellow-100 dark:bg-yellow-950/50 rounded px-1')}>
                      {fmtChf(cmp.cardTotalZ.value)}
                    </span>
                  ) : <span className="text-muted-foreground/40 italic">kein Z-Bericht</span>}
                </td>
                <td className="py-1.5 px-2 text-right font-mono">
                  {cmp.cardTotalAdyen ? (
                    <span className={cn(cmp.cardTotalAdyen.overridden && 'bg-yellow-100 dark:bg-yellow-950/50 rounded px-1')}>
                      {fmtChf(cmp.cardTotalAdyen.value)}
                    </span>
                  ) : <span className="text-muted-foreground/40 italic">kein Adyen</span>}
                </td>
                <td className="py-1.5 px-2 text-right">
                  <DiffCell diff={cmp.totalDiff} status={cmp.totalStatus} />
                </td>
                <td className="py-1.5 px-2">
                  <DayStateBadges
                    hasAdyen={cmp.hasAdyen}
                    hasOverrides={cmp.hasOverrides}
                    hasComments={cmp.hasComments}
                    confirmed={confirmed}
                  />
                </td>
                <td className="py-1.5 px-1 text-center text-muted-foreground">
                  {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </td>
              </tr>

              {open && (
                <tr className="border-b border-border/40 bg-muted/10">
                  <td colSpan={6} className="p-3">
                    <div className="grid gap-4 md:grid-cols-[1fr_260px]">
                      {/* Zahlungsarten-Vergleich */}
                      <div>
                        <p className="text-[11px] font-semibold text-muted-foreground mb-1.5">
                          Zahlungsarten-Abgleich
                        </p>
                        <table className="w-full text-xs border-collapse">
                          <thead>
                            <tr className="text-muted-foreground border-b border-border/40">
                              <th className="text-left py-1 px-1 font-medium">Zahlungsart</th>
                              <th className="text-right py-1 px-1 font-medium">Z-Bericht</th>
                              <th className="text-right py-1 px-1 font-medium">Adyen</th>
                              <th className="text-right py-1 px-1 font-medium">Differenz</th>
                            </tr>
                          </thead>
                          <tbody>
                            {cmp.rows.map(r => (
                              <tr key={r.methodKey} className="border-b border-border/20">
                                <td className="py-1 px-1">{r.label}</td>
                                <td className="py-1 px-1 text-right whitespace-nowrap">
                                  <AmountCell
                                    ev={r.zbericht}
                                    label={`${r.label} (Z-Bericht)`}
                                    disabled={disabled}
                                    onOverride={(orig, corr, com) => onOverride(r.zberichtFieldKey, orig, corr, com)}
                                  />
                                  <CommentButton
                                    comment={r.zberichtComment}
                                    disabled={disabled}
                                    label={`${r.label} (Z-Bericht)`}
                                    onSave={t => onComment(r.zberichtFieldKey, t)}
                                  />
                                </td>
                                <td className="py-1 px-1 text-right whitespace-nowrap">
                                  <AmountCell
                                    ev={r.adyen}
                                    label={`${r.label} (Adyen)`}
                                    disabled={disabled}
                                    onOverride={(orig, corr, com) => onOverride(r.adyenFieldKey, orig, corr, com)}
                                  />
                                  <CommentButton
                                    comment={r.adyenComment}
                                    disabled={disabled}
                                    label={`${r.label} (Adyen)`}
                                    onSave={t => onComment(r.adyenFieldKey, t)}
                                  />
                                </td>
                                <td className={cn('py-1 px-1 text-right font-mono font-semibold', diffColorClass(r.diffStatus))}>
                                  {r.zbericht && r.adyen ? (
                                    <DiffCell diff={r.diff} status={r.diffStatus} />
                                  ) : (
                                    <span title="Zahlungsart existiert nur auf einer Seite">
                                      <DiffCell diff={r.diff} status={r.diffStatus} />
                                    </span>
                                  )}
                                </td>
                              </tr>
                            ))}
                            {/* Total-Zeile */}
                            <tr className="border-t border-border font-semibold">
                              <td className="py-1 px-1">Total Karten/TWINT</td>
                              <td className="py-1 px-1 text-right whitespace-nowrap">
                                {cmp.cardTotalZ ? (
                                  <>
                                    <AmountCell
                                      ev={cmp.cardTotalZ}
                                      label="Total (Z-Bericht)"
                                      disabled={disabled}
                                      onOverride={(orig, corr, com) => onOverride(cmp.totalZFieldKey, orig, corr, com)}
                                    />
                                    <CommentButton
                                      comment={cmp.totalZComment}
                                      disabled={disabled}
                                      label="Total (Z-Bericht)"
                                      onSave={t => onComment(cmp.totalZFieldKey, t)}
                                    />
                                  </>
                                ) : <span className="text-muted-foreground/40">—</span>}
                              </td>
                              <td className="py-1 px-1 text-right whitespace-nowrap">
                                {cmp.cardTotalAdyen ? (
                                  <>
                                    <AmountCell
                                      ev={cmp.cardTotalAdyen}
                                      label="Total (Adyen)"
                                      disabled={disabled}
                                      onOverride={(orig, corr, com) => onOverride(cmp.totalAdyenFieldKey, orig, corr, com)}
                                    />
                                    <CommentButton
                                      comment={cmp.totalAdyenComment}
                                      disabled={disabled}
                                      label="Total (Adyen)"
                                      onSave={t => onComment(cmp.totalAdyenFieldKey, t)}
                                    />
                                  </>
                                ) : <span className="text-muted-foreground/40">—</span>}
                              </td>
                              <td className="py-1 px-1 text-right">
                                <DiffCell diff={cmp.totalDiff} status={cmp.totalStatus} />
                              </td>
                            </tr>
                          </tbody>
                        </table>

                        {/* Weitere Z-Bericht-Zahlungsarten (Bar, Gutscheine, …) */}
                        {cmp.nonCardRows.length > 0 && (
                          <div className="mt-3">
                            <p className="text-[11px] font-semibold text-muted-foreground mb-1">
                              Weitere Zahlungsarten (Z-Bericht)
                            </p>
                            <table className="w-full text-xs border-collapse">
                              <tbody>
                                {cmp.nonCardRows.map(r => (
                                  <tr key={r.methodKey} className="border-b border-border/20">
                                    <td className="py-1 px-1">{r.label}</td>
                                    <td className="py-1 px-1 text-right text-muted-foreground">{r.count}×</td>
                                    <td className="py-1 px-1 text-right whitespace-nowrap">
                                      <AmountCell
                                        ev={r.value}
                                        label={r.label}
                                        disabled={disabled}
                                        onOverride={(orig, corr, com) => onOverride(r.fieldKey, orig, corr, com)}
                                      />
                                      <CommentButton
                                        comment={r.comment}
                                        disabled={disabled}
                                        label={r.label}
                                        onSave={t => onComment(r.fieldKey, t)}
                                      />
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}

                        {cmp.hasAdyen && (
                          <p className="text-[10px] text-muted-foreground/60 mt-2">
                            Adyen-Import: {cmp.rows.reduce((s, r) => s + (r.adyen ? 1 : 0), 0)} Zahlungsart(en)
                          </p>
                        )}
                      </div>

                      {/* Tagesbestätigung */}
                      <div className="border border-border/60 rounded-md p-3 h-fit bg-background">
                        <p className="text-[11px] font-semibold mb-2">Tagesbestätigung</p>
                        <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                          <Checkbox
                            checked={cashCounted}
                            disabled={disabled || confirmed}
                            onCheckedChange={v => {
                              onConfirm(cmp.date, {
                                confirmed: false,
                                cashCounted: v === true,
                                ...(cmp.confirmation?.comment ? { comment: cmp.confirmation.comment } : {}),
                              });
                            }}
                          />
                          Barbestand gezählt und bestätigt
                        </label>

                        {!confirmed && !check.ok && (
                          <ul className="mt-2 space-y-0.5">
                            {check.missing.map(m => (
                              <li key={m} className="text-[10px] text-amber-700 dark:text-amber-400 flex items-start gap-1">
                                <XCircle className="h-3 w-3 shrink-0 mt-[1px]" /> {m}
                              </li>
                            ))}
                          </ul>
                        )}

                        {!confirmed && (
                          <>
                            <Textarea
                              value={confirmComments[cmp.date] ?? cmp.confirmation?.comment ?? ''}
                              onChange={e => setConfirmComments(c => ({ ...c, [cmp.date]: e.target.value }))}
                              placeholder="Kommentar zur Bestätigung (optional, z. B. bei Übersteuerung)…"
                              className="text-xs min-h-[44px] mt-2"
                              disabled={disabled}
                            />
                            <Button
                              size="sm"
                              className="h-7 text-xs mt-2 w-full"
                              disabled={disabled || !check.ok}
                              onClick={() => {
                                const comment = (confirmComments[cmp.date] ?? cmp.confirmation?.comment ?? '').trim();
                                onConfirm(cmp.date, {
                                  confirmed: true,
                                  cashCounted: true,
                                  confirmedAt: new Date().toISOString(),
                                  ...(comment ? { comment } : {}),
                                });
                              }}
                            >
                              <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Tag bestätigen
                            </Button>
                          </>
                        )}

                        {confirmed && (
                          <div className="mt-2 space-y-1">
                            <p className="text-[10px] text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
                              <CheckCircle2 className="h-3 w-3" />
                              Bestätigt{cmp.confirmation?.confirmedAt
                                ? ` am ${new Date(cmp.confirmation.confirmedAt).toLocaleString('de-CH')}`
                                : ''}
                            </p>
                            {cmp.confirmation?.comment && (
                              <p className="text-[10px] text-muted-foreground italic">„{cmp.confirmation.comment}"</p>
                            )}
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 text-[10px] w-full"
                              disabled={disabled}
                              onClick={() => onConfirm(cmp.date, {
                                confirmed: false,
                                cashCounted,
                                ...(cmp.confirmation?.comment ? { comment: cmp.confirmation.comment } : {}),
                              })}
                            >
                              Bestätigung aufheben
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
