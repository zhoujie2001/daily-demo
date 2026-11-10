# AD 游戏 source_card_manifest v1 最终接入契约

> 上游 Skill 适配正式入口：[AD 游戏 Skill 上游适配说明](ad-game-source-card-skill-adapter-v1.md)，含完整 JSON、精确 Python canonical/hash、冻结与重试规则、迁移上线顺序；与本仓库代码一起交付。

此变更仅中台；未修改任何 Skill、名单或千川分池机制。上游仍先按原需求顺序切成最多 20 条的独立 payload，中台不会把 78 条合成一次投递，也不扩大原有 40 条单次 ingest 上限。

## 字段与约束

在现有批量请求上增加两个顶层字段，必须一起提供：

| 字段 | 类型 / 规则 |
| --- | --- |
| `source_card_manifest` | 下面定义的完整对象，每片和所有重试携带同一份 |
| `source_card_chunk_index` | 当前片 **1-based** 整数，必须对应完整清单中的序号 |

manifest **只能**包含下面九个字段；chunk **只能**包含下面四个字段。未知 `source_card_*` 字段、未知版本、缺字段、null、冲突均拒绝。

| manifest 字段 | 类型 / 规则 |
| --- | --- |
| `version` | 整数 `1` |
| `source_batch_id` | 原始 source 稳定全局唯一 ID；`[A-Za-z0-9_-]{1,128}`；永久不可改绑，不以日期或聊天群重建命名空间 |
| `chat_id` | 与请求目标群精确相等；群仍须通过既有 ingest binding / callback allowlist |
| `dispatch_profile` | 固定 `ad` |
| `target_category` | 固定 `game_agent`；每个 item 的 `business_type` 固定 `AD`；解析 scope 必须是现有 `ad_game` |
| `total_item_count` | 原 source 需求总数，整数 1–1000；不是当前片数量 |
| `chunk_count` | `ceil(total_item_count / 20)`，不是中台本次 payload 的内部拆卡数量 |
| `chunks` | 全部分片的有序数组，长度等于 `chunk_count`，不得省略未投递片 |
| `manifest_hash` | 以下算法产生的 64 字符小写 SHA-256 十六进制 |

每个 chunk 为 `{chunk_index, batch_id, item_count, request_ids}`：

- `chunk_index` 连续为 1…Y，数组本身也按这个顺序排列。
- `batch_id` 为该独立 payload 的稳定 ID，沿用 `[A-Za-z0-9_-]{1,128}`，清单内无重复，持久全局不能改绑到另一 source/序号。
- `item_count`：非最后一片固定 20，最后一片为剩余数；所有片相加恰好等于 `total_item_count`。
- `request_ids`：全部为字符串 `[A-Za-z0-9_-]{1,64}`，有序、长度等于 `item_count`，source 内不允许任何跨片或片内重复。
- 当前顶层 `batch_id` 必须等于当前 chunk 的 `batch_id`；当前 `items.map(i => i.request_id)` 必须与当前 chunk 的 `request_ids` **逐项、逐字节、同序完全相同**，不能只比较集合或自动排序。
- item/顶层如另带 `source_batch_id`，必须等于 manifest 值。item 若带 `dispatch_profile`，必须为 `ad`。原有表格、行号、日期/负责人字段契约继续生效。
- 游戏的 `reject_reason_codes` 可携带多个 CODE，仅为无关来源信息，不参与此 manifest 的 hash、拆卡、去重或千川决策。不可混入 `decision_policy_version` 等千川决策字段。

## 完整 JSON 示例（21 条，第 2/2 张）

下面是假数据，不得当作真实批次重放。第一片提交同一份 manifest，但 `batch_id` 换成 `game_source_21_card_1`、`source_card_chunk_index` 为 1，`items` 为有序 `game_1`…`game_20` 的实际内容。

```json
{
  "chat_id": "oc_56debf24fa90e17ea92257c20454d742",
  "dispatch_profile": "ad",
  "batch_id": "game_source_21_card_2",
  "source_card_chunk_index": 2,
  "source_card_manifest": {
    "version": 1,
    "source_batch_id": "game_source_21",
    "chat_id": "oc_56debf24fa90e17ea92257c20454d742",
    "dispatch_profile": "ad",
    "target_category": "game_agent",
    "total_item_count": 21,
    "chunk_count": 2,
    "chunks": [
      {
        "chunk_index": 1,
        "batch_id": "game_source_21_card_1",
        "item_count": 20,
        "request_ids": ["game_1", "game_2", "game_3", "game_4", "game_5", "game_6", "game_7", "game_8", "game_9", "game_10", "game_11", "game_12", "game_13", "game_14", "game_15", "game_16", "game_17", "game_18", "game_19", "game_20"]
      },
      {
        "chunk_index": 2,
        "batch_id": "game_source_21_card_2",
        "item_count": 1,
        "request_ids": ["game_21"]
      }
    ],
    "manifest_hash": "96f1ef5c3a4a438322c87a6ab5c815aaba276784adb0de60e37817c84cf6b131"
  },
  "items": [
    {
      "request_id": "game_21",
      "request_name": "游戏需求 21",
      "business_type": "AD",
      "target_category": "game_agent",
      "dispatch_profile": "ad",
      "sheet_url": "https://example.feishu.cn/sheets/game",
      "sheet_id": "gameSheet",
      "row_index": 22,
      "date_field_id": "J",
      "assignee_field_id": "B"
    }
  ]
}
```

78 条：完整 `chunks` 为四片 `20/20/20/18`；四个独立请求分别传 index 1、2、3、4，同一 source ID、同一完整清单、同一 hash。20 条也携带单片清单，显示第 1/1 张。

## SHA-256 算法（不要对整个 payload 求 manifest hash）

1. 从 manifest 中删除且只删除 `manifest_hash` 字段。
2. 对剩余对象递归 canonical JSON：对象键按字典序排序，数组维持原序；字符串按 JSON 字符串编码；整数使用 JSON 十进制表示；无缩进、无空格、无尾随换行。
3. 对 canonical JSON 的 **UTF-8 字节**计算 SHA-256，输出 **小写** 64 字符 hex。
4. `source_card_chunk_index`、当前 `items`、标题、CODE 不在 manifest 对象中，因此不参与这个 hash。所有 chunk 的有序 ID、batch ID、数量，以及 source/chat/profile/category 都参与。
5. 原 `/send` HMAC 认证仍对**完整请求体** canonical JSON 签名，包含 metadata 和当前 index；automation-token 认证不变。manifest hash 不代替认证。

JavaScript（与中台实现一致）：

```js
import { createHash } from 'node:crypto';
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
function manifestHash(manifest) {
  const { manifest_hash, ...content } = manifest;
  return createHash('sha256').update(canonical(content), 'utf8').digest('hex');
}
```

## 持久绑定与生命周期

- 新表 `bess_source_card_manifests`：主键 `source_batch_id`，存整份 immutable manifest。首次投递即锁定完整 source，不按 ingest/queue 七天过期清理。
- 新表 `bess_source_card_chunks`：主键 `batch_id`，另有唯一 `(source_batch_id, chunk_index)`，存完整引用和有序 ID。首次投递就在同一 SQL 事务内预留**全部**分片；某个后续片从未发送也不能改绑。
- register RPC 对已有 source 比较完整 jsonb（不只比较 hash），冲突回滚。注册先按全局 batch ID 排序获取事务 advisory locks，检查既有 pending root/ingest（包括旧 root 的 chunkPlan）；既有合法旧占用拒绝新 source，全部新事实回滚。`bess_dispatch_pending_forms` 的 BEFORE INSERT/UPDATE trigger 对旧 RPC 和 REST 写入使用同一锁，覆盖两个竞争方向。
- 新模式 send/automation-send/pull-base 把当前片 root reservation 一并交给 `bess_register_source_card_manifest(p_manifest,p_root)`：同一事务冻结全清单、固定当前片 delivery fingerprint、调用真实旧 root CAS；CAS 冲突也回滚整个 source/chunks，不再先永久注册再单独 reserve。其余尚未投递片不固定业务 fingerprint，首次投递各自固定，不增加先后门禁。
- ingest 保留 metadata 进入幂等 fingerprint，queue/handoff 持久保存完整 manifest + 当前 index。卡片 callback 的每个 item 用紧凑 `source_card_binding` 引用，避免重复传整份 source 清单；引用包含 manifest 的八个非 `chunks` 字段，加 `chunk_index`、`batch_id`。
- queue 消费与 outbox 真实发送前、批量 callback 的名单/claim/游标操作前，核对持久完整引用及**完整有序**当前片 ID。指定人员 callback/form 恢复核对同片中的单个 ID。
- 初始、processing、partial、final/retry 卡保留 source 序号与引用；pending form / batch claim 中的 normalized fields 保留引用，不改变派单逻辑。
- API `chunks[]` 既有 `chunk_index/chunk_count` 仍表示本次 payload 的内部拆卡；新增 `source_card_binding` 明确表示 source 级序号，避免把已有本地拆卡语义扩大成四片。
- 不增加跨卡点击先后门禁；不预分配或重置游标；仍由既有 `ad_game` scope 的名单和派单顺序决定处理。

## DB migration 上线必要性 / 兼容

**启用新 metadata 前必须应用 `supabase/migrations/202611080001_source_card_manifest.sql`。本次未对任何线上库应用迁移。**

新增四个 service-role RPC：

- `bess_register_source_card_manifest(jsonb,jsonb)`：第二参数为中台当前片 root（可缺省 null 仅冻结结构；真实投递入口始终提供）。
- `bess_assert_source_card_binding(jsonb,jsonb,boolean)`
- `bess_assert_legacy_source_card_batch(text)`（防止已登记新批次删除 metadata 降级成旧批次）
- `bess_assert_legacy_source_card_members(text,jsonb,text)`（chat、items 业务身份、原消息，防单条无 batch/binding 降级）

内部 canonical helper 与 pending trigger 不授予 API 角色执行。三表开启并强制 RLS，不授予 anon/authenticated/service_role 直接写；绑定及历史来源写入只能走 security-definer 事务。迁移使用 PostgreSQL 内置 `sha256(bytea)`、`pg_advisory_xact_lock`，无需 pgcrypto；不替换旧 RPC、不改千川/名单/游标表，但**新增旧 pending 表写入 trigger**。必须先具备真实旧 root migration `db/migrations/20261023_dispatch_ingest_root.sql` 及完整 pending schema。

- 无 metadata 的旧 payload/callback 保留原格式、派单字段、内部 20/40 限制及旧 fingerprint。
- 旧模式在尚未迁移的 DB 上，只有明确 missing RPC（PGRST202/42883）的 legacy guard 可兼容；超时、网络故障、其它错误绝不静默绕过。新模式无任何持久化降级。
- 新 batch 一经登记，旧入口省略 metadata 会拒绝；不得为了重试换 source/chat/profile/category/ordinal 绑定。
- 注册事实有意非过期数据；若未来需归档，应单独设计保留冲突 tombstone 的迁移，不应由当前 cleanup 删除。
- 新模式仍受各入口现有请求字节预算限制；1000 是清单结构上限，不承诺任意长度 ID 组成的请求都能通过字节限制。
- 本 v1 固定 AD 游戏生产 scope；不开放 AD 大盘、应急、千川或 isolation run。它不哈希整份业务/表格内容快照；当前片业务内容仍由现有持久 ingest fingerprint 冻结。全 source 的冻结边界是要求的 ID/片序/batch/chat/profile/category。

## 本地验证与未做项

```sh
node --test tests/sourceCardManifest.test.js
node --test
npm run lint
git diff --check
node tools/source-card-sql-acceptance.mjs /path/to/pglite/dist/index.js
```

SQL acceptance 使用临时磁盘 PostgreSQL/PGlite 数据库，执行真实迁移与 RPC，并关闭/重新打开数据库验证绑定仍存续；验证 source/chat/batch/ordinal/order 冲突、完整四片、权限/RLS和旧批次降级保护。测试依赖装在临时目录，不修改项目 dependencies/lockfile。PGlite 不等同于 Supabase/PostgREST 或多 session 并发压力验收。

未做：改 Skill、commit、push、部署、应用线上迁移、发真实飞书卡片、重放真实批次、重置游标、修改名单/千川分池、跨卡顺序门禁、线上多 session 并发与飞书 Card 2.0 端到端验收。

## 首轮实现验证记录（新增正式适配文档之前）

- `node --test tests/sourceCardManifest.test.js`：43/43 通过。
- `node --test`：1089/1089 通过，0 fail、0 skipped。
- `npm run lint`：通过。
- `git diff --check`：通过。
- 隔离磁盘 SQL acceptance：57 项通过，包含关闭/重开数据库后读取及冲突拒绝，production_calls=0。
- 工作分支保持 `aime/1794109957-source-card-manifest`，仅未提交工作区变更。

## 正式 Skill 适配说明补充后的复核

正式入口为 [ad-game-source-card-skill-adapter-v1.md](ad-game-source-card-skill-adapter-v1.md)，新增文档契约测试 [sourceCardSkillAdapter.test.js](../tests/sourceCardSkillAdapter.test.js)。原 43 项和新增 3 项合计 46/46 通过；全仓串行 `node --test --test-concurrency=1` 为 1092/1092 通过。默认并行复核一轮为 1091/1092：既有 Supabase 超时诊断测试失败，单独重跑 1/1 通过。不能把串行通过写成默认并行全绿；具体断言及未证明的时序原因见正式说明的测试记录。SQL acceptance 57 项、lint、diff 检查通过，仍未做线上验收或任何发布操作。

## P2 审查修复（当前最终工作区）

前述首轮与文档补充记录仅为历史，不代表已经覆盖本次三个反例。当前修复如下：

1. **确定性 binding**：生成、callback 校验及 ingest/callback fingerprint 均统一嵌套 binding 字段序：`version, source_batch_id, chat_id, dispatch_profile, target_category, total_item_count, chunk_count, manifest_hash, chunk_index, batch_id`。manifest/chunk/binding 对象键重排不改 hash 或幂等 fingerprint；数组重排仍拒绝。**v1 JSON、canonical/hash 与 Python 实现没有改变**，示例 hash 仍为 `96f1ef5c3a4a438322c87a6ab5c815aaba276784adb0de60e37817c84cf6b131`。
2. **持久占用原子协调**：注册与当前片 root CAS 同一事务；旧 root/ingest/REST 写入共享排序后的全局 batch 事务锁。旧先占则新注册拒绝且无永久副作用；新先占则旧写入拒绝；新 source 错用 ACCEPTED 旧 batch 不再封死旧 payload、卡或 outbox。真实旧 root CAS 冲突也回滚全清单。
3. **单条去 metadata 防降级**：业务身份为 `(chat_id, dispatch_profile, target_category, request_id)`，不以 caller 提供的 batch/binding 为必要条件。已登记成员缺 binding，先查持久成员 guard，再决定是否进入 cleanup/名单/回复/表单/游标。恢复名单/指定人员表单也校验；名单表单将 cleanup 延后到身份检查后。

### 历史兼容边界

`bess_source_card_legacy_messages` 在首次 source 冻结时，从已存在的持久 pending/card payload 提取**确有 AD/game 身份的历史消息或旧 outbox origin**。同 request 的真正历史旧消息可恢复；旧 outbox 后续取得真实 Lark receipt 时，trigger 把 origin 关联到消息，并非过期保存，因此 pending 清理后仍可恢复。无关 chat/profile/category 或未登记 request 不被裸 ID 误伤。新卡删除 binding、凭空提供 batch/消息、或 source 冻结之后伪造旧来源不能获得历史豁免。

仅凭“看起来是旧卡”或裸 request ID 不能证明历史来源；如果原有持久来源早已不存在且同一业务身份已登记 source，安全拒绝，不能据此承诺所有无凭据历史卡都可恢复。上线前需盘点旧任务持久来源。旧 schema 缺 legacy RPC 的兼容只适用于尚未启用 source 的阶段；必须确认四个 RPC/trigger 全部 ready 后启用新模式。

### 首批三个 P2 修复的历史验证记录（未覆盖后续消息来源遗漏）

| 范围 | 结果 |
| --- | --- |
| source + 正式文档契约专项 | **54/54**，0 fail/skip（51 个 source 测试 + 3 个文档测试） |
| 默认并行全仓，独立复跑 | **1100/1100**，0 fail/skip |
| 全仓串行 | **1100/1100**，0 fail/skip |
| 较高负载一轮（与串行及 SQL 验收同时运行） | **1099/1100**，既有 `supabaseDispatchStore.test.js:496` 的 `<250ms` 墙钟断言失败，实际测试 duration 349.5ms；未修改该测试/超时运行时掩盖差异 |
| 磁盘 PGlite SQL acceptance | **113 checks**，真实 root/handoff/outbox migration、权限/RLS、原子冲突回滚、历史/延迟 outbox 恢复、关闭重开持久性，production_calls=0 |
| 隔离 localhost PostgreSQL 15 | **65 checks**，含 **4 组真实双会话竞争**（root/handoff × 旧先/新先）；实际观察到 4 次 advisory wait，败方拒绝且无 registry 污染 |
| lint / diff whitespace | 通过 |

双会话验收命令：`node tools/source-card-postgres-acceptance.mjs /path/to/pg/lib/index.js <isolated-localhost-port>`。脚本只连接 `127.0.0.1`，建立并删除隔离数据库；不会读取生产凭据。SQL acceptance fixture 是隔离 schema 扩展，不是生产迁移，也不是改名单/千川的补丁。仍未验证真实 Supabase/PostgREST、线上多实例/高并发锁压力、真实飞书及实际 Skill 环境。

### 最终项目文件清单（23 个）

| 文件 | 用途 |
| --- | --- |
| [source-card-manifest.js](../lib/dispatch/source-card-manifest.js) | 校验、hash、binding 稳定序、注册/成员 guard |
| [ingest.js](../lib/dispatch/ingest.js) | normalize 与 ingest fingerprint |
| [card-chunks.js](../lib/dispatch/card-chunks.js) | 单次拆卡及 source queue metadata |
| [dispatch-service.js](../lib/dispatch/dispatch-service.js) | callback、表单恢复与持久幂等 |
| [outbox-worker.js](../lib/dispatch/outbox-worker.js) | queue/发送前绑定校验 |
| [supabase-store.js](../lib/dispatch/supabase-store.js) | 原子注册与 legacy 成员 RPC adapter |
| [send.js](../lib/dispatch/api/send.js) | HMAC 入口原子注册 |
| [automation-send.js](../lib/dispatch/api/automation-send.js) | automation 入口原子注册 |
| [pull-base.js](../lib/dispatch/api/pull-base.js) | pull 入口原子注册 |
| [card-actions.js](../lib/lark/card-actions.js) | callback schema 与 binding normalize |
| [card-renderer.js](../lib/lark/card-renderer.js) | 初始/状态/结果卡 source 生命周期 |
| [source migration](../supabase/migrations/202611080001_source_card_manifest.sql) | 三表、四个业务 RPC、pending trigger |
| [source fixture](../tests/fixtures/source-card-manifest.js) | 20/21/78 合成数据 |
| [SQL fixture 扩展](../tests/fixtures/source-card-sql-baseline.sql) | 真实旧 root/handoff/outbox 所需隔离 pending schema |
| [source tests](../tests/sourceCardManifest.test.js) | 原契约、首批 P2 及来源恢复/防借用反例 |
| [批量生命周期测试](../tests/batchDispatch.test.js) | 旧卡完整 callback、PARTIAL 重试、名单保存后新卡开始 |
| [指定人员生命周期测试](../tests/specifyAssignee.test.js) | 旧卡开表单、名单初始化、失败补偿/完成 replay、context 反例 |
| [文档契约测试](../tests/sourceCardSkillAdapter.test.js) | JSON/Python/JS 一致性 |
| [PGlite SQL acceptance](../tools/source-card-sql-acceptance.mjs) | 131 项持久/权限/占用与 callback/form 验收 |
| [共享占用验收](../tools/source-card-occupation-acceptance.mjs) | 真实旧 RPC/原子 rollback/历史来源 |
| [PostgreSQL 并发验收](../tools/source-card-postgres-acceptance.mjs) | 真实双会话旧/新竞争 |
| [中台规范](source-card-manifest-v1.md) | 本文与最终文件清单 |
| [正式 Skill 适配说明](ad-game-source-card-skill-adapter-v1.md) | 最终 JSON/hash/Python/冻结/上线契约 |

仅更新工作区，不 stage/unstage/重置用户原暂存内容。后续消息来源修复的重新 stage 清单见下节；没有 commit、push、部署或线上迁移。
## 后续 P2：历史消息来源全生命周期修复

此前 1100/1100 记录不代表覆盖本次发现的两个来源遗漏。本轮修复及扩大自查：

1. 批量 callback 的 guard 明确传入可信 `event.messageId`，完整旧 batch 成员后来进入 source 时不再因传 null 而误拒绝。PARTIAL 重试和完成 replay 每次仍先走持久 guard。
2. 指定人员 submit 从按新表单消息查出的**服务端 pending**读取 `original_message_id`，不使用新表单消息作为历史来源，也不接受 action/form 中的来源或需求字段覆盖。先验证 pending 群聊、context kind、已有 form/request ID 和 context chat，再 guard，再读表、指定锁、写入/校准、完成及原卡更新。完成 replay 也必须重新通过 guard。没有原来源时传 null，仍由数据库按业务身份 fail closed；不扩大旧消息豁免集合。
3. 自查还覆盖名单保存后位于新表单消息的“开始派单”按钮。单条/批量直接 callback 首先用事件消息 guard；仅明确 `SOURCE_CARD_BINDING_CONFLICT`、无任何 source binding 时，才尝试读取该消息对应的服务端 pending（包含已完成但仍在保留期内的 pending）。要求 form/chat **严格匹配**、原消息非空且不同于表单消息、kind/已有 request ID/批次匹配、完整 normalize 后的有序需求 context 相同，再凭原消息重做 SQL guard。context 用 canonical JSON 比较，抵御 JSONB 属性键序变化，**不改旧 fingerprint**。任何带 source binding 的卡、超时/网络错误、错成员/顺序/行/context 或无证据 pending 均不能借用来源。

### 全部 guard 来源审计

| 路径 | 可信消息来源及边界 |
| --- | --- |
| 直接自动单条 / 指定打开 | 先 `event.messageId`；仅匹配的名单保存 pending 可恢复原消息，不信用户来源 |
| 批量初次 / PARTIAL 重试 / 完成 replay | 同上；全 items 校验，不能凭单成员历史来源放行整批 |
| 单条 / 批量名单 form submit | `pending.original_message_id`；恢复 context 后、cleanup/初始化前校验；转交批量时保留原消息 |
| 指定名单初始化 → 新指定 form | 先 guard 原消息；创建新 form 的 pending 仍保存同一原消息；创建失败时旧名单 form 可重试 |
| 指定 form submit / 校准失败补偿 / 完成 replay | 服务端 pending 原消息；表单/context 绑定先核对，再 guard；不能信 submit 字段 |
| 无 metadata ingest 注册 | 无已发送消息，故 message=null；不允许凭上游输入伪造历史豁免 |
| queue/outbox 初次真实发送 | source binding 永久核对；legacy 依 batch guard/冻结旧 outbox origin 与后续 SQL receipt 传播，不接受 envelope 的“历史消息” |
| 名单 completed submit（仅提示已处理） | 不执行派单/名单/cleanup 副作用；独立人员状态管理非此 source 派单协议 |

本轮不新增 migration/RPC、不把新 form 自动写成永久 legacy 来源。恢复只能使用已有可信 pending 与 SQL 已证明原消息；pending 过期/清理且新消息自身也无已冻结来源时，不承诺新表单卡还能恢复。真正已冻结旧消息来源仍非过期保存。

### 本轮实际验证结果

| 范围 | 结果 |
| --- | --- |
| source + 文档 + 指定/指定回归 + 批量生命周期专项（5 个测试文件） | **177/177**，0 fail/skip；本轮新增 23 个测试，覆盖完整 callback、表单创建/名单续接、失败补偿、PARTIAL/完成 replay 及来源/context 反例 |
| 最终默认并行全仓 | **1123/1123**，0 fail/skip |
| 最终全仓串行（`--test-concurrency=1`） | **1123/1123**，0 fail/skip |
| 磁盘 PGlite SQL acceptance | **131 checks**，含真实 JS callback → SQL member guard、DB pending 创建/提交/完成、无新消息豁免时原消息合法恢复、context 篡改拒绝和关闭重开 |
| 隔离 localhost PostgreSQL 15 | **83 checks**，包含同样 callback/form SQL 验收及 4 组真实双会话竞争；观察到 4 次 advisory wait |
| lint / 工作区与暂存 whitespace check | 通过 |

两个 SQL 引擎均 `production_calls=0`。callback/form 验收的 provenance guard、pending 读写及 source/占用 RPC 是真实 SQL；Lark、表格、名单/指定 assignment 副作用是合成替身，批量完整 PARTIAL→SUCCESS 在 JS 单测中运行，不能把它说成真实飞书/生产数据库派单验收。临时 localhost PostgreSQL 已停止。没有改既有墙钟时限测试；上节高负载历史失败仍保留，不以本轮全绿推断其根因已被修复。

### 本轮需要用户重新 stage 的 7 个文件

- [dispatch-service.js](../lib/dispatch/dispatch-service.js)
- [sourceCardManifest.test.js](../tests/sourceCardManifest.test.js)
- [batchDispatch.test.js](../tests/batchDispatch.test.js)
- [specifyAssignee.test.js](../tests/specifyAssignee.test.js)
- [source-card-occupation-acceptance.mjs](../tools/source-card-occupation-acceptance.mjs)
- [中台规范](source-card-manifest-v1.md)
- [正式适配说明](ad-game-source-card-skill-adapter-v1.md)

本轮开始时已有 21 文件暂存；未改该 index，以上都是工作区后续改动，其中两份生命周期测试是本轮额外交付（总清单 23 文件）。未改 Skill/inner_skills、package/lockfile、上游 JSON/hash/HMAC 契约、40/20 限制、名单/游标/千川分池或跨卡顺序策略。未 commit/push/部署、线上迁移或真实批次 replay。真实 Skill 执行、Supabase/PostgREST、线上多实例压力与真实飞书端到端仍未验证。

## 本地交付检查点

2026-11-08：最终 23 文件暂存差异完成复核，发现的重试/占用/历史来源缺陷均已修复，本次复核范围内未发现剩余具体缺陷。相关复核测试 172/172、来源 SQL 65 项通过。全量与双会话验收结果以最新记录为准。代码与说明一起提交到本地工作分支；文档中“未提交工作区”等为实施阶段历史记录，不代表交付时 Git 状态。仍未 push、创建 PR、部署、执行线上迁移或修改 Skill。
