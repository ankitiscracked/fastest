-- Atlas core tables
CREATE TABLE IF NOT EXISTS atlas_concepts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  layer TEXT NOT NULL,
  type TEXT,
  description TEXT,
  source_snapshot_id TEXT REFERENCES snapshots(id) ON DELETE SET NULL,
  source_manifest_hash TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_atlas_concepts_project ON atlas_concepts(project_id, layer);
CREATE UNIQUE INDEX IF NOT EXISTS idx_atlas_concepts_unique ON atlas_concepts(project_id, id);

CREATE TABLE IF NOT EXISTS atlas_edges (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_concept_id TEXT NOT NULL,
  to_concept_id TEXT NOT NULL,
  type TEXT NOT NULL,
  weight INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_atlas_edges_from ON atlas_edges(project_id, from_concept_id);
CREATE INDEX IF NOT EXISTS idx_atlas_edges_to ON atlas_edges(project_id, to_concept_id);
CREATE INDEX IF NOT EXISTS idx_atlas_edges_type ON atlas_edges(project_id, type);

CREATE TABLE IF NOT EXISTS atlas_chunks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  concept_id TEXT,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  file_path TEXT,
  symbol TEXT,
  source_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_atlas_chunks_project ON atlas_chunks(project_id, kind);
CREATE INDEX IF NOT EXISTS idx_atlas_chunks_concept ON atlas_chunks(project_id, concept_id);

CREATE TABLE IF NOT EXISTS atlas_embeddings (
  id TEXT PRIMARY KEY,
  chunk_id TEXT NOT NULL REFERENCES atlas_chunks(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  vector TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_atlas_embeddings_chunk ON atlas_embeddings(chunk_id);

CREATE TABLE IF NOT EXISTS atlas_decision_links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  decision_id TEXT NOT NULL REFERENCES project_decisions(id) ON DELETE CASCADE,
  concept_id TEXT NOT NULL,
  confidence INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_atlas_decision_links_project ON atlas_decision_links(project_id, decision_id);
CREATE INDEX IF NOT EXISTS idx_atlas_decision_links_concept ON atlas_decision_links(project_id, concept_id);
