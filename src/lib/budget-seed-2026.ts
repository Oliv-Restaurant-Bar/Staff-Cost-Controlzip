/**
 * Budget 2026 – Seed-Daten (aus Excel-Datei Budget_2026.xlsx)
 * ============================================================
 * Importiert beim ersten Laden des Budget-Jahres 2026 automatisch.
 * Alle monatlichen CHF-Werte stammen direkt aus dem Excel-File.
 *
 * Monat-Index: 0 = Januar … 11 = Dezember
 */

import { BudgetYear, BudgetPLLineItem, DEFAULT_PL_CATEGORIES } from '@/types/budget';

type MV = [number,number,number,number,number,number,number,number,number,number,number,number];

function mv(...v: number[]): MV {
  return v as MV;
}

/** Alle P&L-Positionen aus dem Budget 2026 Excel */
export const SEED_2026_LINE_ITEMS: BudgetPLLineItem[] = [

  // ── Betriebsertrag ─────────────────────────────────────────────────────────
  // "BETRIEBSERTRAG NETTO" als eine Gesamtposition (kein Kontoplan-Unterkonto im Excel)
  {
    id: 'pli_ertrag_a',
    categoryId: 'pl_revenue',
    accountNumber: '3000',
    label: 'Betriebsertrag Netto',
    valueType: 'chf',
    sortOrder: 1,
    isDefault: true,
    monthlyValues: mv(240000, 220000, 250000, 220000, 300000, 250000, 300000, 250000, 260000, 330000, 430000, 420000),
  },

  // ── Warenaufwand ───────────────────────────────────────────────────────────
  {
    id: 'pli_wein_wa',
    categoryId: 'pl_goods_cost',
    accountNumber: '4020',
    label: 'Wein',
    valueType: 'chf',
    sortOrder: 1,
    isDefault: true,
    monthlyValues: mv(7200, 6600, 7500, 6600, 9000, 7500, 9000, 7500, 7800, 9900, 12900, 12600),
  },
  {
    id: 'pli_bier_wa',
    categoryId: 'pl_goods_cost',
    accountNumber: '4030',
    label: 'Bier',
    valueType: 'chf',
    sortOrder: 2,
    isDefault: true,
    monthlyValues: mv(3600, 3300, 3750, 3300, 4500, 3750, 4500, 3750, 3900, 4950, 6450, 6300),
  },
  {
    id: 'pli_spirit_wa',
    categoryId: 'pl_goods_cost',
    accountNumber: '4040',
    label: 'Spirituosen',
    valueType: 'chf',
    sortOrder: 3,
    isDefault: true,
    monthlyValues: mv(2400, 2200, 2500, 2200, 3000, 2500, 3000, 2500, 2600, 3300, 4300, 4200),
  },
  {
    id: 'pli_mineral_wa',
    categoryId: 'pl_goods_cost',
    accountNumber: '4050',
    label: 'Mineral',
    valueType: 'chf',
    sortOrder: 4,
    isDefault: true,
    monthlyValues: mv(4800, 4400, 5000, 4400, 6000, 5000, 6000, 5000, 5200, 6600, 8600, 8400),
  },
  {
    id: 'pli_kueche_wa',
    categoryId: 'pl_goods_cost',
    accountNumber: '4060',
    label: 'Küche',
    valueType: 'chf',
    sortOrder: 5,
    isDefault: true,
    monthlyValues: mv(38880, 35640, 40500, 35640, 48600, 40500, 48600, 40500, 42120, 53460, 69660, 68040),
  },
  {
    id: 'pli_kaffee_wa',
    categoryId: 'pl_goods_cost',
    accountNumber: '4070',
    label: 'Kaffee',
    valueType: 'chf',
    sortOrder: 6,
    isDefault: true,
    monthlyValues: mv(1200, 1100, 1250, 1100, 1500, 1250, 1500, 1250, 1300, 1650, 2150, 2100),
  },
  {
    id: 'pli_uebrig_wa',
    categoryId: 'pl_goods_cost',
    accountNumber: '4090',
    label: 'Übriger Warenaufwand',
    valueType: 'chf',
    sortOrder: 7,
    isDefault: true,
    monthlyValues: mv(1200, 1100, 1250, 1100, 1500, 1250, 1500, 1250, 1300, 1650, 2150, 2100),
  },
  {
    id: 'pli_betriebsmat',
    categoryId: 'pl_goods_cost',
    accountNumber: '4701',
    label: 'Betriebsmaterial Restaurant',
    valueType: 'chf',
    sortOrder: 8,
    isDefault: true,
    monthlyValues: mv(720, 660, 750, 660, 900, 750, 900, 750, 780, 990, 1290, 1260),
  },

  // ── Lohnaufwand ────────────────────────────────────────────────────────────
  {
    id: 'pli_lohn_fix',
    categoryId: 'pl_wages',
    accountNumber: '5000',
    label: 'Lohn FIX',
    valueType: 'chf',
    sortOrder: 1,
    isDefault: true,
    monthlyValues: mv(80000, 80000, 67500, 80000, 80000, 67500, 80000, 80000, 70200, 80000, 80000, 113400),
  },
  {
    id: 'pli_lohn_flex',
    categoryId: 'pl_wages',
    accountNumber: '5001',
    label: 'Lohn FLEX',
    valueType: 'chf',
    sortOrder: 2,
    isDefault: true,
    monthlyValues: mv(3600, 3300, 3750, 3300, 4500, 3750, 4500, 3750, 3900, 4950, 6450, 6300),
  },
  {
    id: 'pli_lohn_13',
    categoryId: 'pl_wages',
    accountNumber: '5002',
    label: '13. Monatslohn',
    valueType: 'chf',
    sortOrder: 3,
    isDefault: true,
    monthlyValues: mv(4800, 4400, 5000, 4400, 6000, 5000, 6000, 5000, 5200, 6600, 8600, 8400),
  },
  {
    id: 'pli_lohn_ferien',
    categoryId: 'pl_wages',
    accountNumber: '5003',
    label: 'Lohn Zulagen',
    valueType: 'chf',
    sortOrder: 4,
    isDefault: true,
    monthlyValues: mv(2400, 2200, 2500, 2200, 3000, 2500, 3000, 2500, 2600, 3300, 4300, 4200),
  },

  // ── Sozialversicherungsaufwand ─────────────────────────────────────────────
  {
    id: 'pli_ahv',
    categoryId: 'pl_social',
    accountNumber: '5700',
    label: 'Sozialleistungen (AHV/IV/EO/ALV)',
    valueType: 'chf',
    sortOrder: 1,
    isDefault: true,
    monthlyValues: mv(6000, 5500, 6250, 5500, 7500, 6250, 7500, 6250, 6500, 8250, 10750, 10500),
  },
  {
    id: 'pli_bvg',
    categoryId: 'pl_social',
    accountNumber: '5710',
    label: 'Personalvorsorge (BVG)',
    valueType: 'chf',
    sortOrder: 2,
    isDefault: true,
    monthlyValues: mv(1440, 1320, 1500, 1320, 1800, 1500, 1800, 1500, 1560, 1980, 2580, 2520),
  },
  {
    id: 'pli_uvg',
    categoryId: 'pl_social',
    accountNumber: '5730',
    label: 'Personalversicherungen (UVG)',
    valueType: 'chf',
    sortOrder: 3,
    isDefault: true,
    monthlyValues: mv(2640, 2420, 2750, 2420, 3300, 2750, 3300, 2750, 2860, 3630, 4730, 4620),
  },

  // ── Übriger Personalaufwand ────────────────────────────────────────────────
  {
    id: 'pli_uebrig_pers',
    categoryId: 'pl_personnel_other',
    accountNumber: '5890',
    label: 'Übriger Personalaufwand',
    valueType: 'chf',
    sortOrder: 1,
    isDefault: true,
    monthlyValues: mv(240, 220, 250, 220, 300, 250, 300, 250, 260, 330, 430, 420),
  },

  // ── Raumaufwand ────────────────────────────────────────────────────────────
  {
    id: 'pli_miete',
    categoryId: 'pl_rent',
    accountNumber: '6000',
    label: 'Mietzins',
    valueType: 'chf',
    sortOrder: 1,
    isDefault: true,
    monthlyValues: mv(40500, 40500, 40500, 40500, 40500, 40500, 40500, 40500, 40500, 40500, 40500, 40500),
  },
  {
    id: 'pli_miete_parkplatz',
    categoryId: 'pl_rent',
    accountNumber: '6002',
    label: 'Mietzins Parkplatz',
    valueType: 'chf',
    sortOrder: 2,
    monthlyValues: mv(400, 400, 400, 400, 400, 400, 400, 400, 400, 400, 400, 400),
  },
  {
    id: 'pli_reinigung_ent',
    categoryId: 'pl_rent',
    accountNumber: '6040',
    label: 'Reinigung & Kehrichtgebühren',
    valueType: 'chf',
    sortOrder: 3,
    isDefault: true,
    monthlyValues: mv(2880, 2880, 2980, 2680, 3480, 2980, 3480, 2980, 3080, 3780, 4780, 4680),
  },

  // ── Unterhalt, Rep., Ersatz ────────────────────────────────────────────────
  {
    id: 'pli_ure_maschinen',
    categoryId: 'pl_maintenance',
    accountNumber: '6100',
    label: 'Maschinen und Apparate',
    valueType: 'chf',
    sortOrder: 1,
    isDefault: true,
    monthlyValues: mv(2400, 2200, 2500, 2200, 3000, 2500, 3000, 2500, 2600, 3300, 4300, 4200),
  },
  {
    id: 'pli_ure_mobiliar',
    categoryId: 'pl_maintenance',
    accountNumber: '6110',
    label: 'Mobiliar und Einrichtung',
    valueType: 'chf',
    sortOrder: 2,
    isDefault: true,
    monthlyValues: mv(720, 660, 750, 660, 900, 750, 900, 750, 780, 990, 1290, 1260),
  },
  {
    id: 'pli_ure_edv',
    categoryId: 'pl_maintenance',
    accountNumber: '6140',
    label: 'EDV Installationen',
    valueType: 'chf',
    sortOrder: 3,
    isDefault: true,
    monthlyValues: mv(1440, 1320, 1500, 1320, 1800, 1500, 1800, 1500, 1560, 1980, 2580, 2520),
  },

  // ── Fahrzeugaufwand (aus Excel: alle ~0) ───────────────────────────────────
  {
    id: 'pli_fzg_service',
    categoryId: 'pl_vehicles',
    accountNumber: '6200',
    label: 'Fahrzeug Service',
    valueType: 'chf',
    sortOrder: 1,
    isDefault: true,
    monthlyValues: mv(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  },
  {
    id: 'pli_fzg_benzin',
    categoryId: 'pl_vehicles',
    accountNumber: '6210',
    label: 'Fahrzeug Benzin',
    valueType: 'chf',
    sortOrder: 2,
    isDefault: true,
    monthlyValues: mv(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  },
  {
    id: 'pli_fzg_vers',
    categoryId: 'pl_vehicles',
    accountNumber: '6220',
    label: 'Fahrzeug Versicherung',
    valueType: 'chf',
    sortOrder: 3,
    isDefault: true,
    monthlyValues: mv(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  },
  {
    id: 'pli_fzg_leasing',
    categoryId: 'pl_vehicles',
    accountNumber: '6240',
    label: 'Fahrzeug Leasing',
    valueType: 'chf',
    sortOrder: 4,
    isDefault: true,
    monthlyValues: mv(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  },

  // ── Sachversicherungen, Abgaben, Gebühren ──────────────────────────────────
  {
    id: 'pli_haftpflicht',
    categoryId: 'pl_insurance',
    accountNumber: '6310',
    label: 'Betriebshaftpflicht',
    valueType: 'chf',
    sortOrder: 1,
    isDefault: true,
    monthlyValues: mv(1680, 1540, 1750, 1540, 2100, 1750, 2100, 1750, 1820, 2310, 3010, 2940),
  },
  {
    id: 'pli_abgaben',
    categoryId: 'pl_insurance',
    accountNumber: '6360',
    label: 'Gebühren und Abgaben',
    valueType: 'chf',
    sortOrder: 2,
    isDefault: true,
    monthlyValues: mv(1440, 1320, 1500, 1320, 1800, 1500, 1800, 1500, 1560, 1980, 2580, 2520),
  },

  // ── Energie- und Entsorgungsaufwand ────────────────────────────────────────
  {
    id: 'pli_energie',
    categoryId: 'pl_energy',
    accountNumber: '6400',
    label: 'Strom, Gas, Heizöl und Wasser',
    valueType: 'chf',
    sortOrder: 1,
    isDefault: true,
    monthlyValues: mv(6000, 5500, 6250, 5500, 7500, 6250, 7500, 6250, 6500, 8250, 10750, 10500),
  },

  // ── Verwaltungsaufwand ────────────────────────────────────────────────────
  {
    id: 'pli_bueromaterial',
    categoryId: 'pl_admin',
    accountNumber: '6500',
    label: 'Büromaterial',
    valueType: 'chf',
    sortOrder: 1,
    isDefault: true,
    monthlyValues: mv(240, 220, 250, 220, 300, 250, 300, 250, 260, 330, 430, 420),
  },
  {
    id: 'pli_telefon',
    categoryId: 'pl_admin',
    accountNumber: '6510',
    label: 'Telefon, Internet',
    valueType: 'chf',
    sortOrder: 3,
    isDefault: true,
    monthlyValues: mv(480, 440, 500, 440, 600, 500, 600, 500, 520, 660, 860, 840),
  },
  {
    id: 'pli_buchhaltung',
    categoryId: 'pl_admin',
    accountNumber: '6530',
    label: 'Buchhaltungshonorar',
    valueType: 'chf',
    sortOrder: 5,
    isDefault: true,
    monthlyValues: mv(5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000),
  },

  // ── Werbeaufwand ──────────────────────────────────────────────────────────
  {
    id: 'pli_werbung',
    categoryId: 'pl_marketing',
    accountNumber: '6600',
    label: 'Werbeaufwand',
    valueType: 'chf',
    sortOrder: 1,
    isDefault: true,
    monthlyValues: mv(1920, 1760, 2000, 1760, 2400, 2000, 2400, 2000, 2080, 2640, 3440, 3360),
  },

  // ── Übriger Betriebsaufwand ───────────────────────────────────────────────
  {
    id: 'pli_diverse_auslagen',
    categoryId: 'pl_other_op',
    accountNumber: '6690',
    label: 'Diverse Auslagen',
    valueType: 'chf',
    sortOrder: 1,
    isDefault: true,
    monthlyValues: mv(1440, 1320, 1500, 1320, 1800, 1500, 1800, 1500, 1560, 1980, 2580, 2520),
  },
  {
    id: 'pli_uebrig_betr',
    categoryId: 'pl_other_op',
    accountNumber: '6790',
    label: 'Sonstiger Verwaltungsaufwand',
    valueType: 'chf',
    sortOrder: 2,
    isDefault: true,
    monthlyValues: mv(1200, 1100, 1250, 1100, 1500, 1250, 1500, 1250, 1300, 1650, 2150, 2100),
  },

  // ── Finanzaufwand ─────────────────────────────────────────────────────────
  {
    id: 'pli_finance_6800',
    categoryId: 'pl_finance',
    accountNumber: '6800',
    label: 'Abschreibungen',
    valueType: 'chf',
    sortOrder: 1,
    monthlyValues: mv(1008, 924, 1050, 924, 1260, 1050, 1260, 1050, 1092, 1386, 1806, 1764),
  },
  {
    id: 'pli_zinsaufwand',
    categoryId: 'pl_finance',
    accountNumber: '6910',
    label: 'Zinsaufwand und Amortisation',
    valueType: 'chf',
    sortOrder: 2,
    monthlyValues: mv(20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000),
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
 * Erstellt ein vollständiges BudgetYear-Objekt für 2026
 * mit allen Daten aus dem Excel-File.
 */
export function createSeededBudget2026(): BudgetYear {
  const now = new Date().toISOString();
  return {
    year: 2026,
    positions: [],
    rules: [],
    wasAutoCalculated: false,
    createdAt: now,
    updatedAt: now,
    plCategories: DEFAULT_PL_CATEGORIES.map(c => ({ ...c })),
    plLineItems: SEED_2026_LINE_ITEMS,
  };
}
