export function WidgetLoading() {
  return (
    <div className="flex h-full min-h-[120px] items-center justify-center font-mono text-[11px] text-subtle">
      loading…
    </div>
  );
}

export function WidgetEmpty() {
  return (
    <div className="flex h-full min-h-[120px] items-center justify-center font-mono text-[11px] text-subtle">
      no data
    </div>
  );
}
