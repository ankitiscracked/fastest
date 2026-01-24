-- Add source_* drift fields and backfill from legacy main_* columns
ALTER TABLE `drift_reports` ADD COLUMN `source_workspace_id` text;
ALTER TABLE `drift_reports` ADD COLUMN `source_snapshot_id` text;
ALTER TABLE `drift_reports` ADD COLUMN `source_only` text NOT NULL DEFAULT '[]';

UPDATE `drift_reports`
SET
  source_workspace_id = COALESCE(source_workspace_id, main_workspace_id),
  source_snapshot_id = COALESCE(source_snapshot_id, main_snapshot_id),
  source_only = CASE
    WHEN source_only = '[]' THEN COALESCE(main_only, '[]')
    ELSE source_only
  END;
