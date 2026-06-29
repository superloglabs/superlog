import {
  CONNECT_SECTIONS,
  type ConnectAction,
  type ConnectIcon,
  type ConnectOption,
  type ConnectSection,
} from "./connectChoices.ts";
import {
  AgentSparkIcon,
  AwsIcon,
  ChevronRightIcon,
  CloudflareIcon,
  GithubActionsIcon,
  KubernetesIcon,
  OtelIcon,
  VercelIcon,
} from "./icons.tsx";
import { ExploreDemoLink, SOFT_LINE } from "./wizardChrome.tsx";

// The path chooser: a flat, low-color list (modeled on a Plugins page) that
// forks new users between no-code integrations (AWS first — integration-first)
// and the coding-agent skill. See design.md.

function ConnectGlyph({ icon }: { icon: ConnectIcon }) {
  const map: Record<ConnectIcon, typeof AwsIcon> = {
    aws: AwsIcon,
    otel: OtelIcon,
    agent: AgentSparkIcon,
    vercel: VercelIcon,
    kubernetes: KubernetesIcon,
    cloudflare: CloudflareIcon,
    githubActions: GithubActionsIcon,
  };
  const Glyph = map[icon];
  return <Glyph size={18} />;
}

function IconTile({ icon }: { icon: ConnectIcon }) {
  return (
    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] border border-border bg-surface-2 text-muted">
      <ConnectGlyph icon={icon} />
    </span>
  );
}

function ListRow({
  option,
  onPick,
}: {
  option: ConnectOption;
  onPick: (action: ConnectAction) => void;
}) {
  const disabled = option.action === null;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => option.action && onPick(option.action)}
      className={`group flex w-full items-center gap-3.5 px-[18px] py-[14px] text-left transition-colors ${
        disabled ? "cursor-default opacity-55" : "hover:bg-surface-2"
      }`}
    >
      <IconTile icon={option.icon} />
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium text-fg">{option.title}</span>
        <span className="mt-0.5 block text-[12.5px] leading-[1.45] text-muted">
          {option.description}
        </span>
      </span>
      {!disabled && (
        <span className="text-subtle transition-colors group-hover:text-muted">
          <ChevronRightIcon size={16} />
        </span>
      )}
    </button>
  );
}

function GridTile({ option }: { option: ConnectOption }) {
  return (
    <div
      className={`flex items-center gap-3 rounded-[12px] border bg-surface px-3.5 py-3 ${SOFT_LINE}`}
    >
      <IconTile icon={option.icon} />
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-fg">{option.title}</span>
        <span className="block text-[11.5px] text-subtle">{option.description}</span>
      </span>
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return <div className="mb-2.5 text-[13px] font-medium text-muted">{children}</div>;
}

function Section({
  section,
  onPick,
}: {
  section: ConnectSection;
  onPick: (action: ConnectAction) => void;
}) {
  return (
    <div>
      <SectionLabel>{section.label}</SectionLabel>
      {section.variant === "grid" ? (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {section.options.map((option) => (
            <GridTile key={option.id} option={option} />
          ))}
        </div>
      ) : (
        <div
          className={`divide-y divide-[rgba(255,255,255,0.07)] overflow-hidden rounded-[14px] border bg-surface ${SOFT_LINE}`}
        >
          {section.options.map((option) => (
            <ListRow key={option.id} option={option} onPick={onPick} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ConnectDataChooser({
  onPick,
  onExploreDemo,
}: {
  onPick: (action: ConnectAction) => void;
  onExploreDemo?: () => void;
}) {
  return (
    <>
      <div className="mb-7">
        <h1 className="m-0 text-[28px] font-semibold leading-[1.1] tracking-[-0.025em] text-fg">
          Connect your data
        </h1>
        <p className="m-0 mt-2.5 max-w-[540px] text-[14px] text-muted">
          Pick how Superlog should start seeing your telemetry. A no-code integration is the fastest
          way in — you can always add more sources later from settings.
        </p>
      </div>

      <div className="flex flex-col gap-7">
        {CONNECT_SECTIONS.map((section) => (
          <Section key={section.id} section={section} onPick={onPick} />
        ))}
      </div>

      <ExploreDemoLink onExploreDemo={onExploreDemo} />
    </>
  );
}
