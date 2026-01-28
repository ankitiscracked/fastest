ALTER TABLE build_suggestions ADD COLUMN helpful_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE build_suggestions ADD COLUMN not_helpful_count INTEGER NOT NULL DEFAULT 0;
