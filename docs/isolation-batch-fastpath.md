# AD 隔离 Scope 与生产批量路径对齐

## 原因与修复

PR #156 生产基线 `b4fe5d1` 的 `canSegmentBatch` 仅放行 `default / ad_review / ad_game`，合法的 `ad_isolation:* / ad_game_isolation:*` 虽使用共享预读，却仍逐条分配、逐条 PUT。此前 `pr156_ad_iso_20261025_1608` 的串行结果不能作为新批量路径验收证据。

本次仅扩展执行策略白名单，复用现有 `isAdIsolationScope` 严格校验；不替换隔离 Scope，不修改测试群、lane、run_id 鉴权或数据库权限。名单、版本、游标、assignment 仍保存在各自原隔离 Scope 中。

不混入 `59c7e0f` 分卡发送顺序修复；卡片发送顺序与卡内批量派单是两个独立问题。

## 本地回归

- 修复前新增用例能复现单条分配/写入；修复后 AD 与游戏两个隔离 lane 均通过。
- 同一 mock 表、同一隔离 Scope、25 个空目标分成原卡 20+5，真实 Lark adapter 与 strict-CAS store 共同运行；断言分配调用大小 `[20,5]`，批量写入大小 `[20,5]`，单格 PUT 为 0，sequence 连续，重放第二卡零新增写入。
- 人工已填行分段且不覆盖；决定提交后人工抢填则零写入、保留账本并停止后续；远端批量写成功但回执丢失时只回读、不再次写入。
- 即使 allowedChatIds 包含生产群，隔离 profile 仍在任何依赖 I/O 前拒绝；本次未扩大隔离授权。
- 全部是本地模拟，不是 ByteFaaS 测试，不是线上真实飞书端到端验收，也不证明生产预读 P95 <=3 秒。

2026-10-25 最终本地结果：全量 938/938、共享预读与隔离 Scope 定向 47/47（新增 10 项），ESLint、Vite build 与 diff-check 通过。测试基线为 main 的 928 项；未包含独立分卡排序分支的 23 项。

## 可核验的日志

- `batch_execution_policy`：`scope`、`segmented_batch_enabled`、`disabled_reason`，表示是否具备分段批量执行资格，不等同于动作已完成。
- `batch_segment_success`：每段实际完成条数；全空的 20+5 场景应分别出现 count=20 和 count=5。
- 出现人工值、不同锚点、已提交旧决定或其它安全边界时可合理拆段，不应为追求“一次”跳过保护。
- `batch_preflight`：共享扫描模式与预读耗时；实际网络请求日志需同时核对，不能只看卡片标题或数据库条数认定一次批量写入。

## 发布后真实隔离验收交接

1. 先核实合并 SHA、对应 Vercel Production Ready/Current 与自定义生产域名，不对旧代码重新发起测试。
2. 使用全新测试表、全新合法隔离 run_id 与全新 root batch_id，在固定测试群生成 20+5 两张卡。不要复用旧 `pr156_ad_iso_20261025_1608`，不要重派其第二卡。
3. 逐卡验证 20、5 条全空目标：资格日志为 true，成功段计数为 20、5，分别一次 `bess_assign_batch` 与一次 `values_batch_update`，无单格 PUT；回读全 25 个目标与 scope 账本一致。
4. 重复点击仍为同一批次，零新增决定、零重复写入；故障注入仅在隔离资源执行。
5. 生产业务 Scope 的名单、离岗、游标和 assignment 不变化；不点击旧业务批次或推进监控水位线。

本次不需数据库迁移、环境变量或 Skill 修改。生产发布完成只代表可以开始上述真实验收；未取得完整远端证据前，不宣称真实 25 条批量验收通过。
