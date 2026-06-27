# Design conventions

Guidance for building UI in this app. Read before adding or restyling components.

## No monospace caps

**Never use monospaced, all-caps, letter-spaced text for labels, headings, or chrome.**
That means do not reach for the combination:

```tsx
// ❌ don't
className="font-mono text-[10px] uppercase tracking-[0.2em] ..."
```

It reads as "terminal chrome", is hard to scan, and doesn't scale across
languages. Use a **capitalized** label in the normal UI font instead:

```tsx
// ✅ do — sentence-case or Title Case, normal weight, no tracking
className="text-[12px] font-medium text-muted"   // small label
className="text-[15px] font-semibold text-fg"    // dialog / section heading
```

Rules of thumb:

- **Labels & field titles:** Title Case or Sentence case, `font-medium`, muted
  tone. Match `settings/rows.tsx` (`SettingsRow` titles are `text-[13.5px]
  font-medium text-fg`, descriptions `text-[12.5px] text-muted`).
- **Headings:** normal font, `font-semibold`, `text-fg`.
- **No `uppercase`, no `tracking-[…]`, no `font-mono`** on text that a human
  reads as a word. Monospace is still fine for genuinely tabular/code content —
  ids, code, numbers in a table, raw attribute keys — just not for labels.

### Legacy

`Label` and `FieldLabel` in `src/design/ui.tsx` still render the old caps-mono
style and are used widely. Don't use them in new UI — prefer plain capitalized
text (or the `settings/rows.tsx` primitives). They'll be migrated over time;
until then, treat each one you touch as an opportunity to drop the caps-mono.
