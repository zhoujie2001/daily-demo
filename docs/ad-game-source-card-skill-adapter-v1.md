# AD 游戏 Skill 上游适配说明：source_card_manifest v1

- **状态**：最终适配契约，随本仓库中台实现、迁移及测试一起交付；未发布上线。
- **适用范围**：上游 AD 助理/Skill 的现有批量派单 producer；只支持 `business_type=AD`、`target_category=game_agent`、`dispatch_profile=ad`，由中台解析至现有 `ad_game` scope。
- **本次边界**：只交付仓库代码与适配说明，不修改、安装或发布任何 Skill，不 commit/push/部署，不应用线上迁移、不重放真实批次。
- **配套实现规范**：[中台字段、持久机制及验证记录](source-card-manifest-v1.md)。本文是给上游适配者的正式操作入口，不引入第二套字段或 hash 协议。

## 1. 上游必须怎么改

1. 取到拆分前的完整、有序需求列表后，一次性冻结 source ID、目标 chat、profile/category、全部片的 batch ID 和有序 request ID。
2. 按原顺序每 20 条切一片。78 条为四个独立 payload：`20/20/20/18`；21 条为 `20/1`；20 条为单片 `20`。
3. 在任何一片投递前生成同一份完整 `source_card_manifest`，计算一次 hash，并将 manifest、各片完整 payload 及投递状态保存到上游可恢复的持久记录。
4. 每个 payload 仅包含当前片的 `items`，但都携带完整 manifest 和当前 `source_card_chunk_index`。不能先发第一片、再按后续查询结果补清单。
5. 重试读取冻结记录，不重新查询并重排原批次、不换 ID、不重新切片、不删除 metadata。
6. `/send` 或 `automation-send` 的现有认证/传输格式保持不变。manifest hash 不是鉴权凭据；`/send` 的完整请求 HMAC 必须包含新增 metadata。

**不要把 78 条合成一个 ingest，也不要扩大中台单次 40 条限制。** 新模式每个 payload 仍至多 20 条；完整清单结构上限为 1000 条，且仍受入口现有请求字节预算限制。

## 2. 最终字段（无别名、无自动补齐）

### 2.1 当前投递 envelope

| 字段 | 最终规则 |
| --- | --- |
| `chat_id` | 原有目标 chat；必须与 manifest 逐字相等，并通过原有群绑定 |
| `dispatch_profile` | 建议明确传 `ad`；若提供，必须与 manifest 相等 |
| `batch_id` | 当前片稳定 batch ID，必须逐字等于当前 chunk 的值 |
| `source_card_manifest` | 本文定义的完整对象；每片相同 |
| `source_card_chunk_index` | 1-based 整数，必须指向当前 chunk |
| `items` | 仅当前片的实际需求；有序 ID 必须与当前 chunk 完全匹配 |

新模式的两个 `source_card_*` envelope 字段必须一起提供；缺字段、null、未知 `source_card_*` 字段或未知版本，不能作为旧模式忽略。

### 2.2 完整 manifest

manifest 只能有以下 **9** 个字段；chunk 只能有以下 **4** 个字段：

| manifest 字段 | 类型 / 值 |
| --- | --- |
| `version` | 整数 `1` |
| `source_batch_id` | 原始 source 的全局稳定 ID，`[A-Za-z0-9_-]{1,128}` |
| `chat_id` | 字符串，`oc_` 后接 1–128 个字母/数字/下划线 |
| `dispatch_profile` | 字符串 `ad` |
| `target_category` | 字符串 `game_agent` |
| `total_item_count` | 原 source 总数，整数 1–1000 |
| `chunk_count` | 整数，等于 `(total_item_count + 19) // 20` |
| `chunks` | 全部分片的有序数组，不能漏掉尚未投递片 |
| `manifest_hash` | SHA-256 的 64 位小写 hex |

每个 chunk 的四个字段为 `chunk_index`（序号）、`batch_id`（稳定片 ID）、`item_count`（实际片数量）、`request_ids`（完整有序 ID 数组）；实际 `request_ids` 必须有 `item_count` 个 ID。

- chunk 序号严格为 1…Y，数组顺序相同；batch ID 使用 `[A-Za-z0-9_-]{1,128}`，清单内无重复。
- 非末片固定 20，末片是剩余数量。各片 count 相加恰好等于 total。
- 每个 request ID 是字符串 `[A-Za-z0-9_-]{1,64}`，source 内无任何片内/跨片重复。
- 当前 `items` 的 ID 按原序逐项、逐字匹配当前 `request_ids`。不得只比较集合、转数字、trim、排序或去重后再比较。
- item 必须带原有合法表格目标，`business_type=AD`、`target_category=game_agent`；若提供 profile/source ID，也必须与 manifest 相同。
- 多个游戏 `reject_reason_codes` 是无关来源信息，不改变分片、计数或 manifest hash；禁止混入千川 `decision_policy_version` 等决策字段。
- 不允许额外 `source_card_binding` 接入字段；紧凑 binding 是中台生成的 callback 引用，不由上游自行拼装。

## 3. 完整可校验 JSON 示例

下面是**合成假数据**：21 条、第 2/2 张。其完整 manifest 包含第一片的 20 个 ID 和第二片的 1 个 ID；hash 已按第 4 节算法核对。不要向真实入口发送这个示例。

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

第一片使用完全相同的 manifest/hash，顶层 batch 为 `game_source_21_card_1`，index 为 1，items 为原冻结记录里的 `game_1`…`game_20`。78 条的四片同理。20 条使用单片完整清单，卡片显示第 1/1 张。

## 4. 精确 canonical JSON / SHA-256：Python 标准库实现

### 4.1 字节级定义

- hash 输入只包含 manifest 删除 `manifest_hash` 后的其余 **8** 个字段，不是 envelope、当前 items 或 callback binding。
- 递归排序对象键；按 JavaScript 字符串的 UTF-16 code unit 顺序，与中台 `Object.keys(...).sort()` 一致。合法 v1 manifest 的键和值均是 ASCII，排序无歧义。
- 数组保持原序；对象/数组分隔符为 `,`、`:`，无空格、缩进或末尾换行。
- 字符串采用 JSON 编码，不使用 `ensure_ascii=True`；不做 Unicode NFC/NFKC、trim 或大小写变换。
- 合法 v1 manifest 的数字均为安全整数；Python 实现拒绝 float、NaN/Infinity、超出 JS 安全整数范围的整数，避免与 JS 数字序列化不一致。`bool` 不能作为整数计数字段。
- 最终字符串严格 UTF-8 编码，SHA-256 输出小写 hex。不能对打印出来带换行的文本、Base64、完整 payload 或二次 JSON 字符串求 hash。
- 下面实现精确覆盖 v1 合法输入域；不是通用浮点 JSON/JCS 实现，也不宣称能替代所有旧请求体的 HMAC canonicalizer。孤立 surrogate 不是合法 v1 字符串，显式拒绝。

```python
import hashlib
import json
import re

MAX_SAFE_INTEGER = (1 << 53) - 1
MANIFEST_KEYS = {
    "version", "source_batch_id", "chat_id", "dispatch_profile",
    "target_category", "total_item_count", "chunk_count", "chunks",
    "manifest_hash",
}
CHUNK_KEYS = {"chunk_index", "batch_id", "item_count", "request_ids"}
ID_RE = re.compile(r"[A-Za-z0-9_-]{1,128}", re.ASCII)
REQUEST_RE = re.compile(r"[A-Za-z0-9_-]{1,64}", re.ASCII)
CHAT_RE = re.compile(r"oc_[A-Za-z0-9_]{1,128}", re.ASCII)
HASH_RE = re.compile(r"[a-f0-9]{64}", re.ASCII)


def _json_string(value):
    # Reject surrogate code points; v1 manifest strings are ASCII anyway.
    if any(0xD800 <= ord(ch) <= 0xDFFF for ch in value):
        raise ValueError("surrogate code point is outside the v1 input domain")
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"),
                      allow_nan=False)


def canonical_json(value):
    if value is None:
        return "null"
    if type(value) is bool:
        return "true" if value else "false"
    if type(value) is int:
        if abs(value) > MAX_SAFE_INTEGER:
            raise ValueError("integer exceeds JavaScript safe integer range")
        return str(value)
    if type(value) is str:
        return _json_string(value)
    if type(value) is list:
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    if type(value) is dict:
        if any(type(k) is not str for k in value):
            raise TypeError("JSON object keys must be strings")
        keys = sorted(value, key=lambda k: k.encode("utf-16-be"))
        return "{" + ",".join(
            _json_string(k) + ":" + canonical_json(value[k]) for k in keys
        ) + "}"
    raise TypeError("unsupported v1 JSON type (floats are not allowed)")


def manifest_hash(manifest):
    if type(manifest) is not dict:
        raise TypeError("manifest must be a dict")
    # Exclude exactly this field; do NOT silently remove other/unknown keys.
    content = {k: v for k, v in manifest.items() if k != "manifest_hash"}
    return hashlib.sha256(canonical_json(content).encode("utf-8")).hexdigest()


def _matches(pattern, value):
    return type(value) is str and pattern.fullmatch(value) is not None


def validate_manifest(manifest):
    if type(manifest) is not dict or set(manifest) != MANIFEST_KEYS:
        raise ValueError("unknown or missing manifest field")
    if type(manifest["version"]) is not int or manifest["version"] != 1:
        raise ValueError("unsupported version")
    if not _matches(ID_RE, manifest["source_batch_id"]):
        raise ValueError("invalid source_batch_id")
    if not _matches(CHAT_RE, manifest["chat_id"]):
        raise ValueError("invalid chat_id")
    if manifest["dispatch_profile"] != "ad" or manifest["target_category"] != "game_agent":
        raise ValueError("unsupported binding")
    total, count = manifest["total_item_count"], manifest["chunk_count"]
    if type(total) is not int or not 1 <= total <= 1000:
        raise ValueError("invalid total_item_count")
    if type(count) is not int or count != (total + 19) // 20:
        raise ValueError("invalid chunk_count")
    chunks = manifest["chunks"]
    if type(chunks) is not list or len(chunks) != count:
        raise ValueError("incomplete chunks")
    batches, requests = set(), set()
    for index, chunk in enumerate(chunks, start=1):
        if type(chunk) is not dict or set(chunk) != CHUNK_KEYS:
            raise ValueError("unknown or missing chunk field")
        expected = min(20, total - (index - 1) * 20)
        if type(chunk["chunk_index"]) is not int or chunk["chunk_index"] != index:
            raise ValueError("invalid chunk_index/order")
        if type(chunk["item_count"]) is not int or chunk["item_count"] != expected:
            raise ValueError("invalid item_count")
        batch = chunk["batch_id"]
        if not _matches(ID_RE, batch) or batch in batches:
            raise ValueError("invalid/duplicate batch_id")
        batches.add(batch)
        ids = chunk["request_ids"]
        if type(ids) is not list or len(ids) != expected:
            raise ValueError("invalid request_ids count")
        for request_id in ids:
            if not _matches(REQUEST_RE, request_id) or request_id in requests:
                raise ValueError("invalid/duplicate request_id")
            requests.add(request_id)
    if len(requests) != total:
        raise ValueError("total mismatch")
    if not _matches(HASH_RE, manifest["manifest_hash"]):
        raise ValueError("invalid hash encoding")
    if manifest["manifest_hash"] != manifest_hash(manifest):
        raise ValueError("hash mismatch")
    return manifest
```

生成时先构造 8 个字段的 manifest，再执行：

```python
manifest["manifest_hash"] = manifest_hash(manifest)
validate_manifest(manifest)
# payload 是从冻结持久记录中读取的当前片，不是重新查询构造的需求集合。
index = payload["source_card_chunk_index"]
if type(index) is not int or not 1 <= index <= manifest["chunk_count"]:
    raise ValueError("invalid current index")
chunk = manifest["chunks"][index - 1]
if payload["chat_id"] != manifest["chat_id"]:
    raise ValueError("chat drift")
if payload["batch_id"] != chunk["batch_id"]:
    raise ValueError("batch drift")
if [item["request_id"] for item in payload["items"]] != chunk["request_ids"]:
    raise ValueError("current item IDs/order mismatch")
```

中台仍执行权威校验（含原有表格/profile binding），上面的上游校验不是权限或持久绑定替代品。合法示例的 `manifest_hash` 必须严格为：

```text
96f1ef5c3a4a438322c87a6ab5c815aaba276784adb0de60e37817c84cf6b131
```

## 5. 冻结、恢复与重试规则

### 5.1 冻结边界

- `source_batch_id` 全局稳定，不按 chat、日期、profile 建第二个命名空间；重启、跨日、重试均不得修改。
- 每片 batch ID、source/chat/profile/category、count、完整清单及数组顺序在首次发送前全部冻结。
- 中台首片注册即用 SQL 事务预留全部 chunk，包含尚未发送片。已有 source 比较完整 jsonb，不只比较 hash；同 batch 不能换 source，同 source/ordinal 不能换 batch 或 ID 列表。
- source 事实没有七天自动过期；当前 ingest/handoff 状态保留期并不意味着允许重新派同批。不要利用旧状态过期、改名或跨日来重放。
- 上游还必须冻结每片的完整业务/表格内容以便原样重试。manifest 本身只冻结完整 ID/分片/batch/范围绑定，不是整份业务快照；当前片的业务内容由中台原有持久 fingerprint 约束。
- 不加跨卡点击顺序门禁。投递/点击某片不要求前一片完成；名单与游标仍由既有 `ad_game` 派单机制管理，不得人为重置。

### 5.2 上游持久恢复记录至少保存

`source_batch_id`、完整 manifest/hash、每片完整 payload、每片 batch/index、最后一次响应、operation ID（若返回）、message receipt（若返回）、未知接受/已发送/终态失败等状态。不得仅保存生成器内存或 ID 集合。接入端使用中台已有入口，不能绕过中台直接发飞书卡或创建另一条 queue。

### 5.3 状态处理

| 情况 | 上游处理 |
| --- | --- |
| 本地校验失败 / 中台明确参数、hash、binding 冲突 | 停止，不换 source/batch、删 metadata 或重签改过的清单绕过；修正适配代码并人工确认原冻结记录 |
| `SOURCE_CARD_STORE_REQUIRED` / migration 缺失 | 停止新模式发送，先完成迁移/服务上线；不能退成无 metadata 同批投递 |
| `DRY_RUN_OK` | 只是参数校验；没有登记 source、没有 queue、没有真实卡片，也没有验证 DB readiness |
| `QUEUED` / 已接受、处理中 | 保存响应，按当前片 chat+batch 查询状态；不是已经发送或已经完成派单 |
| `SENT` 且有真实 message receipt | 标记该片投递完成，不重新派送；不等同于用户已点击卡片或业务派单已完成 |
| 网络中断、超时、`accepted_unknown`、`ACCEPTED_UNKNOWN` | 不能解释为“没发送”。查询同片状态，交由现有 handoff/outbox reconciliation；如确需重试接入请求，只能使用原冻结 payload 与原 batch，不能直接重发卡片/queue |
| `NOT_FOUND` | 不是排队成功，也不足以推断历史批次从未发送；核对上游记录、超时证据及状态保留期，再决定是否原样提交。不得因查询缺失生成新 source |
| `DEAD` / `RECONCILIATION_DEAD` / dead-letter 终态 | 人工排查与既有受控恢复路径，不用新 ID 强制重放 |
| 卡片部分派单失败 | 从原卡的继续/重试按钮处理原批；不要把失败子集重新组合为新 payload 冒充整片 |

状态查询使用**当前 chunk 的 batch ID**，不是 source ID：

```json
{"chat_id":"oc_56debf24fa90e17ea92257c20454d742","batch_id":"game_source_21_card_2"}
```

`/api/dispatch/status` 沿用既有认证。四片逐片跟踪，不假设 source ID 能自动聚合四片。响应 `chunks[]` 的原有 `chunk_index/chunk_count` 是单次 payload 的中台内部拆卡；新增 `source_card_binding.chunk_index/chunk_count` 才是 source 级 X/Y。

业务冻结内容必须不变，但认证时间戳/HMAC header 在每次网络请求时可按现有协议重新生成；不要使用过期签名。不要把重新生成认证误当成重新生成 source 或业务 batch。

## 6. 迁移及上线顺序（本次只说明，不执行）

**推荐顺序：DB additive migration → 中台代码与所有消费/回调路径 → 隔离验收 → 上游启用 metadata。**

1. **发布前评审**：核对本文、当前工作区代码和迁移是同一个项目版本；确认上游尚未发送新 metadata。盘点旧中台版本、queue/outbox/reconciliation/callback 实例，避免混用只渲染序号或会丢 metadata 的版本。
2. **先应用 DB 迁移**：[202611080001_source_card_manifest.sql](../supabase/migrations/202611080001_source_card_manifest.sql)。先确认完整 pending schema 与 `db/migrations/20261023_dispatch_ingest_root.sql` 已就绪。新迁移创建 manifest/chunk/legacy-message 三表、四个业务 RPC，并在原 pending 表增加 INSERT/UPDATE trigger 以协调旧 root/ingest 竞争；不替换名单/游标/千川旧 RPC，不执行真实批次回填/重放。需 PostgreSQL 内置 `sha256(bytea)` 与事务 advisory lock；无需 pgcrypto。
3. **核对权限与 RPC readiness**：三表 RLS + FORCE RLS；API 角色不能直接 INSERT/UPDATE/DELETE；service role 可执行四个业务 RPC，anon/authenticated 不可执行；内部 canonical helper/trigger 不暴露给 API。确认 PostgREST 已加载新增 RPC（必要时按平台运维规范刷新 schema cache），并确认 pending trigger 已安装。不要仅凭 dry_run 判断迁移已就绪。
4. **上线完整中台版本**：ingest 的 send/automation-send/pull-base，queue/outbox/reconciliation 和 callback/result-card 路径一起升级；确认有新 manifest 持久注册、consumer/callback 绑定校验，不能只升级渲染器。中台可在 migration 未就绪时拒绝新模式，但不能把这种拒绝作为上游降级依据。
5. **隔离环境验收**：先运行仓库单测、lint、SQL acceptance；再由获授权的发布流程做隔离 Supabase/PostgREST 和测试聊天卡片验收（20/21/78、任意卡顺序、metadata 保留、跨 source/chat/ordinal 冲突）。使用全新合成测试 ID，禁止真实批次 replay、清理/重置生产游标。本文不视为授权本助手执行线上操作。
6. **最后启用上游适配**：经上线负责人确认第 2–5 步后，上游采用本文 producer 规则，先持久冻结再投递。保留原无 metadata 旧批次的既有恢复方式，不将其伪造为新模式迁移数据。
7. **观察与回退**：逐片看接受状态、最终 message receipt、binding conflict、migration 缺失和 reconciliation 错误。上游回退只暂停新 source 生成；已登记新 source 不允许删 metadata 降级。已有新模式任务未清空前不要回滚至丢 metadata 的旧 consumer/callback。保留 DB additive 表/事实，不通过删表、改绑或重置游标“回滚”。

四个 service-role RPC：`bess_register_source_card_manifest(jsonb,jsonb)`、`bess_assert_source_card_binding(jsonb,jsonb,boolean)`、`bess_assert_legacy_source_card_batch(text)`、`bess_assert_legacy_source_card_members(text,jsonb,text)`。注册第二参数为**中台内部**当前片 root reservation，真实投递入口始终提供；上游 envelope 不增加这个参数。批次与业务成员 guard 分别阻止按 batch 及无 batch 的单条降级；旧 schema 只有明确 missing RPC（PGRST202/42883）的 legacy guard 兼容，网络/超时不能静默绕过；新模式没有该兼容降级。

## 7. 单个项目交付及可复现验证

项目根：[daily-demo-review-snapshot](../)。代码、迁移、本文、[中台规范](source-card-manifest-v1.md)、单测和 SQL acceptance 均在同一个仓库工作区，不另发独立 Skill 或补丁包。当前分支为 `aime/1794109957-source-card-manifest`，保留未提交修改。

```sh
node --test tests/sourceCardManifest.test.js tests/sourceCardSkillAdapter.test.js
node --test
npm run lint
git diff --check
node tools/source-card-sql-acceptance.mjs /path/to/pglite/dist/index.js
```

[文档契约测试](../tests/sourceCardSkillAdapter.test.js)直接提取本文第 3 节 JSON 和第 4 节 Python 主实现，运行 Python 并与中台 JS 比较 canonical/hash，避免只有文字宣称“一致”。PGlite 依赖在临时目录安装，不修改项目 package/lockfile。

### 已验证与尚未验证

最终运行计数以本文末尾验证记录及交付回报为准，不把未来上线验收步骤当作已执行：

- 已有本地验证：78/21/20 完整清单、count/index/order/duplicate/hash/profile/chat/source drift、旧卡兼容、无关多 CODE、callback/result binding、SQL 权限和磁盘 DB 关闭重开后绑定存续。
- Python/JSON 文档示例及与中台 JS 的字节级一致性，由上述文档契约测试执行。
- **未验证**：实际 Skill 运行环境与其持久记录、真实 Supabase/PostgREST schema cache/角色部署、线上多实例高并发/锁压力、线上 queue/reconciliation 时序、真实飞书 Card 2.0 的大小及回调/更新、生产端到端效果、任意最大 ID 长度下的请求字节预算。隔离 PostgreSQL 的四组真实双会话竞争已补验，不等同于线上压力验收。
- **未执行**：修改 Skill、commit/push/部署、应用线上迁移、发真实卡片、真实批次重放、名单或游标重置、千川分池改动、跨卡点击门禁。

### 正式适配说明初次补充的历史测试记录（P2 修复前）

2026-11-08，当前未提交工作区：

| 验证命令 / 范围 | 实际结果 |
| --- | --- |
| `node --test tests/sourceCardManifest.test.js tests/sourceCardSkillAdapter.test.js` | 46/46 通过（原 43 项 + 文档契约 3 项），0 fail、0 skipped |
| `node --test`（默认并行全仓复核） | 复核一轮为 1091/1092 通过，1 fail、0 skipped：既有 `tests/supabaseDispatchStore.test.js:460` 的超时诊断断言失败；不能报告默认全仓全绿 |
| `node --test --test-name-pattern="Supabase 超时错误保留操作和时延诊断字段" tests/supabaseDispatchStore.test.js` | 该项单独运行 1/1 通过 |
| `node --test --test-concurrency=1` | 全仓串行 1092/1092 通过，0 fail、0 skipped |
| `node tools/source-card-sql-acceptance.mjs /tmp/source-card-sql-acceptance/node_modules/@electric-sql/pglite/dist/index.js` | 57 项通过，磁盘 DB 关闭重开验证通过，production_calls=0 |
| `npm run lint` | 通过 |
| `git diff --check` | 通过 |

默认并行失败的断言要求 `DISPATCH_DB_TIMEOUT`、每次 20ms 的超时诊断及两次尝试；实际该轮收到的错误未满足断言。单项和串行均通过，表现与并行时序负载相关，但**没有完成根因证明或修改该既有测试/运行时代码**。这个差异是已知验证限制，不属于已修复事项。

运行文档契约测试需要本机/CI 提供 `python3`（本次使用沙箱 Python 3）；PGlite 依赖使用临时目录。本次没有新增或修改任何项目 dependencies/lockfile，也没有在用户本机执行测试或修改 Skill。

## 8. P2 修复后的最终契约与复核

### 上游协议不变

JSON 九字段 manifest、四字段 chunk、两个 envelope 字段、递归 canonical/hash 和第 4 节 Python 实现均不变；完整示例 hash 仍为 `96f1ef5c3a4a438322c87a6ab5c815aaba276784adb0de60e37817c84cf6b131`。等价对象键重排不会改变 ingest/callback 幂等，数组顺序仍严格冻结。中台统一 binding 属性顺序为 `version, source_batch_id, chat_id, dispatch_profile, target_category, total_item_count, chunk_count, manifest_hash, chunk_index, batch_id`，并在 fingerprint 边界规范化数据库恢复的 binding。

### 不能把既有旧批次升级占用成 source

首次新模式投递在一个 SQL 事务内：获取完整 batch 集合的排序锁 → 检查现有 root/ingest/chunkPlan 持久占用 → 冻结完整 source/chunks → 固定当前片 fingerprint → 调用真实旧 root reservation CAS。旧占用冲突或 root CAS 冲突会回滚整个注册，不留下封死旧链路的永久 chunk。原 pending 写入 trigger 让尚未升级的旧 RPC/REST 写入也受同一批次锁约束。两方向并发均受数据库保护，不依赖进程缓存。

上游遇到 `SOURCE_CARD_BINDING_CONFLICT` / 409 应停止并核对原记录；不得换 batch、改 source 或删除 metadata 规避。原本无 metadata 的旧任务继续走原恢复流程，不要伪装成新 source。

### 单条旧卡的合理历史边界

缺 binding/batch 不是豁免条件。中台用 `(chat_id, dispatch_profile, target_category, request_id)` 持久识别 source 成员，在 cleanup、名单读取/初始化、Lark 回复、pending 写入和游标操作之前阻止降级。表单恢复也校验持久身份。

同一业务身份的真正历史旧卡凭**持久来源消息**恢复，而非凭裸 request ID：首次 source 注册冻结已有 AD/game pending/card/outbox 的 legacy origin；旧 outbox 延迟发送时记录真实 message receipt；这些来源事实在 pending 清理后仍保留。无关群/profile/category 和未登记需求不误伤。没有持久证据且同一身份已登记 source 的所谓旧卡会安全拒绝；不承诺未知历史卡自动恢复。启用前需盘点真实旧任务来源及所有 consumer/callback 版本，不能跳过迁移 readiness。

### 首批三个 P2 修复的历史测试结果（未覆盖后续消息来源遗漏）

| 验证 | 结果 |
| --- | --- |
| source + JSON/Python/JS 文档专项 | **54/54**，0 fail/skip |
| 默认并行全仓，独立复跑 | **1100/1100**，0 fail/skip |
| 全仓串行 | **1100/1100**，0 fail/skip |
| 较高负载一轮默认全仓（与串行和 SQL 任务同时运行） | **1099/1100**，既有 `supabaseDispatchStore.test.js:496` 的 `<250ms` 墙钟断言失败，测试 duration 349.5ms |
| PGlite 磁盘 SQL acceptance | **113 checks**，真实旧 root/handoff/outbox、原子 rollback、历史/延迟 outbox、RLS/权限、关闭重开持久性 |
| 隔离 localhost PostgreSQL 15 | **65 checks**；4 组真实双会话竞争（root/handoff × 旧先/新先），观察到 4 次 advisory wait，败方拒绝无污染 |
| lint / diff check | 通过 |

不隐去首轮高负载失败，也不把独立重跑全绿解释为已经证明并修复既有墙钟测试的根因；未修改该超时测试或其运行时代码。SQL 两个引擎均 `production_calls=0`。

可复跑真实双会话验收：

```sh
node tools/source-card-postgres-acceptance.mjs /path/to/pg/lib/index.js 55439
```

需先自行启动**隔离 localhost PostgreSQL**（示例端口不是生产地址）。脚本建立/删除隔离测试数据库，不使用生产凭据。PGlite/pg 依赖安装在临时目录，不改项目 package/lockfile。迁移还未应用线上；真实 Skill、Supabase/PostgREST、线上实例压力、真实飞书端到端仍未验证。

最终完整 **23 个文件清单**见[中台规范](source-card-manifest-v1.md#最终项目文件清单23-个)。本轮仅改工作区，不操作暂存区；需重新 stage 的文件见后续消息来源修复记录。没有 commit/push/部署。
## 后续 P2：旧卡与新表单的可信原消息

上游无需增加任何字段：JSON、canonical/hash Python、冻结重试规则及迁移上线顺序不变。中台修复批量 callback 遗漏消息 ID，以及指定人员新 form submit 错用新表单消息的两个兼容问题。

- 完整旧 batch callback、PARTIAL 重试和完成 replay 先用可信事件消息作持久来源核对。
- 指定人员新表单提交使用按该表单查出的**服务端 pending.original_message_id**；表单、群聊、需求和 context kind 绑定先核对，再 guard，再副作用。用户 action/form 中的来源、需求或群聊字段不能替代 pending。名单初始化后继续创建指定表单、创建失败重试、写入后校准失败补偿以及已完成 replay 都保留同一原消息。
- 名单保存后的“开始派单”位于新消息。只有无 source binding、事件来源明确冲突且服务端 pending 的 form/chat/已有 request ID/kind/批次及完整有序 normalize context 匹配，才以 pending 原消息重新走 SQL guard。context 用 canonical JSON 比较，不能依赖 JSONB 键序；不改变旧 fingerprint。超时/网络错误不触发恢复，source 卡不能走此分支。
- 新表单消息不自动获得永久历史豁免；没有已证明原消息、无 pending/已超保留期或错成员/context/顺序都安全拒绝。不能用上游自己声明的“旧消息 ID”修补缺失证据。

所有入口/队列/名单恢复/直接 callback/指定 submit 来源审计和 23 文件交付清单见[中台规范的后续 P2 记录](source-card-manifest-v1.md#后续-p2历史消息来源全生命周期修复)。本轮新增 23 个测试，不把上一轮 1100 全绿视为已经覆盖本次遗漏。

| 本轮验证 | 结果 |
| --- | --- |
| source/文档/指定及批量生命周期专项（5 文件） | **177/177**，0 fail/skip |
| 最终默认并行全仓 | **1123/1123**，0 fail/skip |
| 最终全仓串行 | **1123/1123**，0 fail/skip |
| 磁盘 PGlite SQL acceptance | **131 checks** |
| 隔离 localhost PostgreSQL 15 | **83 checks**；4 组真实双会话竞争，4 次 advisory wait |
| lint / 工作区与暂存 diff whitespace | 通过 |

SQL 两引擎均 `production_calls=0`：真实 JS callback 使用真实 SQL provenance guard 和 pending；Lark/表格/名单/指定 assignment 副作用为替身。完整批量 PARTIAL→SUCCESS 是 JS 回归测试，不是生产派单。临时 PostgreSQL 已停止；真实 Skill、Supabase/PostgREST、生产多实例压力和飞书端到端未验证。旧高负载墙钟测试差异保留在上一节，不宣称根因已修复。

本轮只改工作区，暂存区不动；需重新 stage 的 7 文件见中台规范。未改 Skill/inner_skills、未 commit/push/部署、生产迁移或真实批次 replay。
