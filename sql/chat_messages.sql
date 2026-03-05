-- Recall: chat_messages table
-- Stores conversation history with vector embeddings for semantic search.
--
-- Prerequisites:
--   CREATE EXTENSION IF NOT EXISTS vectors;  -- pgvecto.rs for vector similarity search

CREATE TABLE IF NOT EXISTS chat_messages (
    id            BIGSERIAL PRIMARY KEY,
    session_id    TEXT NOT NULL,
    session_label TEXT,
    message_id    TEXT,
    "timestamp"   TIMESTAMPTZ NOT NULL,
    role          TEXT NOT NULL,            -- 'user' | 'assistant' | 'system'
    content       TEXT NOT NULL,
    metadata      JSONB DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ DEFAULT now(),
    content_tsv   TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
    embedding     vector(1536)             -- text-embedding-3-small output dimension
);

-- Deduplication: prevent identical messages in same session within the same second
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_dedup
    ON chat_messages (session_id, md5(content), date_trunc('second', "timestamp" AT TIME ZONE 'UTC'));

-- Unique message_id (if provided by the agent framework)
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_message_id
    ON chat_messages (message_id);

-- Vector similarity search (cosine distance)
CREATE INDEX IF NOT EXISTS idx_chat_messages_embedding
    ON chat_messages USING vectors (embedding vector_cos_ops);

-- Full-text search
CREATE INDEX IF NOT EXISTS idx_chat_messages_fts
    ON chat_messages USING gin (content_tsv);

-- Lookup indexes
CREATE INDEX IF NOT EXISTS idx_chat_messages_session       ON chat_messages (session_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_label ON chat_messages (session_label);
CREATE INDEX IF NOT EXISTS idx_chat_messages_role          ON chat_messages (role);
CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp     ON chat_messages ("timestamp");
