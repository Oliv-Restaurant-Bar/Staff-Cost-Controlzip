/**
 * Budget 2026 – Seed-Daten Beaulieu (aus Budget_Beaulieu_2026.xlsx)
 * ==================================================================
 * Alle monatlichen CHF-Werte stammen direkt aus dem Excel-File
 * (attached_assets/Budget_Beaulieu_2026_1776974903686.xlsx).
 * Monat-Index: 0 = Januar … 11 = Dezember
 *
 * Wird automatisch geladen wenn das Beaulieu-Budget 2026 leer ist.
 * Analog zu createSeededBudget2026() für Oliv.
 */

import { BudgetYear, BudgetPLLineItem, DEFAULT_PL_CATEGORIES } from '@/types/budget';

type MV = [number,number,number,number,number,number,number,number,number,number,number,number];

function mv(...v: number[]): MV {
  return v as MV;
}

/** Alle P&L-Positionen aus Budget Beaulieu 2026 Excel — korrekte categoryIds */
export const SEED_BEAULIEU_2026_LINE_ITEMS: BudgetPLLineItem[] = [

  // ── Betriebsertrag (3000) ─────────────────────────────────────────────────
  {
    id: 'pli_ertrag_a',
    categoryId: 'pl_revenue',
    accountNumber: '3000',
    label: 'Betriebsertrag Netto',
    valueType: 'chf',
    sortOrder: 1,
    isDefault: true,
    monthlyValues: mv(120000, 130000, 150000, 200000, 170000, 160000, 120000, 140000, 130000, 170000, 200000, 200000),
  },

  // ── Direkter Warenaufwand ─────────────────────────────────────────────────
  {
    id: 'pli_wein_wa',
    categoryId: 'pl_goods_cost',
    accountNumber: '4020',
    label: 'Wein',
    valueType: 'chf',
    sortOrder: 1,
    isDefault: true,
    monthlyValues: mv(3600, 3900, 4500, 6000, 5100, 4800, 3600, 4200, 3900, 5100, 6000, 6000),
  },
  {
    id: 'pli_bier_wa',
    categoryId: 'pl_goods_cost',
    accountNumber: '4030',
    label: 'Bier',
    valueType: 'chf',
    sortOrder: 2,
    isDefault: true,
    monthlyValues: mv(1800, 1950, 2250, 3000, 2550, 2400, 1800, 2100, 1950, 2550, 3000, 3000),
  },
  {
    id: 'pli_spirit_wa',
    categoryId: 'pl_goods_cost',
    accountNumber: '4040',
    label: 'Spirituosen',
    valueType: 'chf',
    sortOrder: 3,
    isDefault: true,
    monthlyValues: mv(1200, 1300, 1500, 2000, 1700, 1600, 1200, 1400, 1300, 1700, 2000, 2000),
  },
  {
    id: 'pli_mineral_wa',
    categoryId: 'pl_goods_cost',
    accountNumber: '4050',
    label: 'Mineral',
    valueType: 'chf',
    sortOrder: 4,
    isDefault: true,
    monthlyValues: mv(2400, 2600, 3000, 4000, 3400, 3200, 2400, 2800, 2600, 3400, 4000, 4000),
  },
  {
    id: 'pli_kueche_wa',
    categoryId: 'pl_goods_cost',
    accountNumber: '4060',
    label: 'Küche Warenaufwand',
    valueType: 'chf',
    sortOrder: 5,
    isDefault: true,
    monthlyValues: mv(22800, 24700, 28500, 38000, 32300, 30400, 22800, 26600, 24700, 32300, 38000, 38000),
  },
  {
    id: 'pli_kaffee_wa',
    categoryId: 'pl_goods_cost',
    accountNumber: '4070',
    label: 'Kaffee, Tee',
    valueType: 'chf',
    sortOrder: 6,
    isDefault: true,
    monthlyValues: mv(600, 650, 750, 1000, 850, 800, 600, 700, 650, 850, 1000, 1000),
  },
  {
    id: 'pli_uebrig_wa',
    categoryId: 'pl_goods_cost',
    accountNumber: '4090',
    label: 'Übriger Warenaufwand',
    valueType: 'chf',
    sortOrder: 7,
    isDefault: true,
    monthlyValues: mv(600, 650, 750, 1000, 850, 800, 600, 700, 650, 850, 1000, 1000),
  },
  {
    id: 'pli_betriebsmat',
    categoryId: 'pl_goods_cost',
    accountNumber: '4701',
    label: 'Betriebsmaterial Restaurant',
    valueType: 'chf',
    sortOrder: 8,
    isDefault: true,
    monthlyValues: mv(360, 390, 450, 600, 510, 480, 360, 420, 390, 510, 600, 600),
  },

  // ── Löhne (5000–5010) ─────────────────────────────────────────────────────
  {
    id: 'pli_lohn_fix',
    categoryId: 'pl_wages',
    accountNumber: '5000',
    label: 'Lohn FIX',
    valueType: 'chf',
    sortOrder: 1,
    isDefault: true,
    monthlyValues: mv(35000, 35000, 35000, 35000, 35000, 35000, 35000, 35000, 35000, 35000, 35000, 35000),
  },
  {
    id: 'pli_lohn_flex',
    categoryId: 'pl_wages',
    accountNumber: '5001',
    label: 'Lohn FLEX',
    valueType: 'chf',
    sortOrder: 2,
    isDefault: true,
    monthlyValues: mv(1800, 1950, 2250, 3000, 2550, 2400, 1800, 2100, 1950, 2550, 3000, 3000),
  },
  {
    id: 'pli_lohn_13',
    categoryId: 'pl_wages',
    accountNumber: '5002',
    label: '13. Monatslohn',
    valueType: 'chf',
    sortOrder: 3,
    isDefault: true,
    monthlyValues: mv(2400, 2600, 3000, 4000, 3400, 3200, 2400, 2800, 2600, 3400, 4000, 4000),
  },
  {
    id: 'pli_karate',
    categoryId: 'pl_wages',
    accountNumber: '5004',
    label: 'Personal Aushilfe',
    valueType: 'chf',
    sortOrder: 4,
    isDefault: true,
    isForceVisible: true,
    monthlyValues: mv(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  },
  {
    id: 'pli_zulagen',
    categoryId: 'pl_wages',
    accountNumber: '5010',
    label: 'Zulagen',
    valueType: 'chf',
    sortOrder: 5,
    isDefault: true,
    monthlyValues: mv(1200, 1300, 1500, 2000, 1700, 1600, 1200, 1400, 1300, 1700, 2000, 2000),
  },

  // ── Sozialversicherungen (5700–5730) ──────────────────────────────────────
  {
    id: 'pli_ahv',
    categoryId: 'pl_social',
    accountNumber: '5700',
    label: 'AHV / IV / EO / ALV',
    valueType: 'chf',
    sortOrder: 1,
    isDefault: true,
    monthlyValues: mv(3000, 3250, 3750, 5000, 4250, 4000, 3000, 3500, 3250, 4250, 5000, 5000),
  },
  {
    id: 'pli_bvg',
    categoryId: 'pl_social',
    accountNumber: '5720',
    label: 'BVG Personalversicherung',
    valueType: 'chf',
    sortOrder: 2,
    isDefault: true,
    monthlyValues: mv(1320, 1430, 1650, 2200, 1870, 1760, 1320, 1540, 1430, 1870, 2200, 2200),
  },
  {
    id: 'pli_uvg',
    categoryId: 'pl_social',
    accountNumber: '5730',
    label: 'UVG Unfallversicherung',
    valueType: 'chf',
    sortOrder: 3,
    isDefault: true,
    monthlyValues: mv(720, 780, 900, 1200, 1020, 960, 720, 840, 780, 1020, 1200, 1200),
  },

  // ── Übriger Personalaufwand (5890) ────────────────────────────────────────
  {
    id: 'pli_uebrig_pers',
    categoryId: 'pl_personnel_other',
    accountNumber: '5890',
    label: 'Übriger Personalaufwand',
    valueType: 'chf',
    sortOrder: 3,
    isDefault: true,
    monthlyValues: mv(120, 130, 150, 200, 170, 160, 120, 140, 130, 170, 200, 200),
  },

  // ── Raumaufwand (6000–6040) ───────────────────────────────────────────────
  {
    id: 'pli_miete',
    categoryId: 'pl_rent',
    accountNumber: '6000',
    label: 'Mietzins',
    valueType: 'chf',
    sortOrder: 1,
    isDefault: true,
    monthlyValues: mv(20860, 20860, 20860, 20860, 20860, 20860, 20860, 20860, 20860, 20860, 20860, 20860),
  },
  {
    id: 'pli_reinigung_ent',
    categoryId: 'pl_rent',
    accountNumber: '6040',
    label: 'Reinigung & Kehrichtgebühren',
    valueType: 'chf',
    sortOrder: 2,
    isDefault: true,
    monthlyValues: mv(1200, 1300, 1500, 2000, 1700, 1600, 1200, 1400, 1300, 1700, 2000, 2000),
  },

  // ── Unterhalt / URE (6100–6140) ───────────────────────────────────────────
  {
    id: 'pli_ure_maschinen',
    categoryId: 'pl_maintenance',
    accountNumber: '6100',
    label: 'URE Maschinen und Apparate',
    valueType: 'chf',
    sortOrder: 1,
    isDefault: true,
    monthlyValues: mv(960, 1040, 1200, 1600, 1360, 1280, 960, 1120, 1040, 1360, 1600, 1600),
  },
  {
    id: 'pli_ure_mobiliar',
    categoryId: 'pl_maintenance',
    accountNumber: '6110',
    label: 'URE Mobiliar und Einrichtung',
    valueType: 'chf',
    sortOrder: 2,
    isDefault: true,
    monthlyValues: mv(360, 390, 450, 600, 510, 480, 360, 420, 390, 510, 600, 600),
  },
  {
    id: 'pli_ure_edv',
    categoryId: 'pl_maintenance',
    accountNumber: '6140',
    label: 'EDV Installationen',
    valueType: 'chf',
    sortOrder: 3,
    isDefault: true,
    monthlyValues: mv(720, 780, 900, 1200, 1020, 960, 720, 840, 780, 1020, 1200, 1200),
  },

  // ── Energie (6400) ─────────────────────────────────────────────────────────
  {
    id: 'pli_energie',
    categoryId: 'pl_energy',
    accountNumber: '6400',
    label: 'Strom, Gas, Heizöl und Wasser',
    valueType: 'chf',
    sortOrder: 1,
    isDefault: true,
    monthlyValues: mv(3240, 3510, 4050, 5400, 4590, 4320, 3240, 3780, 3510, 4590, 5400, 5400),
  },

  // ── Verwaltungsaufwand (6500–6530) ────────────────────────────────────────
  {
    id: 'pli_bueromaterial',
    categoryId: 'pl_admin',
    accountNumber: '6500',
    label: 'Büromaterial',
    valueType: 'chf',
    sortOrder: 1,
    isDefault: true,
    monthlyValues: mv(120, 130, 150, 200, 170, 160, 120, 140, 130, 170, 200, 200),
  },
  {
    id: 'pli_telefon',
    categoryId: 'pl_admin',
    accountNumber: '6510',
    label: 'Telefon, Internet',
    valueType: 'chf',
    sortOrder: 3,
    isDefault: true,
    monthlyValues: mv(240, 260, 300, 400, 340, 320, 240, 280, 260, 340, 400, 400),
  },
  {
    id: 'pli_buchhaltung',
    categoryId: 'pl_admin',
    accountNumber: '6530',
    label: 'Buchhaltungshonorar',
    valueType: 'chf',
    sortOrder: 5,
    isDefault: true,
    monthlyValues: mv(2500, 2500, 2500, 2500, 2500, 2500, 2500, 2500, 2500, 2500, 2500, 2500),
  },

  // ── Marketing (6600) ──────────────────────────────────────────────────────
  {
    id: 'pli_werbung',
    categoryId: 'pl_marketing',
    accountNumber: '6600',
    label: 'Werbeaufwand',
    valueType: 'chf',
    sortOrder: 1,
    isDefault: true,
    monthlyValues: mv(960, 1040, 1200, 1600, 1360, 1280, 960, 1120, 1040, 1360, 1600, 1600),
  },

  // ── Übriger Betriebsaufwand (6690) ────────────────────────────────────────
  {
    id: 'pli_diverse_auslagen',
    categoryId: 'pl_other_op',
    accountNumber: '6690',
    label: 'Diverse Auslagen',
    valueType: 'chf',
    sortOrder: 1,
    isDefault: true,
    monthlyValues: mv(720, 780, 900, 1200, 1020, 960, 720, 840, 780, 1020, 1200, 1200),
  },

  // ── Finanzaufwand / Abschreibungen (6800–6940) ────────────────────────────
  {
    id: 'pli_finance_6800',
    categoryId: 'pl_finance',
    accountNumber: '6800',
    label: 'Abschreibungen',
    valueType: 'chf',
    sortOrder: 1,
    isDefault: true,
    monthlyValues: mv(504, 546, 630, 840, 714, 672, 504, 588, 546, 714, 840, 840),
  },
  {
    id: 'pli_bankspesen',
    categoryId: 'pl_finance',
    accountNumber: '6940',
    label: 'Bankspesen',
    valueType: 'chf',
    sortOrder: 3,
    isDefault: true,
    monthlyValues: mv(50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50),
  },
];

/**
 * Erstellt ein vollständiges, geseedetes BudgetYear 2026 für Beaulieu.
 * Analog zu createSeededBudget2026() für Oliv.
 */
export function createSeededBeaulieuBudget2026(): BudgetYear {
  const now = new Date().toISOString();
  const totalRevenue = SEED_BEAULIEU_2026_LINE_ITEMS
    .find(i => i.id === 'pli_ertrag_a')
    ?.monthlyValues.reduce((s, v) => s + v, 0) ?? 0;

  console.log(`[BUDGET-BEAULIEU] Auto-Seed 2026: ${SEED_BEAULIEU_2026_LINE_ITEMS.length} Konten, Umsatz Total CHF ${totalRevenue.toLocaleString('de-CH')}`);

  return {
    year: 2026,
    positions: [],
    rules: [],
    wasAutoCalculated: false,
    createdAt: now,
    updatedAt: now,
    plCategories: [...DEFAULT_PL_CATEGORIES],
    plLineItems: SEED_BEAULIEU_2026_LINE_ITEMS.map(item => ({ ...item, monthlyValues: [...item.monthlyValues] as typeof item.monthlyValues })),
  };
}
