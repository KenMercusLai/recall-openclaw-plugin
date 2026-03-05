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
│  Conversation → embedding → INSERT        │
│  PostgreSQL (chat_messages)               │
│  → stored for future recall               │
└───────────────────────────────────────────┘
```

**Recall**: Before each agent run, searches your database for relevant past conversations and notes using pgvector cosine similarity, then injects them into the prompt context.

**Store**: After each agent run, saves the conversation with embeddings for future retrieval.

## Installation

```bash
openclaw plugins install recall-openclaw-plugin@latest
```

### Configuration

In your OpenClaw config (`~/.openclaw/config.yaml` or equivalent):

```json
{
  "plugins": {
    "entries": {
      "recall-openclaw-plugin": { "enabled": true }
    }
  }
}
```

## Environment Variables

- `PGHOST` — PostgreSQL host (default: `server`)
- `PGPORT` — PostgreSQL port (default: `5432`)
- `PGUSER` — PostgreSQL user (default: `chloe`)
- `PGPASSWORD` — PostgreSQL password
- `PGDATABASE` — PostgreSQL database (default: `chloe`)
- `OPENROUTER_API_KEY` — Required for generating embeddings
- `EMBEDDING_MODEL` — Embedding model (default: `openai/text-embedding-3-small`)

### Plugin Config

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
| `recallEnabled` | boolean | `true` | Enable memory recall |
| `addEnabled` | boolean | `true` | Enable conversation saving |
| `captureStrategy` | string | `last_turn` | `last_turn` or `full_session` |
| `searchLimit` | integer | `10` | Max results per search |
| `timeoutMs` | integer | `5000` | DB connection timeout |
| `throttleMs` | integer | `0` | Min interval between saves |

## How It Works

### Recall (before_agent_start)
1. Takes the user's prompt and generates an embedding via OpenRouter
2. Searches `chat_messages` and `vault_notes` tables using pgvector cosine similarity
3. Formats the top results and injects them into the agent context via `prependContext`

### Store (agent_end)
1. After a successful agent run, extracts messages from the conversation
2. Inserts each message into `chat_messages` with timestamp and session info
3. Generates embeddings asynchronously and updates the records

## Requirements

- PostgreSQL with [pgvector](https://github.com/pgvector/pgvector) extension
- OpenRouter API key (for embeddings)
- OpenClaw

## License

Apache-2.0
