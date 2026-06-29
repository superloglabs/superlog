# Design guidelines

House rules for the web UI. These are conventions every component and mockup
should follow.

## Typography

### NEVER USE MONOSPACE CAPS

Do **not** combine a monospace font with uppercased text. No
`font-mono` + `uppercase`, no all-caps labels, eyebrows, table headers, badges,
or section titles set in a monospace typeface — anywhere, in product UI or in
design mockups.

- **Why:** monospace caps read as cramped, dated, and "terminal-cosplay"; the
  even glyph widths plus capital letterforms kill the hierarchy that small
  labels are supposed to provide.
- **Instead:** use the sans (Inter) for labels. If you need a quiet,
  small label, reach for size, weight, color (`text-muted` / `text-subtle`),
  and light letter-spacing — not monospace and not all-caps.
- **Monospace is still fine** for genuinely monospaced content: code, log lines,
  JSON, IDs, keys, numeric/tabular values. Just keep it in its natural case.
- **All-caps is still fine** in the sans, used sparingly, for very small labels.

```
/* ✗ banned */
<span class="font-mono uppercase tracking-[0.2em]">Telemetry sources</span>

/* ✓ ok — sans label */
<span class="text-[12px] font-medium text-muted">Telemetry sources</span>

/* ✓ ok — monospace in its natural case (code / values) */
<code class="font-mono">sl_public_…</code>
```
