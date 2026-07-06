DROP INDEX "issues_project_fingerprint_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "issues_project_fingerprint_idx" ON "issues" USING btree ("project_id","fingerprint");