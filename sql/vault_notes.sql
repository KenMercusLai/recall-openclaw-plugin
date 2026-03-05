-- Recall: vault_notes table
-- Stores Obsidian vault notes with vector embeddings for semantic search.
-- Used by the recall hook to find relevant notes from your knowledge base.
--
-- Prerequisites:
--   CREATE EXTENSION IF NOT EXISTS vectors;  -- pgvecto.rs for vector similarity search

CREATE TABLE IF NOT EXISTS vault_notes (
    id               SERIAL PRIMARY KEY,
    path             TEXT NOT NULL UNIQUE,       -- vault-relative file path (e.g. "02. Zettelkasten/My Note.md")
    title            TEXT,                        -- note title (usually filename without .md)
    content          TEXT,                        -- full note content
    tags             TEXT[],                      -- frontmatter tags
    file_modified_at TIMESTAMP,                  -- file mtime from filesystem
    synced_at        TIMESTAMP DEFAULT now(),    -- last sync timestamp
    content_tsv      TSVECTOR GENERATED ALWAYS AS (
        to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(content, ''))
    ) STORED,
    embedding        vector(1536)                -- text-embedding-3-small output dimension
);

-- Vector similarity search (cosine distance)
CREATE INDEX IF NOT EXISTS idx_vault_notes_embedding
    ON vault_notes USING vectors (embedding vector_cos_ops);

-- Full-text search
CREATE INDEX IF NOT EXISTS idx_vault_notes_tsv
    ON vault_notes USING gin (content_tsv);

-- Lookup indexes
CREATE INDEX IF NOT EXISTS idx_vault_notes_path ON vault_notes (path);
CREATE INDEX IF NOT EXISTS idx_vault_notes_tags ON vault_notes USING gin (tags);
