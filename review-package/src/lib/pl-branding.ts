/**
 * pl-branding.ts – Restaurant-spezifisches CI/CD-Branding für PDF-Exporte
 * =========================================================================
 *
 * Jedes Restaurant hat:
 *   - eigene Hintergrundfarbe (headerBg)
 *   - eigene Akzentfarbe (accentColor) für Linie + Logo
 *   - passende Textfarben
 *   - SVG-Wordmark-Logo (transparent, weiss/hell auf dunklem Hintergrund)
 *
 * Neues Restaurant hinzufügen:
 *   1. Eintrag in RESTAURANT_BRANDING ergänzen
 *   2. getBranding() falls nötig anpassen
 */

export interface RestaurantBranding {
  id:            string;
  displayName:   string;                      // "Oliv Restaurant & Bar"
  companyLine:   string;                      // Footer-Text "Oliv Gastro AG"
  headerBg:      [number, number, number];    // Header-Hintergrundfarbe
  accentColor:   [number, number, number];    // Akzentlinie + Logo-Tint
  textPrimary:   [number, number, number];    // Restaurant-Name + Monat
  textSecondary: [number, number, number];    // Berichtstyp + Datum
  logoSvg:       string;                      // SVG-Markup (transparent bg)
}

// ── SVG-Logos ────────────────────────────────────────────────────────────────

const OLIV_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 56" width="220" height="56">
  <!-- Olive leaf icon -->
  <g transform="translate(6,28)">
    <ellipse cx="0" cy="0" rx="9" ry="3.2" transform="rotate(-38)" fill="#8aad60" opacity="0.95"/>
    <ellipse cx="0" cy="0" rx="9" ry="3.2" transform="rotate(22)" fill="#6e9248" opacity="0.9"/>
    <ellipse cx="0" cy="0" rx="7.5" ry="2.8" transform="rotate(-15)" fill="#a0c070" opacity="0.75"/>
    <line x1="0" y1="-14" x2="0" y2="8" stroke="#c8aa48" stroke-width="0.9" stroke-linecap="round"/>
    <circle cx="0" cy="-14" r="1.6" fill="#c8aa48" opacity="0.85"/>
  </g>
  <!-- OLIV wordmark -->
  <text x="26" y="34"
    font-family="Georgia,'Times New Roman',serif"
    font-size="30" font-weight="bold"
    fill="#ffffff" letter-spacing="7">OLIV</text>
  <!-- Tagline -->
  <text x="27" y="50"
    font-family="Georgia,'Times New Roman',serif"
    font-size="7.5" fill="#b8d098" letter-spacing="3.8">RESTAURANT &amp; BAR</text>
</svg>`;

// Beaulieu Gold: #C09A34 → RGB [192, 154, 52]
// Warm heraldic gold – the same tone used for "DE HEIME IR LÄNGGASS" lettering.
// Sits between amber and classic gold: not too yellow, not bronze.
const BEAULIEU_GOLD = '#C09A34';

const BEAULIEU_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 56" width="240" height="56">
  <!-- Fleur-de-lis style emblem -->
  <g transform="translate(8,8)">
    <!-- Centre petal -->
    <ellipse cx="7" cy="4" rx="2.2" ry="5.5" fill="${BEAULIEU_GOLD}" opacity="0.95"/>
    <!-- Left petal -->
    <ellipse cx="7" cy="5" rx="4.5" ry="2.0" transform="rotate(-30 7 5)" fill="${BEAULIEU_GOLD}" opacity="0.78"/>
    <!-- Right petal -->
    <ellipse cx="7" cy="5" rx="4.5" ry="2.0" transform="rotate(30 7 5)" fill="${BEAULIEU_GOLD}" opacity="0.78"/>
    <!-- Stem -->
    <rect x="6.1" y="9" width="1.8" height="5" fill="${BEAULIEU_GOLD}" opacity="0.65" rx="0.9"/>
    <!-- Base bar -->
    <rect x="3" y="13.5" width="8" height="1.4" fill="${BEAULIEU_GOLD}" opacity="0.5" rx="0.7"/>
  </g>
  <!-- BEAULIEU wordmark -->
  <text x="26" y="33"
    font-family="Georgia,'Times New Roman',serif"
    font-size="22" font-weight="bold"
    fill="#ffffff" letter-spacing="4">BEAULIEU</text>
  <!-- Tagline: exact text from restaurant identity -->
  <text x="27" y="48"
    font-family="Georgia,'Times New Roman',serif"
    font-size="7" fill="${BEAULIEU_GOLD}"
    letter-spacing="2.8">DE HEIME IR LÄNGGASS</text>
</svg>`;

// ── Branding-Konfiguration ────────────────────────────────────────────────────

export const RESTAURANT_BRANDING: Record<string, RestaurantBranding> = {
  oliv: {
    id:           'oliv',
    displayName:  'Oliv Restaurant & Bar',
    companyLine:  'Oliv Gastro AG',
    headerBg:     [35, 59, 47],    // #233b2f – echtes Olivgrün
    accentColor:  [182, 152, 72],  // gedämpftes Olive-Gold
    textPrimary:  [255, 255, 255],
    textSecondary:[188, 208, 182], // warmes Hellgrün
    logoSvg:      OLIV_SVG,
  },
  beaulieu: {
    id:           'beaulieu',
    displayName:  'Beaulieu Restaurant',
    companyLine:  'Beaulieu Restaurant',
    //
    // Hintergrund: warmes dunkles Tannengrün → Fine-Dining / Boutique-Hotel
    // [33, 52, 42] = #213428 — nicht schwarz, hat Tiefe, harmoniert mit Gold
    headerBg:     [33, 52, 42],
    //
    // Akzentgold: #C09A34 = [192, 154, 52]
    // Warmes, heraldisches Gold — exakt der Ton aus "DE HEIME IR LÄNGGASS"
    // Weder zu gelb (kein Neon-Gelb) noch Bronze (kein Braun-Anteil)
    accentColor:  [192, 154, 52],
    //
    textPrimary:  [255, 255, 255],
    textSecondary:[220, 200, 158], // warmes Creme, harmoniert mit dem Gold
    logoSvg:      BEAULIEU_SVG,
  },
};

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

/** Branding anhand der Tenant-ID ermitteln */
export function getBranding(tenantId: string): RestaurantBranding {
  if (tenantId === 'beaulieu') return RESTAURANT_BRANDING.beaulieu;
  return RESTAURANT_BRANDING.oliv;
}

/**
 * SVG-String → base64-PNG Data-URL (via Browser-Canvas)
 * Gibt '' zurück wenn Canvas nicht verfügbar (SSR / Test-Umgebung).
 */
export async function renderLogoDataUrl(
  branding: RestaurantBranding,
  w = 240,
  h = 56,
): Promise<string> {
  try {
    const blob = new Blob([branding.logoSvg], { type: 'image/svg+xml' });
    const url  = URL.createObjectURL(blob);

    return await new Promise<string>((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width  = w * 2;   // 2× für scharfe Darstellung
          canvas.height = h * 2;
          const ctx = canvas.getContext('2d');
          if (!ctx) { resolve(''); return; }
          ctx.scale(2, 2);
          ctx.drawImage(img, 0, 0, w, h);
          URL.revokeObjectURL(url);
          resolve(canvas.toDataURL('image/png'));
        } catch {
          resolve('');
        }
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(''); };
      img.src = url;
    });
  } catch {
    return '';
  }
}
