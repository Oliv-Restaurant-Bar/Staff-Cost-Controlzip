/**
 * Arbeitsvertrag-Entwurf: alle ankreuzbaren Optionen nach L-GAV.
 *
 * Wird vom interaktiven Editor befüllt und an generateContract()
 * übergeben — so kann der Admin jede Checkbox vor der PDF-Generierung
 * manuell anpassen.
 */

export interface ContractDraft {
  // ML-Header: a = Vollzeitmitarbeiter, b = Teilzeitmitarbeiter
  employmentMode: 'vollzeit' | 'teilzeit';

  // Art. 1c: Raucherbetrieb
  smokingConsent: 'aa' | 'bb';  // aa = Ja, bb = Nein

  // Art. 2: Vertragsdauer
  duration: 'unlimited' | 'limited_cancellable' | 'limited_fixed';
  endDate?: string;

  // Art. 3: Probezeit
  probation: 'three_months_7d' | 'fourteen_days' | 'none' | 'custom';
  probationMonths?: number;     // bei 'custom' (max 3)
  probationNoticeDays?: number; // bei 'custom' (min 3)

  // Art. 4: Kündigung
  notice: 'standard' | 'extended';
  noticeExtended?: string;

  // Art. 7: Berufsausbildung
  education: 'eba' | 'efz' | 'efz_plus' | 'berufspruefung' | 'other_cert' | 'progresso' | 'none';
  educationOtherText?: string;

  // Art. 9 Stufe I (ungelernt)
  wageRedI: 'first_12m' | 'first_3m' | 'none';

  // Art. 9 Stufe II+IIIa (EBA/EFZ)
  wageRedII: 'first_3m' | 'none';

  // Art. 10d: Lohnauszahlung
  paymentTiming: 'last' | 'sixth' | 'collective';

  // Art. 12a: Nachtarbeit-Fenster
  nightWork: 'aa' | 'bb' | 'cc' | 'dd';

  // Art. 12b: vorübergehend 6-Tage-Woche
  sixDayWork: boolean;

  // Art. 13: Besondere Vereinbarungen (Freitext)
  specialAgreements: string;
}

/** Erzeugt Standardwerte auf Basis der Employee-Daten */
export function defaultContractDraft(emp: {
  contractType?: string;
  weeklyHours?: number;
  isLimitedContract?: boolean;
  contractEnd?: string;
  trialPeriodMonths?: number;
}): ContractDraft {
  const isML    = emp.contractType === 'monthly';
  const wh      = emp.weeklyHours ?? 42;
  const pensum  = wh / 42;
  const probM   = emp.trialPeriodMonths ?? 3;

  return {
    employmentMode:  isML && pensum >= 1.0 ? 'vollzeit' : 'teilzeit',
    smokingConsent:  'aa',
    duration:        emp.isLimitedContract ? 'limited_cancellable' : 'unlimited',
    endDate:         emp.contractEnd,
    probation:       probM === 0 ? 'none' : probM === 3 ? 'custom' : 'custom',
    probationMonths: probM > 0 ? probM : undefined,
    probationNoticeDays: 3,
    notice:          'standard',
    education:       'none',
    wageRedI:        'none',
    wageRedII:       'none',
    paymentTiming:   isML ? 'sixth' : 'collective',
    nightWork:       'aa',
    sixDayWork:      false,
    specialAgreements: [
      'Arztzeugnisse werden ab dem 1. Krankheitstag verlangt.',
      'Stundenrapporte sind bis zum 5. des Folgemonats einzureichen.',
    ].join('\n'),
  };
}
