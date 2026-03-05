#!/usr/bin/env node
import {
  addMessage,
  buildConfig,
  extractText,
  formatPromptBlock,
  searchMemory,
  testConnection,
} from "./lib/local-memory-api.js";

let lastCaptureTime = 0;

function truncate(text, maxLen) {
  if (!text) return "";
  if (!maxLen) return text;
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function pickLastTurnMessages(messages, cfg) {
  const lastUserIndex = messages
    .map((m, idx) => ({ m, idx }))
    .filter(({ m }) => m?.role === "user")
    .map(({ idx }) => idx)
    .pop();

  if (lastUserIndex === undefined) return [];

  const slice = messages.slice(lastUserIndex);
  const results = [];

  for (const msg of slice) {
    if (!msg || !msg.role) continue;
    if (msg.role === "user") {
      const content = extractText(msg.content);
      if (content) results.push({ role: "user", content: truncate(content, cfg.maxMessageChars) });
    } else if (msg.role === "assistant" && cfg.includeAssistant) {
      const content = extractText(msg.content);
      if (content) results.push({ role: "assistant", content: truncate(content, cfg.maxMessageChars) });
    }
  }

  return results;
}

function pickFullSessionMessages(messages, cfg) {
  const results = [];
  for (const msg of messages) {
    if (!msg || !msg.role) continue;
    if (msg.role === "user") {
      const content = extractText(msg.content);
      if (content) results.push({ role: "user", content: truncate(content, cfg.maxMessageChars) });
    } else if (msg.role === "assistant" && cfg.includeAssistant) {
      const content = extractText(msg.content);
      if (content) results.push({ role: "assistant", content: truncate(content, cfg.maxMessageChars) });
    }
  }
  return results;
}

export default {
  id: "memos-local-plugin",
  name: "Local Memory Plugin",
  description: "Local PostgreSQL/pgvector memory recall + save via lifecycle hooks",
  kind: "lifecycle",

  register(api) {
    const cfg = buildConfig(api.pluginConfig);
    const log = api.logger ?? console;

    // Test DB connection on register
    testConnection(cfg)
      .then(() => log.info?.("[memos-local] PostgreSQL connection OK"))
      .catch((err) => log.warn?.(`[memos-local] PostgreSQL connection failed: ${err.message}`));

    if (!cfg.openrouterApiKey) {
      log.warn?.("[memos-local] Missing OPENROUTER_API_KEY; embeddings will not work.");
    }

    // Recall: search memories before agent starts
    api.on("before_agent_start", async (event, ctx) => {
      if (!cfg.recallEnabled) return;
      if (!event?.prompt || event.prompt.length < 3) return;
      if (!cfg.openrouterApiKey) return;

      try {
        const results = await searchMemory(cfg, {
          query: event.prompt,
          limit: cfg.searchLimit,
        });

        const promptBlock = formatPromptBlock(results);
        if (!promptBlock) return;

        return { prependContext: promptBlock };
      } catch (err) {
        log.warn?.(`[memos-local] recall failed: ${err.message}`);
      }
    });

    // Save: store conversation after agent completes
    api.on("agent_end", async (event, ctx) => {
      if (!cfg.addEnabled) return;
      if (!event?.success || !event?.messages?.length) return;

      const now = Date.now();
      if (cfg.throttleMs && now - lastCaptureTime < cfg.throttleMs) return;
      lastCaptureTime = now;

      try {
        const messages =
          cfg.captureStrategy === "full_session"
            ? pickFullSessionMessages(event.messages, cfg)
            : pickLastTurnMessages(event.messages, cfg);

        if (!messages.length) return;

        const sessionKey = ctx?.sessionKey || ctx?.sessionId || `openclaw-${Date.now()}`;

        // Save each message
        for (const msg of messages) {
          await addMessage(cfg, {
            sessionKey,
            role: msg.role,
            content: msg.content,
          });
        }
      } catch (err) {
        log.warn?.(`[memos-local] save failed: ${err.message}`);
      }
    });
  },
};
