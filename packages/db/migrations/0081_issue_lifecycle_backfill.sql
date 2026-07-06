-- Custom data migration (drizzle-kit generate --custom): backfill the new
-- issue lifecycle state and retire the incident 'autoresolved_noise' status.
--
-- Order matters:
--   1. Backfill issues.status while 'autoresolved_noise' incidents are still
--      distinguishable from plain 'resolved' ones.
--   2. Collapse duplicate (project_id, fingerprint) issue rows — the old
--      partial unique index (WHERE silenced_at IS NULL) let a silenced
--      fingerprint spawn a fresh row on recurrence. The follow-up migration
--      adds a full unique index, which requires this dedupe to have run.
--   3. Convert 'autoresolved_noise' incidents to 'resolved' with resolution
--      metadata derived from their noise columns.

-- 1a. Manually-silenced issues.
UPDATE issues SET status = 'silenced' WHERE silenced_at IS NOT NULL;--> statement-breakpoint

-- 1b. Issues linked to noise-closed incidents are silenced (the new model for
-- noise verdicts). Stamp silenced_at from the incident so the UI can date it.
UPDATE issues i
SET status = 'silenced',
    silenced_at = COALESCE(inc.noise_resolved_at, inc.updated_at)
FROM incident_issues ii
JOIN incidents inc ON inc.id = ii.incident_id
WHERE ii.issue_id = i.id
  AND inc.status = 'autoresolved_noise'
  AND i.silenced_at IS NULL;--> statement-breakpoint

-- 1c. Issues linked to resolved incidents are resolved.
UPDATE issues i
SET status = 'resolved'
FROM incident_issues ii
JOIN incidents inc ON inc.id = ii.incident_id
WHERE ii.issue_id = i.id
  AND inc.status = 'resolved'
  AND i.status = 'open';--> statement-breakpoint

-- 2a. Dedupe: fold loser counters into the survivor. Survivor = the active
-- (non-silenced) row if one exists — the old partial index guaranteed at most
-- one — otherwise the most recently seen row.
WITH ranked AS (
  SELECT id, project_id, fingerprint,
         row_number() OVER (
           PARTITION BY project_id, fingerprint
           ORDER BY (silenced_at IS NULL) DESC, last_seen DESC, created_at DESC
         ) AS rn
  FROM issues
),
losses AS (
  SELECT s.id AS survivor_id,
         sum(l.ec) AS extra_events,
         min(l.fs) AS min_first_seen,
         max(l.ls) AS max_last_seen
  FROM (SELECT r.id, r.project_id, r.fingerprint, i.event_count AS ec,
               i.first_seen AS fs, i.last_seen AS ls
        FROM ranked r JOIN issues i ON i.id = r.id WHERE r.rn > 1) l
  JOIN ranked s
    ON s.project_id = l.project_id AND s.fingerprint = l.fingerprint AND s.rn = 1
  GROUP BY s.id
)
UPDATE issues i
SET event_count = i.event_count + losses.extra_events,
    first_seen = LEAST(i.first_seen, losses.min_first_seen),
    last_seen = GREATEST(i.last_seen, losses.max_last_seen)
FROM losses
WHERE i.id = losses.survivor_id;--> statement-breakpoint

-- 2b. If multiple loser issue rows from the same duplicate group are linked to
-- the same incident, they would all update to the same (incident_id, survivor)
-- pair and violate incident_issues_pair_idx. Keep one link for that target; the
-- rest are redundant because the loser issue rows are about to be deleted.
WITH ranked AS (
  SELECT id, project_id, fingerprint,
         row_number() OVER (
           PARTITION BY project_id, fingerprint
           ORDER BY (silenced_at IS NULL) DESC, last_seen DESC, created_at DESC
         ) AS rn
  FROM issues
),
pairs AS (
  SELECT l.id AS loser_id, s.id AS survivor_id
  FROM ranked l
  JOIN ranked s
    ON s.project_id = l.project_id AND s.fingerprint = l.fingerprint AND s.rn = 1
  WHERE l.rn > 1
),
ranked_links AS (
  SELECT ii.id,
         row_number() OVER (
           PARTITION BY ii.incident_id, p.survivor_id
           ORDER BY ii.created_at DESC, ii.id DESC
         ) AS rn
  FROM incident_issues ii
  JOIN pairs p ON p.loser_id = ii.issue_id
)
DELETE FROM incident_issues
WHERE id IN (SELECT id FROM ranked_links WHERE rn > 1);--> statement-breakpoint

-- 2c. Repoint loser incident links to the survivor so incident history keeps
-- an issue row, skipping incidents already linked to the survivor.
WITH ranked AS (
  SELECT id, project_id, fingerprint,
         row_number() OVER (
           PARTITION BY project_id, fingerprint
           ORDER BY (silenced_at IS NULL) DESC, last_seen DESC, created_at DESC
         ) AS rn
  FROM issues
),
pairs AS (
  SELECT l.id AS loser_id, s.id AS survivor_id
  FROM ranked l
  JOIN ranked s
    ON s.project_id = l.project_id AND s.fingerprint = l.fingerprint AND s.rn = 1
  WHERE l.rn > 1
)
UPDATE incident_issues ii
SET issue_id = p.survivor_id
FROM pairs p
WHERE ii.issue_id = p.loser_id
  AND NOT EXISTS (
    SELECT 1 FROM incident_issues x
    WHERE x.incident_id = ii.incident_id AND x.issue_id = p.survivor_id
  );--> statement-breakpoint

-- 2d. Delete loser rows (cascades any incident_issues links that could not be
-- repointed because the survivor already covered that incident).
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY project_id, fingerprint
           ORDER BY (silenced_at IS NULL) DESC, last_seen DESC, created_at DESC
         ) AS rn
  FROM issues
)
DELETE FROM issues WHERE id IN (SELECT id FROM ranked WHERE rn > 1);--> statement-breakpoint

-- 3. Retire 'autoresolved_noise': convert to plain 'resolved' with resolution
-- metadata carried over from the noise columns (which stay as the record of
-- the original verdict).
UPDATE incidents
SET status = 'resolved',
    resolved_at = COALESCE(noise_resolved_at, updated_at, now()),
    resolved_by_kind = 'agent_classification',
    resolved_reason_code = COALESCE(noise_reason, 'noise'),
    resolved_reason_text = COALESCE(resolved_reason_text, noise_classification->>'evidence'),
    updated_at = now()
WHERE status = 'autoresolved_noise';
