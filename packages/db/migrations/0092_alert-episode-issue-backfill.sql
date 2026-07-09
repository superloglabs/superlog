-- Backfill the episode-as-issue model over historical alert data.
--
-- Before this migration, one long-lived issue per alert+group (fingerprint
-- 'alert:<alertId>[:<groupKey>]') accumulated every breach, and alert_episodes
-- rows (added in 0073, written best-effort) pointed at that aggregate issue.
-- After it, every episode has its own 1:1 issue (fingerprint
-- 'alert-episode:<episodeId>') and incident links go through those issues.
--
-- Ordering: this backfill runs BEFORE 0093 creates the unique index on
-- alert_episodes.issue_id — historical episodes of the same alert+group all
-- share the aggregate issue's id, so creating the index first would fail on
-- any deployment with real alert history.
--
-- Steps:
--   1. Synthesize a (closed) episode for every incident that was driven by an
--      aggregate alert issue but has no episode row (pre-0073 breaches or
--      missed best-effort writes). Window comes from the incident, observed
--      value is parsed from the issue title's "observed=N", falling back to
--      the alert threshold. Synthetic rows are always 'resolved' so they can
--      never collide with the evaluator's open-row unique index.
--   2. Create the per-episode issue for every episode that doesn't have one.
--   3. Point each episode at its per-episode issue.
--   4. Link each episode's issue to the episode's incident.
--   5. Drop the old aggregate links on incidents that now carry episode links,
--      and recompute those incidents' issue_count.
--   6. Delete aggregate alert issues that no longer drive any incident.
--      Aggregate issues whose alert was deleted (nothing to synthesize
--      against) keep their links and survive as legacy rows.

-- 1. Synthetic episodes for episode-less alert incidents.
INSERT INTO alert_episodes (
  alert_id, project_id, group_key, state, started_at, ended_at,
  open_observed_value, peak_observed_value, last_observed_value,
  last_firing_at, issue_id, incident_id
)
SELECT
  a.id,
  i.project_id,
  CASE WHEN length(i.fingerprint) >= 44 THEN substring(i.fingerprint from 44) ELSE '' END,
  'resolved',
  inc.first_seen,
  inc.last_seen,
  COALESCE(substring(i.title from 'observed=([0-9.]+)')::double precision, a.threshold),
  COALESCE(substring(i.title from 'observed=([0-9.]+)')::double precision, a.threshold),
  COALESCE(substring(i.title from 'observed=([0-9.]+)')::double precision, a.threshold),
  inc.last_seen,
  NULL,
  inc.id
FROM incident_issues l
JOIN issues i ON i.id = l.issue_id AND i.kind = 'alert' AND i.fingerprint LIKE 'alert:%'
JOIN incidents inc ON inc.id = l.incident_id
JOIN alerts a ON a.id = NULLIF(substring(i.fingerprint from '^alert:([0-9a-f-]{36})'), '')::uuid
WHERE NOT EXISTS (
  SELECT 1 FROM alert_episodes e WHERE e.incident_id = l.incident_id
);
--> statement-breakpoint

-- 2. Per-episode issues for every episode still pointing at an aggregate
--    issue (or at nothing). Status mirrors the driving incident when known.
INSERT INTO issues (
  project_id, fingerprint, kind, service, exception_type, title, message,
  top_frame, normalized_frames, last_sample, first_seen, last_seen,
  event_count, status
)
SELECT
  e.project_id,
  'alert-episode:' || e.id::text,
  'alert',
  old.service,
  'AlertFired',
  COALESCE(
    old.title,
    a.name || CASE WHEN a.comparator = 'gt' THEN ' > ' ELSE ' < ' END || a.threshold
      || ' (observed=' || e.peak_observed_value || ')'
      || CASE WHEN e.group_key <> '' THEN ' group=' || e.group_key ELSE '' END
  ),
  COALESCE(
    old.message,
    old.title,
    a.name || CASE WHEN a.comparator = 'gt' THEN ' > ' ELSE ' < ' END || a.threshold
      || ' (observed=' || e.peak_observed_value || ')'
      || CASE WHEN e.group_key <> '' THEN ' group=' || e.group_key ELSE '' END
  ),
  NULL,
  '[]'::jsonb,
  old.last_sample,
  e.started_at,
  COALESCE(e.ended_at, e.last_firing_at),
  GREATEST(
    1,
    ceil(
      extract(epoch from (COALESCE(e.ended_at, e.last_firing_at) - e.started_at))
        / GREATEST(COALESCE(a.evaluation_interval_seconds, 60), 1)
    )::bigint
  ),
  CASE
    WHEN inc.status = 'open' THEN 'open'
    WHEN inc.status IS NOT NULL THEN 'resolved'
    WHEN e.state = 'firing' THEN 'open'
    ELSE 'resolved'
  END
FROM alert_episodes e
LEFT JOIN issues old ON old.id = e.issue_id
LEFT JOIN alerts a ON a.id = e.alert_id
LEFT JOIN incidents inc ON inc.id = e.incident_id
WHERE (e.issue_id IS NULL OR old.fingerprint NOT LIKE 'alert-episode:%')
ON CONFLICT (project_id, fingerprint) DO NOTHING;
--> statement-breakpoint

-- 3. Point each episode at its per-episode issue.
UPDATE alert_episodes e
SET issue_id = i.id, updated_at = now()
FROM issues i
WHERE i.project_id = e.project_id
  AND i.fingerprint = 'alert-episode:' || e.id::text
  AND e.issue_id IS DISTINCT FROM i.id;
--> statement-breakpoint

-- 4. Link episode issues to their incidents.
INSERT INTO incident_issues (incident_id, issue_id)
SELECT e.incident_id, e.issue_id
FROM alert_episodes e
WHERE e.incident_id IS NOT NULL AND e.issue_id IS NOT NULL
ON CONFLICT (incident_id, issue_id) DO NOTHING;
--> statement-breakpoint

-- 5a. Drop aggregate links replaced by episode links.
DELETE FROM incident_issues l
USING issues old
WHERE old.id = l.issue_id
  AND old.kind = 'alert'
  AND old.fingerprint LIKE 'alert:%'
  AND EXISTS (
    SELECT 1 FROM alert_episodes e
    WHERE e.incident_id = l.incident_id
      AND e.issue_id IS NOT NULL
      AND e.issue_id <> old.id
  );
--> statement-breakpoint

-- 5b. Recompute issue_count on incidents whose links were rewritten.
UPDATE incidents inc
SET issue_count = sub.n
FROM (
  SELECT l.incident_id, count(*) AS n
  FROM incident_issues l
  GROUP BY l.incident_id
) sub
WHERE inc.id = sub.incident_id
  AND inc.issue_count <> sub.n
  AND EXISTS (
    SELECT 1
    FROM incident_issues l2
    JOIN issues i2 ON i2.id = l2.issue_id
    WHERE l2.incident_id = inc.id AND i2.kind = 'alert'
  );
--> statement-breakpoint

-- 6. Delete aggregate alert issues that no longer drive any incident.
DELETE FROM issues i
WHERE i.kind = 'alert'
  AND i.fingerprint LIKE 'alert:%'
  AND NOT EXISTS (SELECT 1 FROM incident_issues l WHERE l.issue_id = i.id);
