-- Add merge_history to workspaces table
-- Stores JSON: Record<workspaceId, { last_merged_snapshot: string, merged_at: string }>
-- Used to track merge history for proper three-way merge base selection
ALTER TABLE `workspaces` ADD COLUMN `merge_history` text;
