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
- **Time Decay** — Logarithmic memory decay makes older memories harder to recall unless highly relevant. Formula: `final_score = similarity × 1/(1 + α × ln(1 + days)) × weight`. Configurable via `timeDecayAlpha` (default `0.09`, set `0` to disable). vault_notes are exempt from time decay.
- **Memory Pinning** — Mark important memories with `weight > 1.0` to boost their recall score, or suppress noisy ones with `weight = 0`. Applied to both `chat_messages` and `vault_notes`.
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
| `timeDecayAlpha` | number | `0.09` | Time decay factor (α). Higher = faster decay. `0` = disabled |
| `timeoutMs` | integer | `5000` | DB connection timeout |
| `throttleMs` | integer | `0` | Min interval between saves |

## How It Works

### Recall (before_agent_start)
1. Takes the user's prompt and generates an embedding via OpenRouter
2. Searches `chat_messages` (excluding `toolResult` role) and `vault_notes` using pgvector cosine similarity
3. Over-fetches 3x candidates when time decay is enabled (since decay may filter some out)
4. Applies time decay and weight to compute `final_score` for each result
5. Filters results where `final_score < minSimilarity`
6. Sorts by `final_score` descending, takes top N
7. Formats and injects into agent context via `prependContext`
8. Skips heartbeat messages entirely

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

## Time Decay

Older memories gradually become harder to recall unless they are highly semantically relevant. This prevents irrelevant old conversations from cluttering your context.

**Formula:** `final_score = cosine_similarity × 1/(1 + α × ln(1 + days_old)) × weight`

With the default `α = 0.09` and `minSimilarity = 0.5`:

| Cosine Similarity | Survives ~1 week? | Survives ~1 month? | Survives ~3 months? |
|---|---|---|---|
| 0.90 (near-identical) | ✅ 0.745 | ✅ 0.671 | ✅ 0.620 |
| 0.70 (same topic) | ✅ 0.590 | ✅ 0.536 | ❌ 0.497 |
| 0.60 (related) | ✅ 0.506 | ❌ 0.460 | ❌ 0.413 |
| 0.55 (loosely related) | ❌ 0.463 | ❌ 0.422 | ❌ 0.379 |

- **vault_notes are exempt** from time decay (notes are timeless reference material)
- Set `timeDecayAlpha: 0` to disable decay entirely

## Memory Pinning

You can boost or suppress individual memories by setting the `weight` column:

| Weight | Effect |
|--------|--------|
| `1.0` | Normal (default) |
| `2.0` | Pinned — score effectively doubled, resists time decay much longer |
| `0` | Suppressed — will never be recalled |

**Examples:**

```sql
-- Pin an important memory
UPDATE chat_messages SET weight = 2.0 WHERE id = 12345;

-- Suppress a noisy/irrelevant memory
UPDATE chat_messages SET weight = 0 WHERE id = 67890;

-- Reset to normal
UPDATE chat_messages SET weight = 1.0 WHERE id = 12345;

-- List all pinned memories
SELECT id, LEFT(content, 100), weight FROM chat_messages WHERE weight != 1.0;

-- Pin a vault note
UPDATE vault_notes SET weight = 2.0 WHERE path = 'important-note.md';
```

A pinned memory (weight=2.0) with cosine 0.60 at 90 days old:
- Normal: `0.60 × 0.689 = 0.413` ❌ below threshold
- Pinned: `0.60 × 0.689 × 2.0 = 0.827` ✅ easily recalled

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
- `weight` — Recall weight (default `1.0`). Set `2.0` to pin, `0` to suppress.

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
