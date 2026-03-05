# Recall — 本地优先的 OpenClaw 记忆插件

一个 OpenClaw 生命周期插件，用你自己的 PostgreSQL 数据库为 agent 提供**持久记忆**。不依赖云服务，不上传数据——你的对话和知识留在你自己的机器上。

## 工作原理

```
用户发送消息
       │
       ▼
┌─ before_agent_start ─────────────────────┐
│  用户 prompt → embedding → 向量搜索       │
│  PostgreSQL (chat_messages + vault_notes)  │
│  → 相关记忆注入到上下文                    │
└───────────────────────────────────────────┘
       │
       ▼
   Agent 运行（带记忆上下文）
       │
       ▼
┌─ agent_end ──────────────────────────────┐
│  对话内容 → embedding → INSERT            │
│  PostgreSQL (chat_messages)               │
│  → 存储供未来召回                          │
└───────────────────────────────────────────┘
```

**召回（Recall）**：每次 agent 运行前，通过 pgvector 余弦相似度搜索数据库中的相关对话和笔记，注入到 prompt 上下文。

**存储（Store）**：每次 agent 运行后，将对话内容生成 embedding 并存入数据库。

## 安装

```bash
openclaw plugins install recall-openclaw-plugin@latest
```

### 配置

在 OpenClaw 配置文件中：

```json
{
  "plugins": {
    "entries": {
      "recall-openclaw-plugin": { "enabled": true }
    }
  }
}
```

## 环境变量

- `PGHOST` — PostgreSQL 主机（默认 `server`）
- `PGPORT` — PostgreSQL 端口（默认 `5432`）
- `PGUSER` — PostgreSQL 用户（默认 `chloe`）
- `PGPASSWORD` — PostgreSQL 密码
- `PGDATABASE` — PostgreSQL 数据库（默认 `chloe`）
- `OPENROUTER_API_KEY` — 必需，用于生成 embedding
- `EMBEDDING_MODEL` — Embedding 模型（默认 `openai/text-embedding-3-small`）

### 插件配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `pgHost` | string | env `PGHOST` 或 `server` | PostgreSQL 主机 |
| `pgPort` | integer | env `PGPORT` 或 `5432` | PostgreSQL 端口 |
| `pgUser` | string | env `PGUSER` 或 `chloe` | PostgreSQL 用户 |
| `pgPassword` | string | env `PGPASSWORD` | PostgreSQL 密码 |
| `pgDatabase` | string | env `PGDATABASE` 或 `chloe` | PostgreSQL 数据库 |
| `openrouterApiKey` | string | env `OPENROUTER_API_KEY` | Embedding API Key |
| `embeddingModel` | string | `openai/text-embedding-3-small` | Embedding 模型 |
| `recallEnabled` | boolean | `true` | 启用记忆召回 |
| `addEnabled` | boolean | `true` | 启用对话存储 |
| `captureStrategy` | string | `last_turn` | `last_turn` 或 `full_session` |
| `searchLimit` | integer | `10` | 每次搜索最大结果数 |
| `timeoutMs` | integer | `5000` | 数据库连接超时 |
| `throttleMs` | integer | `0` | 存储最小间隔 |

## 数据库配置

插件需要两张 PostgreSQL 表，并启用 [pgvecto.rs](https://github.com/tensorchord/pgvecto.rs) 向量扩展。

1. 安装向量扩展：

```sql
CREATE EXTENSION IF NOT EXISTS vectors;
```

2. 用提供的 SQL 文件创建表：

```bash
psql -h your-host -U your-user -d your-db -f sql/chat_messages.sql
psql -h your-host -U your-user -d your-db -f sql/vault_notes.sql
```

- **`chat_messages`** — 存储对话历史。插件每次 agent 运行后自动写入。完整定义见 [`sql/chat_messages.sql`](sql/chat_messages.sql)。
- **`vault_notes`** — 存储知识库（如 Obsidian vault 笔记）。需要你自己同步数据（通过脚本等）。完整定义见 [`sql/vault_notes.sql`](sql/vault_notes.sql)。

两张表都使用 `vector(1536)` 列存储 embedding（匹配 `text-embedding-3-small` 输出维度），并建有 pgvector 余弦相似度索引。

## 依赖

- PostgreSQL + [pgvecto.rs](https://github.com/tensorchord/pgvecto.rs) 扩展（向量相似度搜索）
- OpenRouter API Key（用于 embedding）
- OpenClaw

## 许可证

Apache-2.0
