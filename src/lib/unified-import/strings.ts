/**
 * strings.ts — language switch for the texts of the unified-import feature.
 * ==========================================================================
 * TEMPORARY WORKFLOW (developer preference): while building, UI_LANG is 'en' so the flow is readable.
 * BEFORE COMMITTING set UI_LANG = 'de' — the client's app is German. Every client-visible string of the feature
 * goes through `tr('Deutsch', 'English')`, so the switch is this one constant. Find leftovers with: grep -rn "tr(" .
 */

export type UiLang = 'de' | 'en';

export const UI_LANG = 'de' as UiLang; // 'de' = client language (commit state). Use 'en' only while developing

/** Returns the German or English text depending on UI_LANG. */
export const tr = (de: string, en: string): string => (UI_LANG === 'en' ? en : de);
