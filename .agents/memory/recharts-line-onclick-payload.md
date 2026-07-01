---
name: recharts Line onClick has no point payload
description: Why clicking individual chart points needs a custom dot renderer, not Line/activeDot onClick
---

In recharts (v2.x), `<Line onClick={fn}>` is attached only to the curve path and
is invoked as `fn(curveProps, event)` — `curveProps` has `points`, never a single
point `payload`. So `d?.payload?.weekday`-style handlers on `<Line onClick>` are
dead code (silent no-op). `activeDot={{ ..., onClick }}` also receives the activeDot
config object, not the data-point payload.

**Rule:** to make individual chart points clickable and know WHICH point/series was
clicked, pass a render function to `dot` (and `activeDot`): `dot={renderDot(seriesKey)}`.
The render-function props DO include `payload` (the data row), plus `cx`/`cy`/`index`/`value`.
Guard against null values (`connectNulls={false}` still calls the renderer with
`value===null` / non-finite `cx`) and return an empty `<g/>` for those.

**Why:** chart-level `<LineChart onClick>` fires with `activeLabel`/`activePayload`
but cannot distinguish which of several overlapping series lines was clicked, so it
can't carry the series identity a per-point detail popup needs.

**How to apply:** any "click a chart point to drill down" requirement in this repo
(e.g. Saisonvergleich line chart in SeasonComparisonSection) must use the custom
`dot`/`activeDot` render-prop pattern, not Line/activeDot onClick.
