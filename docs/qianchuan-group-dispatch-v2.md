# 千川大盘分组派单 v2：候选实现与接入契约

本变更仅针对现行 Vercel 中台的千川大盘。未发布、未执行远端迁移、未操作真实需求。

## 2026-10-30 契约更正（用户确认）

“活动规则前后不一致”的正确CODE ID为 **1000676**，替代此前误写的1005004；不是同时接受两个代码。
新契约使用 `contains_code_1000676`、`contains_1000676` / `without_1000676` 和
`decision_policy_version=code-membership-1000676/v2`。旧名称不得继续承载新语义。
中台候选现已实现新契约及回调字段往返校验；上游已上传Skill未修改，生产状态另见发布记录。
为支持中台先部署，旧 `code-membership-1005004/v1` 以独立版本保留原语义，新策略绝不把1005004当作1000676。
禁止同一请求混用两套标记字段，禁止同一source在新旧版本间切换。
旧策略批次、冻结快照、哈希及人员决定保持不可变，不对历史批次原地换码、改哈希或重派。
同一source不得切换策略；未受理的新业务批次才可按新契约生成，新旧能力切流必须另行验收。

## 三种身份不能混用

| 字段 | 含义 |
| --- | --- |
| `source_batch_id` | 分桶、分片前完整业务批次；所有投递共用 |
| `batch_id` | 单次投递身份，例如 `20261030-B-contains_1000676-01`；最多20条 |
| `decision_group` | 投递分桶，只允许 `contains_1000676` / `without_1000676`，不是人员组 |
| `assignmentGroup` | 中台依据完整原顺序计算的人员决策组，客户端无权指定 |

`reject_reason_codes` 是去空、去重、排序后的字符串集合；精确包含 `"1000676"` 才命中特殊规则。
`contains_code_1000676` 必须等于该精确成员判断。`1005004`、`1000567`、`10006760` 均不因此命中。
拒绝理由文案不参与判断。审核对象 ID 只接受字符串，数字即使看起来正确也拒绝，避免精度损失。
本修订契约的上游策略版本为 `code-membership-1000676/v2`；人员分组算法仍遵循下述优先级。

## 必须补充的上游字段

用户提供的现行 payload 缺少完整原顺序，**不能仅凭分桶后的两条需求恢复相邻关系**。

每个投递增加 `decision_snapshot` 数组：

1. 在分桶/分片之前，冻结完整待派单需求列表，保留原顺序；不是把所有原始采集记录都纳入。
2. 每个成员采用与 `items[]` 相同的需求结构，包含需求ID、对象ID、代码集合、标记、分桶、业务类型、表格定位和字段契约。
3. 每个投递 `items` 最多20条；同一原批次的所有投递携带**完全相同**的完整 `decision_snapshot`。
4. 对冻结后的完整数组计算 canonical JSON SHA-256，作为 `decision_snapshot_hash`；所有投递及重试沿用同一数组、同一哈希、同一 `source_batch_id` 和策略。批次级 `decision_group` 若提供，必须与本次全部 item 一致。
5. `decision_snapshot` 当前上限1000条，这是完整源清单的保护上限，不是每卡容量。

简化结构：

```json
{
  "batch_id": "20261030-B-contains_1000676-01",
  "source_batch_id": "<原始批次稳定ID>",
  "decision_policy_version": "code-membership-1000676/v2",
  "decision_group": "contains_1000676",
  "decision_snapshot_hash": "<完整有序decision_snapshot的64位小写SHA256>",
  "decision_snapshot": ["完整有序成员对象，结构同items，不是字符串或ID列表"],
  "items": ["本次投递的完整成员对象，不超过20条"]
}
```

上述数组字符串仅解释位置，不是可执行请求示例。实际必须放完整成员对象，并保留现有 chat、sheet、title、time_segment 等字段。

中台对实际收到的完整 `decision_snapshot` 复算 `decision_snapshot_hash`，不一致即零持久化、零入队拒绝。
数据库同时保存完整原始快照和规范化清单，不只是保存哈希。另对完整快照、规范化清单、源ID、策略及服务器算法生成 `decision_manifest_hash`。
后者与 `source_position` 自动加入卡片引用；完整清单只存数据库，不复制进每个按钮回调。
同源ID的清单、日期、策略、任何哈希或分组变化都会被拒绝；不能通过新投递ID静默替换旧计划。

Canonical JSON规则：递归按对象键排序、无额外空白、UTF-8、保留Unicode字符；所有数组保持原顺序。
当前DTO仅允许ASCII字段名、有限安全整数（例如行号）及合法JSON值；审核对象ID必须为字符串。
先完成ID字符串化、代码集合规范化和稳定字段准备，再冻结快照。哈希之前不要对需求数组排序。
快照成员不得携带自身哈希、`decision_manifest_hash`、分片`batch_id`、`operation_id`、`message_id`、签名、密钥或重试运行字段。

Python对齐写法：

```python
canonical = json.dumps(decision_snapshot, ensure_ascii=False, sort_keys=True,
                       separators=(",", ":"), allow_nan=False)
decision_snapshot_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
```

不要将这些JSON序列化参数替换为带缩进或默认ASCII转义的版本。这里是本契约限定的canonical格式，不宣称支持任意浮点JSON的RFC8785实现。

## 人员策略

以完整清单原顺序执行，所有引用均限定同一 source：

1. 非空审核对象ID已出现：复用该对象首次决定的组，优先级最高，不再消耗轮转位置。
2. 单条不相邻的 `1000676`：复用完整原顺序中前一条的最终组；若位于第一条，正常取下一位。
3. 连续两条及以上 `1000676`：本段尚未被同对象规则绑定的需求，共用一个新的轮转位置。
4. 普通新对象正常轮转。空对象ID不相互合并。
5. 同对象规则与连续规则冲突时同对象优先，不把两个已有组强行合并。

例：`普通a、普通b、特殊c、普通b、特殊d、特殊e、普通f` → `甲、乙、乙、乙、丙、丙、丁`。
这些记录随后即使被分到两个代码桶，人员关系也不改变。

## 事务与写表

首次点击任意一张卡时：

1. 从持久源清单读取完整原批次，用一次共享完整表快照按需求ID重定位。
2. 读取同 day/scope 的数据库一致快照，检查人工负责人。
3. fenced/CAS RPC 原子冻结**整批组级人员计划并预留全部所需轮转位置**。
4. 只对当前投递成员创建逐需求 assignment，`assignment_seq` 因此按实际落账顺序，而非原始清单位置递增。
5. 当前卡最多20行，写前重读需求ID与负责人，已有同人值不写，异人值拒绝。
6. 一次批量写入当前卡空行，然后真实回读，再提交确认回执。

因此，先点击第二张卡也只写第二张，但预留的是完整原批次计划；后续卡不再占用轮转。
未点击的卡仍占用已预留轮转位置，不能悄悄取消后“退游标”。取消/改派需要独立受控对账，不在本候选内。

人工已填人员在名单中时保留，并绑定同组；同组已有不同人工值、人员不在名单或计划人员已离岗则暂停，零覆盖。
只在源计划首次创建时校准锚点，复用计划不再次校准。
**飞书最后一次GET到PUT之间仍无原子CAS；本候选不宣称消除此窗口。**

RPC回执丢失、PUT结果不明、确认落库失败：持久保留 pending 边界。其他卡（包括同需求另一投递身份）不能接管写入。
原卡恢复先回读，只补缺失回执或原决定的未完成写入，不重新选人。
行移动恢复时，原assignment上下文和冻结快照保持不变；当前claim在源表write_bindings中绑定最新定位行。
确认RPC同时校验定位行、claim token和writer；旧行回执或旧claim不能确认新尝试。
已经权威确认后被人工清空的格子不自动重写，转待对账。
没有完成确认的失败/暂停不显示为成功，也不授权上游推进水位线。

## 边界与兼容

- 仅 `target_category=qianchuan`、千川业务、服务端派生 `default/test_default + forward` 可进入此分支。
- 本地、AD、游戏、应急、无 v2 元数据的旧千川沿用原分支；未提高它们的容量上限。
- `/send`、`automation-send`、Base Pull 共用同一清单注册与校验；dry-run 零持久化、零发布。
- 新路径缺RPC时 fail-closed，不回退到逐条普通轮转。
- v2 单条自动/旧指定人员入口拒绝绕过组账本；当前仅完成批量自动入口，**未实现组级指定/改派协议**。
- 不能改写已发送旧卡，也不能自动重放今天的失败批次。

## 数据库与发布顺序（尚未执行）

新增迁移由 Supabase CLI 生成：
`supabase/migrations/20261026075901_qianchuan_group_decisions.sql`。
本仓库既有迁移在 `db/migrations`；不要只扫描旧目录而漏掉此文件，也不要对现生产库直接执行完整 `supabase db push`。

1. 在隔离完整现行基线上执行此增量迁移，核验真实 Supabase/PostgREST、schema reload 和多会话并发。
2. 校验新表 RLS/FORCE RLS、匿名零权限、仅service_role可调用三个公开RPC、内部fence helper不可直接调用。
3. 用测试群、测试表完成25条跨卡、两代码桶乱序点击、人工修改、写回中断和名单变更的真实验收。
4. 全量回归通过、上游补齐完整有序清单、PR审批后，才申请生产数据库迁移与代码发布。
5. 生产数据库先迁移并只读核验；再发布中台；最后灰度上游新契约，不自动重派任何旧单。

回滚是停止新v2投递并撤销新RPC执行权；**保留全部计划、assignment、回执、审计及已预留游标**，不得回退游标或删除状态后重发。

## 本地验收入口

```powershell
node --test tests/qianchuanGroupPolicy.test.js tests/qianchuanTransport.test.js
node tools/qianchuan-sql-acceptance.mjs <已安装的PGlite模块绝对路径>
npm test
npm run lint
npm run build
git diff --check
```

SQL验收使用内存 PGlite 和显式最小夹具 `tests/fixtures/qianchuan-sql-baseline.sql`。
它能证明PL/pgSQL语法、事务回滚、版本检查与权限契约，不替代现行完整基线、多会话并发或真实PostgREST/飞书验收。
