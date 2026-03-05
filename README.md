# Recall — Local-First Memory Plugin for OpenClaw

A lifecycle plugin that gives your OpenClaw agent **persistent memory** backed by your own PostgreSQL database. No cloud services, no third-party data storage — your conversations and knowledge stay on your machine.

## What It Does

```
User sends message
       │
       ▼
┌─ before_agent_start ─────────────────────┐
│  User prompt → embedding → vector search  │
│  PostgreSQL (chat_messages + vault_notes)  │
│  → relevant memories injected into context │
└───────────────────────────────────────────┘
       │
       ▼
   Agent runs (with memory context)
       │
       ▼
┌─ agent_end ──────────────────────────────┐
│  Conversation → clean + embedding → INSERT│
│  content (clean) + raw_content (original) │
│  → stored for future recall               │
└───────────────────────────────────────────┘
```

## Features

- **Semantic Search** — Uses pgvector cosine similarity to find relevant past conversations and notes, not just keyword matching
- **Content Cleaning** — Automatically strips OpenClaw envelope metadata (conversation info, sender info, media attachments, reply tags, recall injection) before storing and embedding, so search results are based on actual message content
- **Dual Storage** — `content` stores cleaned text (for search), `raw_content` preserves the original (for reference)
- **Heartbeat Filtering** — Skips heartbeat poll messages in both recall and store to avoid noise
- **toolResult Exclusion** — Backend tool execution outputs are stored but excluded from recall search
- **Similarity Threshold** — Configurable minimum cosine similarity (default `0.5`) filters out low-relevance results
- **Accurate Timestamps** — Uses the message's original timestamp from metadata, not insertion time
- **Deduplication** — Unique index on `(session_id, md5(content), date_trunc('second', timestamp))` prevents duplicate entries
- **Session Tracking** — Records both `session_id` (UUID) and `session_label` (human-readable key like `agent:main:telegram:direct:12345`)
- **Rich Metadata** — Stores model, usage, provider, tool info, and other message metadata as JSONB

## Installation

```bash
# From npm (when published)
openclaw plugins install recall-openclaw-plugin@latest

# From local path
# In your OpenClaw config, set the plugin load path:
# "load": { "recall-openclaw-plugin": "/path/to/recall-openclaw-plugin" }
```

### Configuration

In your OpenClaw config (`~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "allow": ["recall-openclaw-plugin"],
    "load": {
      "recall-openclaw-plugin": "/path/to/recall-openclaw-plugin"
    },
    "entries": {
      "recall-openclaw-plugin": { "enabled": true }
    }
  }
}
```

## Plugin Config

In `plugins.entries.recall-openclaw-plugin.config`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `pgHost` | string | env `PGHOST` or `server` | PostgreSQL host |
| `pgPort` | integer | env `PGPORT` or `5432` | PostgreSQL port |
| `pgUser` | string | env `PGUSER` or `chloe` | PostgreSQL user |
| `pgPassword` | string | env `PGPASSWORD` | PostgreSQL password |
| `pgDatabase` | string | env `PGDATABASE` or `chloe` | PostgreSQL database |
| `openrouterApiKey` | string | env `OPENROUTER_API_KEY` | API key for embeddings |
| `embeddingModel` | string | `openai/text-embedding-3-small` | Embedding model |
| `recallEnabled` | boolean | `true` | Enable memory recall on agent start |
| `addEnabled` | boolean | `true` | Enable conversation saving on agent end |
| `captureStrategy` | string | `last_turn` | `last_turn` or `full_session` |
| `searchLimit` | integer | `10` | Max results per search (split between conversations and notes) |
| `minSimilarity` | number | `0.5` | Minimum cosine similarity threshold (0–1). Results below this are discarded |
| `timeoutMs` | integer | `5000` | DB connection timeout |
| `throttleMs` | integer | `0` | Min interval between saves |

## How It Works

### Recall (before_agent_start)
1. Takes the user's prompt and generates an embedding via OpenRouter
2. Searches `chat_messages` (excluding `toolResult` role) and `vault_notes` using pgvector cosine similarity
3. Filters results below `minSimilarity` threshold
4. Formats the top results and injects them into the agent context via `prependContext`
5. Skips heartbeat messages entirely

### Store (agent_end)
1. After a successful agent run, extracts messages from the conversation
2. **Cleans each message** — strips envelope metadata, media attachment blocks, reply tags, and recall injection blocks
3. Stores both `content` (cleaned, used for embedding) and `raw_content` (original, for reference)
4. Uses the message's original timestamp from metadata (falls back to `NOW()` if unavailable)
5. Generates embeddings from cleaned content asynchronously
6. Skips heartbeat messages entirely

### Content Cleaning (stripEnvelope)

The following patterns are automatically removed from `content` before storage and embedding:

- `## Relevant memories from past conversations and notes:` blocks (recall's own injection)
- `Conversation info (untrusted metadata):` JSON blocks
- `Sender (untrusted metadata):` JSON blocks
- `[media attached: ...]` blocks
- `To send an image back...` instruction lines
- `[image data removed - already processed by model]` markers
- `Replied message (untrusted, for context):` JSON blocks
- `[[reply_to_current]]` and `[[reply_to:<id>]]` tags
- Multiple consecutive blank lines (collapsed to one)

## Database Setup

The plugin requires two tables in PostgreSQL with the [pgvecto.rs](https://github.com/tensorchord/pgvecto.rs) vector extension.

1. Install the vector extension:

```sql
CREATE EXTENSION IF NOT EXISTS vectors;
```

2. Create the tables using the provided SQL files:

```bash
psql -h your-host -U your-user -d your-db -f sql/chat_messages.sql
psql -h your-host -U your-user -d your-db -f sql/vault_notes.sql
```

### chat_messages

Stores conversation history. The plugin writes here automatically on every agent run.

Key columns:
- `content` — Cleaned message text (envelope metadata stripped)
- `raw_content` — Original unmodified message text
- `role` — `user`, `assistant`, or `toolResult`
- `embedding` — `vector(1536)` for cosine similarity search
- `session_id` — UUID matching OpenClaw session
- `session_label` — Human-readable session key (e.g. `agent:main:telegram:direct:12345`)
- `timestamp` — Original message timestamp
- `metadata` — JSONB with model, usage, provider, tool info, etc.

See [`sql/chat_messages.sql`](sql/chat_messages.sql) for the full schema.

### vault_notes

Stores your knowledge base (e.g. Obsidian vault notes). You populate this yourself via a sync script or similar.

See [`sql/vault_notes.sql`](sql/vault_notes.sql) for the full schema.

## Requirements

- PostgreSQL with [pgvecto.rs](https://github.com/tensorchord/pgvecto.rs) extension
- OpenRouter API key (for embeddings)
- OpenClaw

## License

Apache-2.0
