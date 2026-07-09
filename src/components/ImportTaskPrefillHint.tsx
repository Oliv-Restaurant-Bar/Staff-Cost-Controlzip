/**
 * ImportTaskPrefillHint — Hinweisbox für Checklisten-Prefill (advisory).
 * =====================================================================
 * Zeigt auf Import-Zielseiten den aus der Import-Checkliste übergebenen
 * erwarteten Zeitraum an (?from/&to bzw. ?year/&month). REIN INFORMATIV:
 * schränkt den Import-Flow nie ein — der Upload bleibt frei.
 *
 * `forTarget`: nur rendern, wenn ?target=… übereinstimmt (Seiten mit mehreren
 * Import-Sektionen wie ImportHub/Reporting). Ohne Prop: rendern, sobald
 * verwertbare Prefill-Params vorliegen.
 */
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { HintBox } from '@/components/ui/hint-box';
import { parseImportPrefill, prefillRangeLabel } from '@/lib/import-prefill';

export function ImportTaskPrefillHint({
  forTarget,
  className,
}: {
  forTarget?: string;
  className?: string;
}) {
  const [searchParams] = useSearchParams();
  const prefill = useMemo(() => parseImportPrefill(searchParams), [searchParams]);
  if (!prefill) return null;
  if (forTarget && prefill.target !== forTarget) return null;
  const label = prefillRangeLabel(prefill);
  if (!label) return null;
  return (
    <HintBox tone="info" title="Aufgabe aus der Import-Checkliste" className={className}>
      Erwarteter Zeitraum: <strong>{label}</strong> — der Import bleibt frei wählbar,
      dieser Hinweis dient nur zur Orientierung.
    </HintBox>
  );
}
