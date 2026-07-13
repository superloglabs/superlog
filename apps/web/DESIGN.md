# Web design system

House rules and the canonical component catalog for the web UI. Read this before
adding or restyling any component or building a mockup.

**This doc and the `/design` sheet are a pair.** The `/design` route
(`src/design/DesignLanguage.tsx`) is the *living* reference — it renders every
canonical primitive and token from the real modules. This file is the *written*
contract. If you change a primitive or a token, update **both**: the component in
`src/design/ui.tsx` (or `Dropdown.tsx`), and its panel in the `/design` sheet.
The sheet is how we catch drift — a change that isn't visible there didn't happen.

## The `/design` sheet

- Route: `/design` (served by `src/design/DesignLanguage.tsx`, wired in `src/main.tsx`).
- It renders with only a QueryClient — **no backend, no auth**. To view it:
  `pnpm --filter @superlog/web dev`, then open `http://localhost:<port>/design`.
- Sections: Principles, operational palette, typography & rhythm, actions &
  fields, selection & status, data display, and feedback.
- Keep it lean. It's a component catalog, not a page gallery. Don't grow it back
  into full-page route mocks — those lived here once and were removed on purpose.

## Source of truth — file map

| Concern | Lives in |
|---|---|
| Color / radius / font tokens | `src/index.css` (CSS vars, dark `:root` + light `:root[data-theme="light"]`) → mapped in `tailwind.config.ts` |
| Core primitives | `src/design/ui.tsx` |
| Signed-in product shell | `src/design/ProductShell.tsx` |
| Dropdown (themed single-select) | `src/design/Dropdown.tsx` |
| Range picker, row menu, scroll area | `src/design/RangePicker.tsx`, `RowMenu.tsx`, `scroll-area.tsx` |
| The catalog page | `src/design/DesignLanguage.tsx` |

`src/design/` is the shared component home — these modules are imported by 40+
app screens, **not** playground-only. Deleting or breaking them breaks the app.

## Tokens

Use the Tailwind classes backed by the CSS vars — **never hardcode hexes** in
components (the sheet may display a hex as a *label*, but styling goes through the
token). This keeps light/dark theming automatic.

- **Color:** `bg`, `surface`, `surface-2`, `surface-3` are near-black layers;
  `fg`, `muted`, `subtle` are warm neutral ink; `border`, `border-strong` create
  hierarchy with hairlines. `accent` / `accent-ink` / `accent-soft` are reserved
  for selection, links, and information. Primary actions use neutral `fg` on
  `bg`. `success` / `warning` / `danger` communicate state.
- **Radius:** `xs` 2 · `sm` 4 · `DEFAULT` 6 · `md` 8 · `lg` 12 · `xl` 14 ·
  `2xl` 18 (px). Use `rounded-full` only for dots, progress tracks, avatars, and
  objects that are genuinely circular—not for tabs or tags.
- **Spacing:** eight-pixel rhythm (4, 8, 12, 16, 24, 32, 48, 64).
- **Type:** Inter is the single interface family. The legacy `font-mono` Tailwind
  alias intentionally resolves to the same sans stack so older screens inherit
  this rule. True source-code blocks use the dedicated `.superlog-code` class.

## Typography — ONE INTERFACE TYPEFACE

Do not introduce a second typeface for IDs, timestamps, metrics, table values,
filters, badges, labels, shortcuts, or other interface chrome. Sans typography
keeps dense operational pages calm and lets weight, size, color, alignment, and
tabular numerals establish hierarchy.

- Use natural-case labels. For a quiet small label, reach for size, weight, and
  color (`text-muted` / `text-subtle`), not uppercase tracking.
- Use `tabular-nums` when vertically aligned numbers need stable widths.
- Genuine source code, JSON payloads, and stack traces may use
  `.superlog-code`; this is content rendering, not interface typography.

```tsx
// ✓ small interface label
<span className="text-[13px] font-medium text-muted">Telemetry sources</span>

// ✓ genuine code content opts in explicitly
<pre className="superlog-code">curl https://api.superlog.sh</pre>
```

## Canonical components (`src/design/ui.tsx` unless noted)

Reuse these. Don't hand-roll a new button/dropdown/tab/card inline — if a
primitive is missing, add it here and add a panel to the `/design` sheet.

- **`Btn`** — variants `primary` · `secondary` · `ghost` · `danger`; sizes
  `sm` · `md` · `lg`; `loading` / `disabled`. Primary is neutral high contrast;
  do not make every primary action blue.
- **`Chip`** (`ChipTone`) — small rectangular status/label token. The `dot`
  mode removes the fill and is preferred for live state.
- **`Tile`** — the card: bordered `surface`, `rounded-xl`, consistent padding.
  Compose content inside it. `MetricTile` is the number variant.
- **`DataList`, `DataListHeader`, `DataListRow`** — responsive table-like lists
  with semantic roles, quiet column headers, shared row rhythm, and hover state.
- **`Input`, `SearchInput`, `Select`** — form fields.
- **`Dropdown`** (`Dropdown.tsx`) — themed single-select, searchable by default;
  prefer over the native `Select` for anything non-trivial.
- **`Tabs`** — view switch. Capitalized sans, compact `rounded-md`, **no
  shadow**, no outer track. Active tab = `bg-surface-3 text-fg`; inactive =
  `text-muted hover:text-fg`. Sizes `sm` · `md`. Use for switching what a panel
  shows.
- **`PillToggle`** — the radio-semantic counterpart to `Tabs`; it shares the
  same compact rectangular selection language.
- **`PageHeader`** — the canonical title, supporting copy, and action row for a
  primary route.
- **`ProductShell`** (`ProductShell.tsx`) — the signed-in left rail, responsive
  navigation, and route toolbar. Primary product pages live inside this shell.
- **`Wordmark`, `ThemeToggle`, `useTheme`, `AppShell`, `CenteredShell`,
  `Sparkline`, `ShortcutKey`** — lower-level chrome and helpers.

`Label`, `FieldLabel`, and `MetricTile` now follow the same natural-case sans
language as the rest of the system. Prefer them over hand-rolled tracked or
uppercase labels.
