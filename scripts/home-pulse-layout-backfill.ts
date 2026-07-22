import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

export type HomePulseLayoutBackfillArgs =
  | { mode: "dry-run" }
  | { mode: "apply"; expectedDashboards: number };

export function parseHomePulseLayoutBackfillArgs(argv: string[]): HomePulseLayoutBackfillArgs {
  let apply = false;
  let explicitDryRun = false;
  let expectedDashboards: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--dry-run") {
      explicitDryRun = true;
      continue;
    }
    if (arg === "--expected-dashboards") {
      const raw = argv[index + 1];
      const parsed = Number(raw);
      if (!raw || !Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`invalid --expected-dashboards value: ${raw ?? "(missing)"}`);
      }
      expectedDashboards = parsed;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (apply && explicitDryRun) throw new Error("choose either --apply or --dry-run");
  if (!apply) return { mode: "dry-run" };
  if (expectedDashboards === undefined) {
    throw new Error("--expected-dashboards is required with --apply");
  }
  return { mode: "apply", expectedDashboards };
}

export type HomePulseLayoutBackfillResult = {
  dashboards: number;
  insertedWidgets: number;
  alignedWidgets: number;
  shiftedWidgets: number;
};

export async function inspectHomePulseLayoutBackfill(
  sql: postgres.Sql,
): Promise<HomePulseLayoutBackfillResult> {
  const [counts] = await sql<
    Array<{
      dashboards: number;
      inserted_widgets: number;
      aligned_widgets: number;
      shifted_widgets: number;
    }>
  >`
		WITH target_dashboards AS (
			SELECT id
			FROM dashboards
			WHERE is_home = true AND home_layout_version < 1
		),
		desired_widgets(type) AS (
			VALUES ('incoming_signals'), ('incident_count'), ('agent_pull_requests')
		)
		SELECT
			(SELECT COUNT(*)::integer FROM target_dashboards) AS dashboards,
			(
				SELECT COUNT(*)::integer
				FROM target_dashboards target
				CROSS JOIN desired_widgets desired
				WHERE NOT EXISTS (
					SELECT 1
					FROM dashboard_widgets widget
					WHERE widget.dashboard_id = target.id AND widget.type = desired.type
				)
			) AS inserted_widgets,
			(
				SELECT COUNT(*)::integer
				FROM dashboard_widgets widget
				JOIN target_dashboards target ON target.id = widget.dashboard_id
				WHERE widget.type IN ('incoming_signals', 'incident_count', 'agent_pull_requests')
			) AS aligned_widgets,
			(
				SELECT COUNT(*)::integer
				FROM dashboard_widgets widget
				JOIN target_dashboards target ON target.id = widget.dashboard_id
				WHERE widget.type NOT IN (
					'setup_todos',
					'incoming_signals',
					'incident_count',
					'agent_pull_requests'
				)
			) AS shifted_widgets
	`;

  if (!counts) throw new Error("failed to inspect legacy home dashboards");
  return {
    dashboards: counts.dashboards,
    insertedWidgets: counts.inserted_widgets,
    alignedWidgets: counts.aligned_widgets,
    shiftedWidgets: counts.shifted_widgets,
  };
}

export async function applyHomePulseLayoutBackfill(
  sql: postgres.Sql,
  options: { expectedDashboards: number },
): Promise<HomePulseLayoutBackfillResult> {
  return sql.begin(async (tx) => {
    const claimed = await tx<Array<{ id: string }>>`
			UPDATE dashboards
			SET home_layout_version = 1, updated_at = now()
			WHERE is_home = true AND home_layout_version < 1
			RETURNING id::text AS id
		`;

    if (claimed.length !== options.expectedDashboards) {
      throw new Error(
        `expected ${options.expectedDashboards} legacy home dashboards, claimed ${claimed.length}; transaction rolled back`,
      );
    }

    if (claimed.length === 0) {
      return {
        dashboards: 0,
        insertedWidgets: 0,
        alignedWidgets: 0,
        shiftedWidgets: 0,
      };
    }

    const dashboardIds = claimed.map((dashboard) => dashboard.id);
    const shifted = await tx`
			UPDATE dashboard_widgets
			SET
				layout = jsonb_set(
					layout,
					'{y}',
					to_jsonb(LEAST(100000, COALESCE((layout ->> 'y')::integer, 0) + 5)),
					true
				),
				updated_at = now()
			WHERE dashboard_id = ANY(${dashboardIds}::uuid[])
				AND type NOT IN (
					'setup_todos',
					'incoming_signals',
					'incident_count',
					'agent_pull_requests'
				)
			RETURNING id
		`;

    const aligned = await tx`
			UPDATE dashboard_widgets
			SET
				layout = CASE type
					WHEN 'incoming_signals' THEN '{"x": 0, "y": 0, "w": 4, "h": 5}'::jsonb
					WHEN 'incident_count' THEN '{"x": 4, "y": 0, "w": 4, "h": 5}'::jsonb
					WHEN 'agent_pull_requests' THEN '{"x": 8, "y": 0, "w": 4, "h": 5}'::jsonb
				END,
				updated_at = now()
			WHERE dashboard_id = ANY(${dashboardIds}::uuid[])
				AND type IN ('incoming_signals', 'incident_count', 'agent_pull_requests')
			RETURNING id
		`;

    const inserted = await tx`
			WITH target_dashboards AS (
				SELECT unnest(${dashboardIds}::uuid[]) AS dashboard_id
			),
			desired_widgets(type, title, layout, sort_order) AS (
				VALUES
					('incoming_signals', 'Incoming signals', '{"x": 0, "y": 0, "w": 4, "h": 5}'::jsonb, 0),
					('incident_count', 'Active incidents', '{"x": 4, "y": 0, "w": 4, "h": 5}'::jsonb, 1),
					('agent_pull_requests', 'PRs opened by Superlog', '{"x": 8, "y": 0, "w": 4, "h": 5}'::jsonb, 2)
			),
			missing_widgets AS (
				SELECT target.dashboard_id, desired.*
				FROM target_dashboards target
				CROSS JOIN desired_widgets desired
				WHERE NOT EXISTS (
					SELECT 1
					FROM dashboard_widgets existing
					WHERE existing.dashboard_id = target.dashboard_id
						AND existing.type = desired.type
				)
			),
			positioned_widgets AS (
				SELECT
					missing.*,
					(
						COALESCE((
							SELECT MAX(existing.position)
							FROM dashboard_widgets existing
							WHERE existing.dashboard_id = missing.dashboard_id
						), -1) + ROW_NUMBER() OVER (
							PARTITION BY missing.dashboard_id
							ORDER BY missing.sort_order
						)
					)::integer AS position
				FROM missing_widgets missing
			)
			INSERT INTO dashboard_widgets (dashboard_id, type, title, config, layout, position)
			SELECT dashboard_id, type, title, '{"filter": {}}'::jsonb, layout, position
			FROM positioned_widgets
			RETURNING id
		`;

    return {
      dashboards: claimed.length,
      insertedWidgets: inserted.length,
      alignedWidgets: aligned.length,
      shiftedWidgets: shifted.length,
    };
  });
}

async function main(): Promise<void> {
  const args = parseHomePulseLayoutBackfillArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const preview = await inspectHomePulseLayoutBackfill(sql);
    process.stdout.write(`${JSON.stringify({ mode: args.mode, ...preview }, null, 2)}\n`);
    if (args.mode === "dry-run") return;

    const result = await applyHomePulseLayoutBackfill(sql, {
      expectedDashboards: args.expectedDashboards,
    });
    process.stdout.write(`${JSON.stringify({ mode: "applied", ...result }, null, 2)}\n`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const entrypoint = process.argv[1];
if (entrypoint && fileURLToPath(import.meta.url) === path.resolve(entrypoint)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
