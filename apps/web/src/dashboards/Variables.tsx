import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Dropdown } from "../design/Dropdown.tsx";
import { Btn, Input } from "../design/ui.tsx";
import { OptionsEditor } from "./OptionsEditor.tsx";
import type { DashboardVariable } from "./types.ts";

// A settings-style row used directly inside a dialog — title + description on
// the left, a compact control on the right, optional full-width content below.
// Unlike settings/rows.tsx it carries no card chrome (border/background): the
// surrounding dialog is the single card, and rows are separated by hairlines
// from a `divide-y` parent, so we don't stack a second outlined box inside.
function Row({
  title,
  description,
  control,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0">
          <div className="text-[13.5px] font-medium text-fg">{title}</div>
          {description && <p className="mt-0.5 text-[12.5px] text-muted">{description}</p>}
        </div>
        {control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

// ── Variable bar ────────────────────────────────────────────────────────────
// Row of selectors shown above the widget grid. Variables with an `options`
// list render a Dropdown; free-form variables (no options) render a text input.

export function VariableBar({
  variables,
  values,
  onChange,
  onManage,
  canManage,
}: {
  variables: DashboardVariable[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  onManage: () => void;
  canManage: boolean;
}) {
  if (variables.length === 0) {
    return canManage ? (
      <Btn variant="secondary" size="sm" onClick={onManage}>
        + add variable
      </Btn>
    ) : null;
  }
  return (
    <div className="flex flex-wrap items-end gap-4">
      {variables.map((v) => (
        <div key={v.name} className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted">{v.label || v.name}</span>
          {v.options.length > 0 ? (
            <Dropdown
              value={values[v.name] ?? ""}
              onChange={(val) => onChange(v.name, val)}
              options={v.options.map((o) => ({ value: o, label: o }))}
              searchable={v.options.length > 8}
              className="min-w-[140px]"
            />
          ) : (
            <Input
              value={values[v.name] ?? ""}
              placeholder="value"
              aria-label={v.label || v.name}
              onChange={(e) => onChange(v.name, e.target.value)}
              className="min-w-[140px]"
            />
          )}
        </div>
      ))}
      {canManage && (
        <button
          type="button"
          onClick={onManage}
          className="pb-2 text-[12px] text-subtle underline-offset-2 hover:text-fg hover:underline"
        >
          Edit variables
        </button>
      )}
    </div>
  );
}

// ── Shared modal shell ────────────────────────────────────────────────────────

function Modal({
  title,
  onClose,
  children,
  z = "z-50",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  z?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      role="presentation"
      className={`fixed inset-0 ${z} flex items-start justify-center overflow-y-auto bg-bg/70 px-4 py-12 backdrop-blur-md`}
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onClose();
      }}
    >
      <div
        role="presentation"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        className="w-full max-w-2xl"
      >
        <div className="rounded-lg border border-border bg-bg p-6 shadow-2xl">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              className="text-[12px] text-subtle hover:text-fg"
            >
              Close
            </button>
          </div>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Level 1: variable list manager ─────────────────────────────────────────────

function variableSummary(v: DashboardVariable): string {
  if (v.options.length === 0) return "Free-form text value";
  const n = v.options.length;
  const dflt = v.defaultValue || v.options[0];
  return `${n} value${n === 1 ? "" : "s"} · default: ${dflt}`;
}

export function VariablesManager({
  initial,
  saving,
  onSave,
  onClose,
}: {
  initial: DashboardVariable[];
  saving: boolean;
  onSave: (variables: DashboardVariable[]) => void | Promise<void>;
  onClose: () => void;
}) {
  // Local working copy is authoritative; each create/edit/delete persists the
  // full list (the API replaces it wholesale). Seeded once — we don't reseed
  // from `initial` so an in-flight refetch can't clobber the open editor.
  const [vars, setVars] = useState<DashboardVariable[]>(() => initial);
  // null = list view; "new" = configuring a fresh variable; number = editing index.
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const persist = async (next: DashboardVariable[]) => {
    setError(null);
    const prev = vars;
    setVars(next);
    try {
      await onSave(next);
    } catch (e) {
      setVars(prev); // roll back the optimistic update
      setError(e instanceof Error ? e.message : "Failed to save");
      throw e;
    }
  };

  const handleDelete = async (i: number) => {
    if (!window.confirm(`Delete variable "${vars[i]?.name}"?`)) return;
    await persist(vars.filter((_, j) => j !== i)).catch(() => {});
  };

  const commitConfig = async (v: DashboardVariable) => {
    const next = editing === "new" ? [...vars, v] : vars.map((x, j) => (j === editing ? v : x));
    await persist(next); // throws on failure so the config dialog stays open
    setEditing(null);
  };

  return (
    <>
      <Modal title="Dashboard variables" onClose={onClose}>
        <p className="mb-5 text-[12.5px] leading-relaxed text-muted">
          A variable is a named picklist that drives widget filters. Reference it from any filter
          value with{" "}
          <code className="rounded-sm bg-surface-2 px-1 font-mono text-[11px]">$name</code>; the
          selected value is substituted into every matching filter when the dashboard renders.
        </p>

        {vars.length === 0 ? (
          <div className="py-6 text-center">
            <p className="text-[13px] text-muted">No variables yet.</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {vars.map((v, i) => (
              <Row
                key={v.name}
                title={
                  <button
                    type="button"
                    onClick={() => setEditing(i)}
                    className="text-left text-[13.5px] font-medium text-fg hover:underline"
                  >
                    {v.label || v.name}{" "}
                    <span className="font-mono text-[12px] text-subtle">${v.name}</span>
                  </button>
                }
                description={variableSummary(v)}
                control={
                  <>
                    <Btn variant="ghost" size="sm" onClick={() => setEditing(i)}>
                      Edit
                    </Btn>
                    <Btn
                      variant="ghost"
                      size="sm"
                      disabled={saving}
                      onClick={() => handleDelete(i)}
                    >
                      Delete
                    </Btn>
                  </>
                }
              />
            ))}
          </div>
        )}

        <div className="mt-4 flex items-center gap-3">
          <Btn variant="secondary" size="sm" onClick={() => setEditing("new")}>
            + add variable
          </Btn>
          {saving && <span className="text-[12px] text-muted">Saving…</span>}
          {error && (
            <span className="text-[12px] text-danger" role="alert">
              {error}
            </span>
          )}
        </div>

        <div className="mt-6 flex justify-end border-t border-border pt-4">
          <Btn onClick={onClose}>Done</Btn>
        </div>
      </Modal>

      {editing !== null && (
        <VariableConfigDialog
          initial={editing === "new" ? null : (vars[editing] ?? null)}
          existingNames={vars.filter((_, j) => j !== editing).map((v) => v.name)}
          submitting={saving}
          onSubmit={commitConfig}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

// ── Level 2: single-variable configuration ─────────────────────────────────────

type DraftVar = {
  name: string;
  label: string;
  options: string[];
  defaultValue: string;
  attributeKey: string;
};

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const NONE = "__none__";

function toDraft(v: DashboardVariable | null): DraftVar {
  return {
    name: v?.name ?? "",
    label: v?.label ?? "",
    options: v ? [...v.options] : [],
    defaultValue: v?.defaultValue ?? "",
    attributeKey: v?.attributeKey ?? "",
  };
}

function VariableConfigDialog({
  initial,
  existingNames,
  submitting,
  onSubmit,
  onClose,
}: {
  initial: DashboardVariable | null;
  existingNames: string[];
  submitting: boolean;
  onSubmit: (v: DashboardVariable) => void | Promise<void>;
  onClose: () => void;
}) {
  const [d, setD] = useState<DraftVar>(() => toDraft(initial));
  const [error, setError] = useState<string | null>(null);
  const patch = (p: Partial<DraftVar>) => setD((cur) => ({ ...cur, ...p }));

  const submit = async () => {
    setError(null);
    const name = d.name.trim();
    if (!name) return setError("Name is required");
    if (!NAME_RE.test(name)) {
      return setError(
        `"${name}" is not a valid name (letters, digits, underscore; must start with a letter)`,
      );
    }
    if (existingNames.includes(name)) return setError(`A variable named "${name}" already exists`);
    const options = d.options.map((o) => o.trim()).filter((o) => o.length > 0);
    const defaultValue = d.defaultValue.trim();
    if (defaultValue && options.length > 0 && !options.includes(defaultValue)) {
      return setError(`Default "${defaultValue}" is not one of the values`);
    }
    const variable: DashboardVariable = {
      name,
      ...(d.label.trim() ? { label: d.label.trim() } : {}),
      options,
      ...(defaultValue ? { defaultValue } : {}),
      ...(d.attributeKey.trim() ? { attributeKey: d.attributeKey.trim() } : {}),
    };
    try {
      await onSubmit(variable);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save variable");
    }
  };

  return (
    <Modal title={initial ? "Edit variable" : "New variable"} onClose={onClose} z="z-[60]">
      <div className="divide-y divide-border">
        <Row
          title="Name"
          description="Referenced in widget filters as $name"
          control={
            <div className="w-56">
              <Input
                value={d.name}
                placeholder="env"
                className="font-mono text-[12.5px]"
                onChange={(e) => patch({ name: e.target.value })}
              />
            </div>
          }
        />
        <Row
          title="Label"
          description="Shown above the dropdown (defaults to the name)"
          control={
            <div className="w-56">
              <Input
                value={d.label}
                placeholder="Environment"
                onChange={(e) => patch({ label: e.target.value })}
              />
            </div>
          }
        />
        <Row title="Values" description="Options shown in the dashboard's dropdown">
          <OptionsEditor
            values={d.options}
            onChange={(options) => {
              // Drop the default if its value was removed.
              const keepDefault = options.includes(d.defaultValue) ? d.defaultValue : "";
              patch({ options, defaultValue: keepDefault });
            }}
          />
        </Row>
        <Row
          title="Default value"
          description="Selected when the dashboard first loads"
          control={
            d.options.length > 0 ? (
              <div className="w-56">
                <Dropdown
                  value={d.defaultValue || NONE}
                  onChange={(v) => patch({ defaultValue: v === NONE ? "" : v })}
                  searchable={d.options.length > 8}
                  options={[
                    { value: NONE, label: "First value" },
                    ...d.options.map((o) => ({ value: o, label: o })),
                  ]}
                />
              </div>
            ) : (
              <div className="w-56">
                <Input
                  value={d.defaultValue}
                  placeholder="optional"
                  onChange={(e) => patch({ defaultValue: e.target.value })}
                />
              </div>
            )
          }
        />
        <Row
          title="Attribute key"
          description="Optional — enables a one-click filter chip in the widget editor"
          control={
            <div className="w-56">
              <Input
                value={d.attributeKey}
                placeholder="deployment.environment"
                className="font-mono text-[12.5px]"
                onChange={(e) => patch({ attributeKey: e.target.value })}
              />
            </div>
          }
        />
      </div>

      <div className="mt-6 flex items-center justify-end gap-3 border-t border-border pt-4">
        {error && (
          <span className="mr-auto text-[12px] text-danger" role="alert">
            {error}
          </span>
        )}
        <Btn variant="ghost" onClick={onClose}>
          Cancel
        </Btn>
        <Btn onClick={submit} loading={submitting}>
          {initial ? "Save variable" : "Add variable"}
        </Btn>
      </div>
    </Modal>
  );
}
