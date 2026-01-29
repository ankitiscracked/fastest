CREATE TABLE IF NOT EXISTS atlas_diagrams (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  concept_id TEXT,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_atlas_diagrams_project ON atlas_diagrams(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_atlas_diagrams_concept ON atlas_diagrams(project_id, concept_id);
