-- Add summary field to snapshots table for LLM-generated descriptions
ALTER TABLE `snapshots` ADD COLUMN `summary` text;
