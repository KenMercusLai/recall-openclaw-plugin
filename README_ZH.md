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
│  对话 → 清洗 + embedding → INSERT         │
│  content（清洗后）+ raw_content（原始）    │
│  → 存储供未来召回                          │
└───────────────────────────────────────────┘
```

## 功能特性

- **语义搜索** — 使用 pgvector 余弦相似度查找相关的历史对话和笔记，而非简单关键词匹配
- **内容清洗** — 自动剥离 OpenClaw 注入的信封元数据（对话信息、发送者信息、媒体附件、回复标签、recall 注入内容），确保搜索基于实际消息内容
- **双重存储** — `content` 存清洗后的文本（用于搜索），`raw_content` 保留原始内容（供参考）
- **心跳过滤** — 在召回和存储两端都跳过心跳消息，避免噪音
- **toolResult 排除** — 后端工具执行结果会存储但不参与召回搜索
- **相似度阈值** — 可配置最低余弦相似度（默认 `0.5`），过滤低相关度结果
- **时间衰减** — 对数记忆衰减，老记忆需要更高语义相关度才能被召回。公式：`final_score = similarity × 1/(1 + α × ln(1 + days)) × weight`。可配置 `timeDecayAlpha`（默认 `0.09`，设 `0` 关闭）。vault_notes 不受衰减影响。
- **重要记忆置顶** — 通过 `weight` 列标记重要记忆（`2.0`=置顶，`0`=屏蔽）。置顶记忆能抵抗时间衰减，长期保持可召回。
- **精确时间戳** — 使用消息元数据中的原始时间戳，而非插入时间
- **去重** — 基于 `(session_id, md5(content), date_trunc('second', timestamp))` 唯一索引防止重复
- **会话追踪** — 同时记录 `session_id`（UUID）和 `session_label`（可读标识如 `agent:main:telegram:direct:12345`）
- **丰富元数据** — 以 JSONB 格式存储模型、用量、提供商、工具信息等消息元数据

## 安装

```bash
# 从 npm（发布后）
openclaw plugins install recall-openclaw-plugin@latest

# 从本地路径
# 在 OpenClaw 配置中设置插件加载路径：
# "load": { "recall-openclaw-plugin": "/path/to/recall-openclaw-plugin" }
```

### 配置

在 OpenClaw 配置文件（`~/.openclaw/openclaw.json`）中：

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

## 插件配置

在 `plugins.entries.recall-openclaw-plugin.config` 中：

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
| `searchLimit` | integer | `10` | 每次搜索最大结果数（在对话和笔记之间分配） |
| `minSimilarity` | number | `0.5` | 最低余弦相似度阈值（0–1），低于此值的结果被丢弃 |
| `timeDecayAlpha` | number | `0.09` | 时间衰减因子（α），越大衰减越快，`0` 关闭衰减 |
| `timeoutMs` | integer | `5000` | 数据库连接超时 |
| `throttleMs` | integer | `0` | 存储最小间隔 |

## 详细流程

### 召回（before_agent_start）
1. 取用户 prompt 生成 embedding（通过 OpenRouter）
2. 搜索 `chat_messages`（排除 `toolResult`）和 `vault_notes`，使用 pgvector 余弦相似度
3. 启用衰减时过采样 3 倍候选（衰减可能淘汰部分结果）
4. 计算 `final_score = similarity × time_decay × weight`
5. 过滤 `final_score < minSimilarity` 的结果
6. 按 `final_score` 排序，取 top N
7. 格式化结果，通过 `prependContext` 注入 agent 上下文
8. 心跳消息直接跳过

### 存储（agent_end）
1. agent 运行成功后，提取对话中的消息
2. **清洗每条消息** — 剥离信封元数据、媒体附件块、回复标签、recall 注入块
3. 同时存储 `content`（清洗后，用于 embedding）和 `raw_content`（原始，供参考）
4. 使用消息元数据中的原始时间戳（无可用时间戳则用 `NOW()`）
5. 从清洗后的内容异步生成 embedding
6. 心跳消息直接跳过

### 内容清洗（stripEnvelope）

以下模式在存储和生成 embedding 前自动移除：

- `## Relevant memories from past conversations and notes:` 块（recall 自身注入）
- `Conversation info (untrusted metadata):` JSON 块
- `Sender (untrusted metadata):` JSON 块
- `[media attached: ...]` 块
- `To send an image back...` 指示行
- `[image data removed - already processed by model]` 标记
- `Replied message (untrusted, for context):` JSON 块
- `[[reply_to_current]]` 和 `[[reply_to:<id>]]` 标签
- 多余的连续空行（压缩为一行）

## 时间衰减

老记忆会逐渐变得更难被召回，除非它们在语义上高度相关。这能防止无关的旧对话污染上下文。

**公式：** `final_score = cosine_similarity × 1/(1 + α × ln(1 + days_old)) × weight`

默认 `α = 0.09`，`minSimilarity = 0.5` 时的效果：

| 余弦相似度 | 1 周后能召回？ | 1 个月后？ | 3 个月后？ |
|---|---|---|---|
| 0.90（几乎同义） | ✅ 0.745 | ✅ 0.671 | ✅ 0.620 |
| 0.70（同一话题） | ✅ 0.590 | ✅ 0.536 | ❌ 0.497 |
| 0.60（有关联） | ✅ 0.506 | ❌ 0.460 | ❌ 0.413 |
| 0.55（弱关联） | ❌ 0.463 | ❌ 0.422 | ❌ 0.379 |

- **vault_notes 不受衰减影响**（笔记是永久参考资料）
- 设 `timeDecayAlpha: 0` 可完全关闭衰减

## 重要记忆置顶

通过 `weight` 列控制单条记忆的召回优先级：

| Weight | 效果 |
|--------|------|
| `1.0` | 普通（默认） |
| `2.0` | 置顶 — 分数翻倍，能长期抵抗时间衰减 |
| `0` | 屏蔽 — 永远不会被召回 |

**操作示例：**

```sql
-- 置顶一条重要记忆
UPDATE chat_messages SET weight = 2.0 WHERE id = 12345;

-- 屏蔽一条噪音记忆
UPDATE chat_messages SET weight = 0 WHERE id = 67890;

-- 恢复为普通
UPDATE chat_messages SET weight = 1.0 WHERE id = 12345;

-- 查看所有非默认权重的记忆
SELECT id, LEFT(content, 100), weight FROM chat_messages WHERE weight != 1.0;

-- 置顶一条笔记
UPDATE vault_notes SET weight = 2.0 WHERE path = 'important-note.md';
```

置顶记忆（weight=2.0）在 90 天后、cosine=0.60 的效果：
- 普通：`0.60 × 0.689 = 0.413` ❌ 低于阈值
- 置顶：`0.60 × 0.689 × 2.0 = 0.827` ✅ 轻松召回

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

### chat_messages

存储对话历史。插件每次 agent 运行后自动写入。

主要字段：
- `content` — 清洗后的消息文本（信封元数据已剥离）
- `raw_content` — 原始未修改的消息文本
- `role` — `user`、`assistant` 或 `toolResult`
- `embedding` — `vector(1536)` 用于余弦相似度搜索
- `session_id` — 匹配 OpenClaw 会话的 UUID
- `session_label` — 可读会话标识（如 `agent:main:telegram:direct:12345`）
- `timestamp` — 消息原始时间戳
- `metadata` — JSONB，包含模型、用量、提供商、工具信息等
- `weight` — 召回权重（默认 `1.0`），`2.0` 置顶，`0` 屏蔽

完整定义见 [`sql/chat_messages.sql`](sql/chat_messages.sql)。

### vault_notes

存储知识库（如 Obsidian vault 笔记）。需要你自己通过同步脚本等方式填充数据。

完整定义见 [`sql/vault_notes.sql`](sql/vault_notes.sql)。

## 依赖

- PostgreSQL + [pgvecto.rs](https://github.com/tensorchord/pgvecto.rs) 扩展
- OpenRouter API Key（用于 embedding）
- OpenClaw

## 许可证

Apache-2.0
