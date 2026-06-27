import { useState } from "react";
import { Btn, Input } from "../design/ui.tsx";

// Editor for a variable's option list: each value is an editable row with a
// remove control, plus an input to append new values. Replaces the old
// comma-separated textarea so values are added/edited/removed one at a time.
export function OptionsEditor({
  values,
  onChange,
}: {
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const v = draft.trim();
    if (!v || values.includes(v)) {
      setDraft("");
      return;
    }
    onChange([...values, v]);
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-2">
      {values.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {values.map((val, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and freely added/removed
            <li key={i} className="flex items-center gap-2">
              <Input
                value={val}
                aria-label={`value ${i + 1}`}
                onChange={(e) => onChange(values.map((v, j) => (j === i ? e.target.value : v)))}
              />
              <button
                type="button"
                aria-label={`remove ${val}`}
                title="remove"
                onClick={() => onChange(values.filter((_, j) => j !== i))}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-sm text-subtle transition-colors hover:text-danger"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          placeholder="Add a value…"
          aria-label="new value"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <Btn variant="secondary" size="sm" onClick={add} disabled={!draft.trim()}>
          Add
        </Btn>
      </div>
      {values.length === 0 && (
        <p className="text-[12px] text-muted">
          No values yet — leave empty for a free-form text variable.
        </p>
      )}
    </div>
  );
}
