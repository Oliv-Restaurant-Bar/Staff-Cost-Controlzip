---
name: Partial vi.mock & module-internal calls
description: Why mocking a base export doesn't affect wrapper exports of the same module, and how to test components behind collapsed containers.
---

# Partial vi.mock greift nicht bei modul-internen Aufrufen

**Regel:** Wenn Modul X einen Wrapper-Export hat, der intern eine andere Funktion
desselben Moduls aufruft (z. B. eine «gated» Variante, die die Basis-Variante
aufruft), dann greift ein vi.mock der Basis-Funktion NICHT für Aufrufer des
Wrappers — der modul-interne Aufruf geht am Mock vorbei (Vitest ersetzt nur die
Import-Bindings der Konsumenten, nicht die internen Referenzen).

**Why:** Beim Umbau der StartOverview-Komponententests lieferten die
KPI-Zellen «—», obwohl die Basis-Werte-Funktion gemockt war — die Komponente
lief über den gated Wrapper, der intern die ECHTE (ungemockte) Logik aufrief.

**How to apply:** Beim partiellen Mocken einer Werte-/Registry-Fassade IMMER
alle Export-Einstiegspunkte mocken, die die Komponente nutzt (auch gated/
abgeleitete Varianten und Hilfsfunktionen wie missing-dependencies), nicht nur
die «Kern»-Funktion. Pass-through auf denselben Mock-Store reicht.

# Eingeklappte Container verbergen testids

Zusammenklappbare Bereiche mit persistiertem Zustand (Muster MoreKpis mit
`storageKey`, '1'/'0' in localStorage) rendern ihren Inhalt bei Tests gar nicht
— getByTestId schlägt fehl. Im Render-Helper vor dem render den storageKey auf
'1' setzen (oder aufklappen per Klick), statt die Assertions umzubauen.

# Supabase-transitive «reine» Module

Module, die (auch nur transitiv, z. B. via kpi-catalog → financial-metrics →
P&L-Engine) den Supabase-Client laden, brauchen `@vitest-environment happy-dom`
statt `node` — der Client greift beim Modul-Load auf localStorage zu.
