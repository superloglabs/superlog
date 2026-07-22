import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import {
  applyHomePulseLayoutBackfill,
  inspectHomePulseLayoutBackfill,
  parseHomePulseLayoutBackfillArgs,
} from "./home-pulse-layout-backfill.ts";

const DATABASE_URL = process.env.DATABASE_URL;

test("apply mode requires the previewed dashboard count", () => {
  assert.deepEqual(parseHomePulseLayoutBackfillArgs([]), { mode: "dry-run" });
  assert.deepEqual(parseHomePulseLayoutBackfillArgs(["--apply", "--expected-dashboards", "7"]), {
    mode: "apply",
    expectedDashboards: 7,
  });
  assert.throws(
    () => parseHomePulseLayoutBackfillArgs(["--apply"]),
    /--expected-dashboards is required/,
  );
});

test(
  "backfill puts the pulse row above existing home widgets",
  { skip: !DATABASE_URL },
  async () => {
    if (!DATABASE_URL) throw new Error("DATABASE_URL is required for this test");
    const sql = postgres(DATABASE_URL, { max: 1 });
    try {
      await sql`
			CREATE TEMP TABLE dashboards (
				id uuid PRIMARY KEY,
				is_home boolean NOT NULL,
				home_layout_version integer NOT NULL DEFAULT 0,
				updated_at timestamptz NOT NULL DEFAULT now()
			)
		`;
      await sql`
			CREATE TEMP TABLE dashboard_widgets (
				id text PRIMARY KEY DEFAULT md5(random()::text),
				dashboard_id uuid NOT NULL,
				type text NOT NULL,
				title text NOT NULL,
				config jsonb NOT NULL,
				layout jsonb NOT NULL,
				position integer NOT NULL DEFAULT 0,
				created_at timestamptz NOT NULL DEFAULT now(),
				updated_at timestamptz NOT NULL DEFAULT now()
			)
		`;

      await sql`
			INSERT INTO dashboards (id, is_home, home_layout_version) VALUES
				('00000000-0000-0000-0000-000000000001', true, 0),
				('00000000-0000-0000-0000-000000000002', true, 1)
		`;
      await sql`
			INSERT INTO dashboard_widgets
				(id, dashboard_id, type, title, config, layout, position)
			VALUES
				(
					'setup',
					'00000000-0000-0000-0000-000000000001',
					'setup_todos',
					'Setup',
					'{"filter": {}}',
					'{"x": 0, "y": 0, "w": 12, "h": 5}',
					0
				),
				(
					'signals',
					'00000000-0000-0000-0000-000000000001',
					'incoming_signals',
					'Incoming signals',
					'{"filter": {}}',
					'{"x": 7, "y": 12, "w": 8, "h": 8}',
					1
				),
				(
					'chart',
					'00000000-0000-0000-0000-000000000001',
					'timeseries_count',
					'Requests',
					'{"filter": {}}',
					'{"x": 0, "y": 3, "w": 6, "h": 4}',
					2
				),
				(
					'already-done',
					'00000000-0000-0000-0000-000000000002',
					'timeseries_count',
					'Custom',
					'{"filter": {}}',
					'{"x": 0, "y": 2, "w": 12, "h": 9}',
					0
				)
		`;

      const preview = await inspectHomePulseLayoutBackfill(sql);
      assert.deepEqual(preview, {
        dashboards: 1,
        insertedWidgets: 2,
        alignedWidgets: 1,
        shiftedWidgets: 1,
      });
      await assert.rejects(
        applyHomePulseLayoutBackfill(sql, { expectedDashboards: 2 }),
        /expected 2 legacy home dashboards, claimed 1; transaction rolled back/,
      );
      assert.deepEqual(await inspectHomePulseLayoutBackfill(sql), preview);

      const result = await applyHomePulseLayoutBackfill(sql, {
        expectedDashboards: 1,
      });

      assert.deepEqual(result, {
        dashboards: 1,
        insertedWidgets: 2,
        alignedWidgets: 1,
        shiftedWidgets: 1,
      });

      const legacyWidgets = await sql<
        Array<{
          type: string;
          layout: { x: number; y: number; w: number; h: number };
        }>
      >`
			SELECT type, layout
			FROM dashboard_widgets
			WHERE dashboard_id = '00000000-0000-0000-0000-000000000001'
			ORDER BY type
		`;
      assert.deepEqual(
        legacyWidgets.map((widget) => [widget.type, widget.layout]),
        [
          ["agent_pull_requests", { x: 8, y: 0, w: 4, h: 5 }],
          ["incident_count", { x: 4, y: 0, w: 4, h: 5 }],
          ["incoming_signals", { x: 0, y: 0, w: 4, h: 5 }],
          ["setup_todos", { x: 0, y: 0, w: 12, h: 5 }],
          ["timeseries_count", { x: 0, y: 8, w: 6, h: 4 }],
        ],
      );

      const untouched = await sql<
        Array<{ layout: { x: number; y: number; w: number; h: number } }>
      >`
			SELECT layout
			FROM dashboard_widgets
			WHERE id = 'already-done'
		`;
      assert.deepEqual(untouched[0]?.layout, { x: 0, y: 2, w: 12, h: 9 });

      assert.deepEqual(await inspectHomePulseLayoutBackfill(sql), {
        dashboards: 0,
        insertedWidgets: 0,
        alignedWidgets: 0,
        shiftedWidgets: 0,
      });
      assert.deepEqual(await applyHomePulseLayoutBackfill(sql, { expectedDashboards: 0 }), {
        dashboards: 0,
        insertedWidgets: 0,
        alignedWidgets: 0,
        shiftedWidgets: 0,
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  },
);
