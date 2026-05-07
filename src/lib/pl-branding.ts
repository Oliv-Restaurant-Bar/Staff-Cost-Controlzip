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

const BEAULIEU_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 56" width="220" height="56">
  <!-- Fleur / emblem -->
  <g transform="translate(8,14)">
    <polygon points="6,0 7.5,5 12,5 8.5,8 9.8,13 6,10.2 2.2,13 3.5,8 0,5 4.5,5"
      fill="#c8a048" opacity="0.92"/>
    <rect x="5" y="13" width="2" height="4" fill="#c8a048" opacity="0.7" rx="1"/>
    <ellipse cx="6" cy="18" rx="4" ry="1.5" fill="#c8a048" opacity="0.5"/>
  </g>
  <!-- BEAULIEU wordmark -->
  <text x="26" y="34"
    font-family="Georgia,'Times New Roman',serif"
    font-size="22" font-weight="bold"
    fill="#ffffff" letter-spacing="4">BEAULIEU</text>
  <!-- Tagline -->
  <text x="27" y="50"
    font-family="Georgia,'Times New Roman',serif"
    font-size="7.5" fill="#d4c4a0" letter-spacing="4.2">RESTAURANT</text>
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
    headerBg:     [91, 68, 40],    // #5b4428 – warmes Dunkelbraun
    accentColor:  [200, 168, 88],  // warmes Gold
    textPrimary:  [255, 255, 255],
    textSecondary:[218, 200, 168], // warmes Beige
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
  w = 220,
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
