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
- Sections: Tokens (color · type · space · radius), Card, Buttons, Dropdowns, Tabs.
- Keep it lean. It's a component catalog, not a page gallery. Don't grow it back
  into full-page route mocks — those lived here once and were removed on purpose.

## Source of truth — file map

| Concern | Lives in |
|---|---|
| Color / radius / font tokens | `src/index.css` (CSS vars, dark `:root` + light `:root[data-theme="light"]`) → mapped in `tailwind.config.ts` |
| Core primitives | `src/design/ui.tsx` |
| Dropdown (themed single-select) | `src/design/Dropdown.tsx` |
| Range picker, row menu, scroll area | `src/design/RangePicker.tsx`, `RowMenu.tsx`, `scroll-area.tsx` |
| The catalog page | `src/design/DesignLanguage.tsx` |

`src/design/` is the shared component home — these modules are imported by 40+
app screens, **not** playground-only. Deleting or breaking them breaks the app.

## Tokens

Use the Tailwind classes backed by the CSS vars — **never hardcode hexes** in
components (the sheet may display a hex as a *label*, but styling goes through the
token). This keeps light/dark theming automatic.

- **Color:** `bg`, `surface`, `surface-2`, `surface-3` (elevation); `fg`, `muted`,
  `subtle` (ink); `border`, `border-strong`; `accent` / `accent-ink` /
  `accent-soft` (single action color — one intense moment, used sparingly);
  `success` / `warning` / `danger` (signal).
- **Radius:** `sm` 2 · `DEFAULT` 4 · `md` 6 · `lg` 10 · `xl` 12 · `2xl` 14 (px).
  `rounded-full` for pills.
- **Spacing:** eight-pixel rhythm (4, 8, 12, 16, 24, 32, 48, 64).
- **Type:** `font-sans` = Inter, `font-mono` = JetBrains Mono.

## Typography — NEVER USE MONOSPACE CAPS

Do **not** combine a monospace font with uppercased text. No `font-mono` +
`uppercase`, no all-caps labels, eyebrows, table headers, badges, or section
titles set in a monospace typeface — anywhere, in product UI or in mockups.

- **Why:** monospace caps read as cramped, dated, "terminal-cosplay"; the even
  glyph widths plus capital letterforms kill the hierarchy small labels should
  provide.
- **Instead:** use the sans (Inter) in its natural case. For a quiet small label,
  reach for size, weight, and color (`text-muted` / `text-subtle`) — not
  monospace and not all-caps.
- **Monospace is still fine** for genuinely monospaced content: code, log lines,
  JSON, ids, keys, numeric/tabular values. Keep it in its natural case.

```tsx
// ✗ banned
<span className="font-mono text-[10px] uppercase tracking-[0.2em]">Telemetry sources</span>

// ✓ small label — capitalized sans
<span className="text-[13px] font-medium text-muted">Telemetry sources</span>

// ✓ monospace in its natural case (code / values)
<code className="font-mono">sl_public_…</code>
```

## Canonical components (`src/design/ui.tsx` unless noted)

Reuse these. Don't hand-roll a new button/dropdown/tab/card inline — if a
primitive is missing, add it here and add a panel to the `/design` sheet.

- **`Btn`** — variants `primary` · `secondary` · `ghost` · `danger`; sizes
  `sm` · `md` · `lg`; `loading` / `disabled`.
- **`Chip`** (`ChipTone`) — small status/label token.
- **`Tile`** — the card: bordered `surface`, `rounded-lg`, consistent padding.
  Compose content inside it. `MetricTile` is the number variant.
- **`Input`, `SearchInput`, `Select`** — form fields.
- **`Dropdown`** (`Dropdown.tsx`) — themed single-select, searchable by default;
  prefer over the native `Select` for anything non-trivial.
- **`Tabs`** — view switch. Capitalized sans, **fully rounded** (`rounded-full`),
  **no shadow**, no outer track. Active tab = filled `bg-surface-3 text-fg` pill;
  inactive = `text-muted hover:text-fg`. Sizes `sm` · `md`. Use for switching
  what a panel shows.
- **`PillToggle`** — the other segmented control (rounded-full, raised active
  pill); interchangeable with `Tabs` in style, radio semantics.
- **`Wordmark`, `ThemeToggle`, `useTheme`, `AppShell`, `CenteredShell`,
  `Sparkline`, `ShortcutKey`** — chrome and helpers.

### Legacy — being phased out

`Label`, `FieldLabel`, and `MetricTile`'s label in `src/design/ui.tsx` still
render the old mono-caps style and are used widely. **Don't use them in new UI**
— prefer a plain capitalized-sans label (`text-[13px] font-medium text-muted`),
as the `/design` sheet now does. Treat each one you touch as a chance to drop the
mono-caps. Flipping them at the source is a deliberate app-wide change (many call
sites pass lowercase strings that rely on the `uppercase` CSS) — audit call sites
first.
