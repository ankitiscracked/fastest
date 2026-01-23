-- Add workspace_id to snapshots table
-- This allows querying the latest snapshot for a specific workspace
ALTER TABLE `snapshots` ADD COLUMN `workspace_id` text REFERENCES workspaces(id);

-- Add index for efficient workspace snapshot queries
CREATE INDEX `idx_snapshots_workspace` ON `snapshots` (`workspace_id`, `created_at`);
