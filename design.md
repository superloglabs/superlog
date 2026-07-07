# Design conventions

The canonical web design system — house rules, tokens, and the component catalog
— lives in **[`apps/web/DESIGN.md`](apps/web/DESIGN.md)**, paired with the live
`/design` sheet (`apps/web/src/design/DesignLanguage.tsx`). Read that before
adding or restyling UI.

The one rule worth repeating up front:

## No monospace caps

**Never combine a monospace font with uppercased text** for labels, headings, or
chrome (`font-mono` + `uppercase` + `tracking-[…]`). It reads as terminal chrome,
is hard to scan, and doesn't scale across languages. Use a capitalized label in
the sans (Inter) instead — `text-[13px] font-medium text-muted` for a small
label. Monospace stays fine for genuine code/ids/tabular values in their natural
case. Full rationale and examples: [`apps/web/DESIGN.md`](apps/web/DESIGN.md).

## Product principle — integration-first

Onboarding favors connected, no-code integrations over manual SDK wiring where
possible (referenced from `apps/web/src/onboarding/`). See that directory for the
connect-choice model.
