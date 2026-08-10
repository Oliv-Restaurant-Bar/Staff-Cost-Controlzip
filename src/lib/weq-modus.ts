/**
 * WEQ-Modus je Mandant/Jahr (Spec 08/2026): der Umschalter bestimmt NUR die
 * SOLL-Rechnung der Warenkosten (nie die Ist-Zahlen).
 *
 *  - 'gesamt' (Standard): EIN WEQ je Monat (Cockpit-Position «wareneinsatz»,
 *    manuell + Carry-Forward) gilt flach für Food UND Beverage:
 *    Food-Soll = WEQ × Food-Umsatz, Beverage-Soll = WEQ × Beverage-Umsatz,
 *    Total-Soll = WEQ × Netto (Food+Beverage=Netto ⇒ Summe stimmt exakt).
 *  - 'kategorie': Food-WEQ und Beverage-WEQ getrennt je Monat (manuell +
 *    Carry-Forward, Default = KATEGORIE_WEQ_DEFAULT aus waren-cockpit.ts);
 *    Total-Soll = Food-Soll + Beverage-Soll.
 *
 * Ablage: KV `weq-modus:<jahr>` (tenant-präfixiert). Quoten sind NETTO-%.
 * Regeln: leer statt 0, nie ÷0, mandantengetrennt, pro Jahr.
 */
import { kvGet, kvSetStrict } from '@/lib/supabase-kv';
import { weqCarryForward } from '@/lib/cockpit-budget';
import { KATEGORIE_WEQ_DEFAULT } from '@/lib/waren-cockpit';

type KeyFn = (key: string) => string;

export type WeqModus = 'gesamt' | 'kategorie';

export interface WeqModusBlob {
  year: number;
  modus: WeqModus;
  /** Manuell gesetzte Food-WEQ je Monat in % (null = kein manueller Wert). */
  foodManuell: (number | null)[];
  /** Manuell gesetzte Beverage-WEQ je Monat in %. */
  bevManuell: (number | null)[];
  updatedAt: string;
}

export const weqModusKvKey = (tenantKey: KeyFn, year: number) =>
  tenantKey(`weq-modus:${year}`);

const nullArr = () => Array(12).fill(null) as (number | null)[];

export function leererWeqModusBlob(year: number): WeqModusBlob {
  return { year, modus: 'gesamt', foodManuell: nullArr(), bevManuell: nullArr(), updatedAt: '' };
}

const readQ = (v: unknown): (number | null)[] =>
  Array.isArray(v) && v.length === 12
    ? v.map(x => (typeof x === 'number' && isFinite(x) && x > 0 ? x : null))
    : nullArr();

export async function loadWeqModus(
  tenantKey: KeyFn, year: number,
): Promise<WeqModusBlob | null> {
  const raw = await kvGet(weqModusKvKey(tenantKey, year)).catch(() => null);
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Partial<WeqModusBlob>;
  return {
    year,
    modus: b.modus === 'kategorie' ? 'kategorie' : 'gesamt',
    foodManuell: readQ(b.foodManuell),
    bevManuell: readQ(b.bevManuell),
    updatedAt: String(b.updatedAt ?? ''),
  };
}

export async function saveWeqModus(tenantKey: KeyFn, blob: WeqModusBlob): Promise<void> {
  await kvSetStrict(weqModusKvKey(tenantKey, blob.year), {
    ...blob, updatedAt: new Date().toISOString(),
  });
}

/**
 * Effektive Kategorie-WEQ je Monat (Modus 'kategorie'): manuell hat Vorrang,
 * hält per Carry-Forward bis zum nächsten manuellen Wert; sonst der
 * Gastronovi-/Mandanten-Default. Unbekannter Mandant ⇒ null (leer, nie raten).
 */
export function effektiveKategorieWeq(
  blob: WeqModusBlob | null, tenantId: string,
): { food: (number | null)[]; bev: (number | null)[] } {
  const def = KATEGORIE_WEQ_DEFAULT[tenantId as keyof typeof KATEGORIE_WEQ_DEFAULT] as
    { food: number; beverage: number } | undefined;
  const autoFood = def ? Array(12).fill(def.food) as number[] : nullArr();
  const autoBev = def ? Array(12).fill(def.beverage) as number[] : nullArr();
  return {
    food: weqCarryForward(blob?.foodManuell ?? nullArr(), autoFood),
    bev: weqCarryForward(blob?.bevManuell ?? nullArr(), autoBev),
  };
}
