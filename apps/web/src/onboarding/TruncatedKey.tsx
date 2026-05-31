// Renders an API key as "prefix⋯suffix" visually, but keeps the full key in
// the DOM so manual select-and-copy yields the complete plaintext value.
// The ellipsis itself is user-select:none so it never ends up in the paste.

const VISUALLY_HIDDEN: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

export function TruncatedKey({
  value,
  head = 14,
  tail = 6,
  className,
}: {
  value: string;
  head?: number;
  tail?: number;
  className?: string;
}) {
  if (value.length <= head + tail + 1) return <span className={className}>{value}</span>;
  const headPart = value.slice(0, head);
  const middlePart = value.slice(head, value.length - tail);
  const tailPart = value.slice(-tail);
  return (
    <span className={className}>
      {headPart}
      <span style={VISUALLY_HIDDEN}>{middlePart}</span>
      <span aria-hidden="true" style={{ userSelect: "none" }}>
        ⋯
      </span>
      {tailPart}
    </span>
  );
}
