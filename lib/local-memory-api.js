import { createRequire } from "node:module";

// Resolve pg from local node_modules or workspace
let pg;
const _require = createRequire(import.meta.url);
try {
  pg = _require("pg");
} catch {
  const wsRequire = createRequire(
    new URL("file://" + process.env.HOME + "/.openclaw/workspace/package.json"),
  );
  pg = wsRequire("pg");
}

const { Pool } = pg.default ?? pg;

let pool = null;

/**
 * Get or create connection pool.
 */
export function getPool(cfg) {
  if (pool) return pool;
  pool = new Pool({
    host: cfg.pgHost,
    port: cfg.pgPort,
    user: cfg.pgUser,
    password: cfg.pgPassword,
    database: cfg.pgDatabase,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: cfg.timeoutMs || 5000,
  });
  pool.on("error", (err) => {
    console.warn("[recall] Pool error:", err.message);
  });
  return pool;
}

/**
 * Test DB connectivity.
 */
export async function testConnection(cfg) {
  const p = getPool(cfg);
  const client = await p.connect();
  try {
    await client.query("SELECT 1");
  } finally {
    client.release();
  }
}

/**
 * Generate embedding via OpenRouter.
 */
export async function generateEmbedding(cfg, text) {
  if (!text || !cfg.openrouterApiKey) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), cfg.timeoutMs || 10000);

  try {
    const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.openrouterApiKey}`,
      },
      body: JSON.stringify({
        model: cfg.embeddingModel || "openai/text-embedding-3-small",
        input: text.slice(0, 8000), // limit input length
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`Embedding API HTTP ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    return data?.data?.[0]?.embedding ?? null;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

/**
 * Search memories from chat_messages and vault_notes using pgvector cosine similarity.
 * Returns { conversations: [...], notes: [...] }
 */
export async function searchMemory(cfg, payload) {
  const { query, limit = 10 } = payload;
  if (!query) return { conversations: [], notes: [] };

  // Generate embedding for query
  const embedding = await generateEmbedding(cfg, query);
  if (!embedding) return { conversations: [], notes: [] };

  const p = getPool(cfg);
  const embeddingStr = `[${embedding.join(",")}]`;
  const halfLimit = Math.ceil(limit / 2);
  const minSimilarity = cfg.minSimilarity ?? 0.6;

  // Search chat_messages and vault_notes in parallel
  const [chatResult, notesResult] = await Promise.all([
    p.query(
      `SELECT id, content, role, session_id, timestamp,
              1 - (embedding <=> $1::vector) AS similarity
       FROM chat_messages
       WHERE embedding IS NOT NULL
         AND 1 - (embedding <=> $1::vector) >= $3
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [embeddingStr, halfLimit, minSimilarity],
    ),
    p.query(
      `SELECT id, path, title, content, tags, file_modified_at,
              1 - (embedding <=> $1::vector) AS similarity
       FROM vault_notes
       WHERE embedding IS NOT NULL
         AND 1 - (embedding <=> $1::vector) >= $3
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [embeddingStr, halfLimit, minSimilarity],
    ),
  ]);

  return {
    conversations: chatResult.rows.map((r) => ({
      id: r.id,
      content: r.content,
      role: r.role,
      sessionId: r.session_id,
      timestamp: r.timestamp,
      similarity: parseFloat(r.similarity),
    })),
    notes: notesResult.rows.map((r) => ({
      id: r.id,
      path: r.path,
      title: r.title,
      content: r.content,
      tags: r.tags,
      fileModifiedAt: r.file_modified_at,
      similarity: parseFloat(r.similarity),
    })),
  };
}

/**
 * Add a message to chat_messages and generate its embedding.
 */
export async function addMessage(cfg, payload) {
  const { sessionId, sessionLabel = null, role, content, metadata = {} } = payload;
  if (!content) return;

  const p = getPool(cfg);
  const metadataJson = JSON.stringify(metadata);

  // Clean content: strip envelope metadata, keep only actual message
  const cleanContent = stripEnvelope(content);

  // Use the message's own timestamp if available (epoch ms), otherwise NOW()
  const msgTimestamp = metadata.timestamp
    ? new Date(metadata.timestamp).toISOString()
    : null;

  // INSERT the message (content = cleaned, raw_content = original)
  const insertResult = await p.query(
    `INSERT INTO chat_messages (content, raw_content, role, session_id, session_label, "timestamp", created_at, metadata)
     VALUES ($1, $7, $2, $3, $4, COALESCE($6::timestamptz, NOW()), NOW(), $5::jsonb)
     RETURNING id`,
    [cleanContent || content, role || "user", sessionId || "unknown", sessionLabel, metadataJson, msgTimestamp, content],
  );

  const rowId = insertResult.rows[0]?.id;
  if (!rowId) return;

  // Generate and store embedding from CLEAN content (not raw)
  try {
    const embedding = await generateEmbedding(cfg, cleanContent || content);
    if (embedding) {
      const embeddingStr = `[${embedding.join(",")}]`;
      await p.query(
        `UPDATE chat_messages SET embedding = $1::vector WHERE id = $2`,
        [embeddingStr, rowId],
      );
    }
  } catch (err) {
    console.warn(`[recall] Failed to generate embedding for message ${rowId}:`, err.message);
  }
}

/**
 * Strip OpenClaw envelope metadata from message content.
 * Removes "Conversation info (untrusted metadata): ```json...```"
 * and "Sender (untrusted metadata): ```json...```" blocks,
 * as well as recall plugin's own injected context blocks.
 */
function stripEnvelope(text) {
  if (!text) return "";
  // Remove "## Relevant memories from past conversations and notes:" blocks (recall's own injection)
  text = text.replace(/## Relevant memories from past conversations and notes:[\s\S]*?Use these as context if relevant to the current conversation\.\s*/g, "");
  // Remove "Conversation info (untrusted metadata):" + json code block
  text = text.replace(/Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*/g, "");
  // Remove "Sender (untrusted metadata):" + json code block
  text = text.replace(/Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/g, "");
  // Remove "[media attached: ...]" blocks (image/file attachments injected by OpenClaw)
  text = text.replace(/\[media attached:[^\]]*\]\s*/g, "");
  // Remove "To send an image back..." instruction line
  text = text.replace(/To send an image back, prefer the message tool[^\n]*\n?\s*/g, "");
  // Remove "[image data removed - already processed by model]" markers
  text = text.replace(/\[image data removed - already processed by model\]\s*/g, "");
  // Remove "Replied message (untrusted, for context):" + json code block
  text = text.replace(/Replied message \(untrusted, for context\):\s*```json[\s\S]*?```\s*/g, "");
  return text.trim();
}

/**
 * Format search results into a prompt block for prepending to context.
 */
export function formatPromptBlock(results) {
  if (!results) return "";

  const { conversations = [], notes = [] } = results;
  if (conversations.length === 0 && notes.length === 0) return "";

  const lines = ["## Relevant memories from past conversations and notes:", ""];

  if (conversations.length > 0) {
    lines.push("### From conversations:");
    for (const c of conversations) {
      const ts = c.timestamp || c.createdAt;
      const date = ts
        ? new Date(ts).toISOString().slice(0, 10)
        : "unknown";
      const cleaned = stripEnvelope(c.content || "");
      const snippet = cleaned.replace(/\r?\n+/g, " ").trim().slice(0, 300);
      if (!snippet) continue;
      lines.push(`- [${date}] ${snippet}`);
    }
    lines.push("");
  }

  if (notes.length > 0) {
    lines.push("### From vault notes:");
    for (const n of notes) {
      const title = n.title || n.path || "Untitled";
      const snippet = (n.content || "").replace(/\r?\n+/g, " ").trim().slice(0, 200);
      lines.push(`- [${title}] ${snippet}`);
    }
    lines.push("");
  }

  lines.push("Use these as context if relevant to the current conversation.");
  lines.push("");

  return lines.join("\n");
}

/**
 * Build config from plugin config + environment variables.
 */
export function buildConfig(pluginConfig = {}) {
  const cfg = pluginConfig ?? {};
  return {
    pgHost: cfg.pgHost || process.env.PGHOST || "server",
    pgPort: parseInt(cfg.pgPort || process.env.PGPORT || "5432", 10),
    pgUser: cfg.pgUser || process.env.PGUSER || "chloe",
    pgPassword: cfg.pgPassword || process.env.PGPASSWORD || "chloe",
    pgDatabase: cfg.pgDatabase || process.env.PGDATABASE || "chloe",
    openrouterApiKey: cfg.openrouterApiKey || process.env.OPENROUTER_API_KEY || "",
    embeddingModel: cfg.embeddingModel || process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small",
    recallEnabled: cfg.recallEnabled !== false,
    addEnabled: cfg.addEnabled !== false,
    captureStrategy: cfg.captureStrategy ?? "last_turn",
    maxMessageChars: cfg.maxMessageChars ?? 20000,
    includeAssistant: cfg.includeAssistant !== false,
    searchLimit: cfg.searchLimit ?? 10,
    minSimilarity: cfg.minSimilarity ?? 0.6,
    timeoutMs: cfg.timeoutMs ?? 5000,
    throttleMs: cfg.throttleMs ?? 0,
  };
}

/**
 * Extract text from message content (string or content blocks).
 */
export function extractText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && typeof block === "object" && block.type === "text")
      .map((block) => block.text)
      .join(" ");
  }
  return "";
}
