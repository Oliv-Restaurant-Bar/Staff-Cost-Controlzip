/**
 * swissApos — normalizes the Swiss thousands separator to the real
 * typographic apostrophe (U+2019 '’').
 *
 * `Intl.NumberFormat('de-CH')`/`toLocaleString('de-CH')` are supposed to use
 * U+2019 for the de-CH thousands grouping, but the exact character depends
 * on the runtime's ICU data — some Node/browser versions emit a plain ASCII
 * apostrophe (U+0027 "'") instead. That makes the separator the user sees
 * silently dependent on which environment renders it, not something the app
 * controls. Wrap every de-CH-formatted string in this to force the correct
 * character regardless of ICU version.
 */
export function swissApos(formatted: string): string {
  return formatted.replace(/'/g, '’');
}
