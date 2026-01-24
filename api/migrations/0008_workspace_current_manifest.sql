-- Add current_manifest_hash to workspaces
ALTER TABLE `workspaces` ADD COLUMN `current_manifest_hash` text;

-- Expand drift_reports to store full drift detail
ALTER TABLE `drift_reports` ADD COLUMN `main_workspace_id` text;
ALTER TABLE `drift_reports` ADD COLUMN `workspace_snapshot_id` text;
ALTER TABLE `drift_reports` ADD COLUMN `main_snapshot_id` text;
ALTER TABLE `drift_reports` ADD COLUMN `main_only` text NOT NULL DEFAULT '[]';
ALTER TABLE `drift_reports` ADD COLUMN `workspace_only` text NOT NULL DEFAULT '[]';
ALTER TABLE `drift_reports` ADD COLUMN `both_same` text NOT NULL DEFAULT '[]';
ALTER TABLE `drift_reports` ADD COLUMN `both_different` text NOT NULL DEFAULT '[]';
