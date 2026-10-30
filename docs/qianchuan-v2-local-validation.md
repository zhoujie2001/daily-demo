# 千川 v2 本地候选核验记录 — 2026-10-26

## 2026-10-30更新

1000676/v2契约及按版本兼容旧1005004/v1已实现；行移动恢复P1已修复。
最新全量1035/1035、聚焦58/58、PGlite隔离39项检查通过，Lint/Build/diff通过。
以下10月26日记录保留为历史证据；其中P1“尚未修复”及“未提交/发布”不代表当前进度。
真实隔离数据库、多会话和飞书验收仍未完成，不能据本机通过宣布真实验收通过。
发布状态见qianchuan-1000676-release.md。

仓库：现行 Vercel `daily-demo`。基线：`origin/main@19c2972c040b7b6fffde3b3b40175dae885ce902`。
本地分支：`codex/qianchuan-group-decisions`。没有推送、创建PR、合并、部署或修改远端数据库。

## 最终已完成的检查

| 检查 | 结果 | 边界 |
| --- | --- | --- |
| 新增策略/传输/恢复、哈希及提供报文回归 | 51/51通过 | 本机mock，含真实Lark适配器及callback处理代码；canonical UTF-8测试向量独立用Python复算一致 |
| 非回环HTTP回归 | 1009/1009通过 | 包含上述51项，不应相加；显式排除下面的19项 |
| 回环HTTP集成补验 | 19/19通过 | 实际本机HTTP服务，远端Lark/Supabase均为模拟，不是线上验收 |
| 全量不排除文件回归 | 1028/1028通过 | 0失败、0跳过；包含上述所有Python以外的Node测试，不应相加 |
| PostgreSQL隔离执行 | 33项检查通过 | PGlite 0.3.14 + 最小基线夹具，不是真实Supabase |
| ESLint | 通过 | 全仓库 |
| Vite Build | 通过 | 保留原有大chunk提示，不是派单链路错误 |
| git diff --check | 通过 | 源码、迁移、测试与文档 |

故障注入包括：

- 同对象、单条/连续特殊代码、优先级冲突、首条特殊、空对象ID；
- 两代码桶按相反顺序点击；25条同对象横跨20+5两卡；
- 人工已填、同组人工值冲突、落账后人工抢填；
- 决定提交后丢失RPC响应、写表完成后丢失PUT响应；
- 回读不可达、确认落库失败、200但确认结构无效；
- 原批次幂等恢复不重复选人/重复推进；另一个投递不能接管同一pending写入；
- 无源清单、跨日期、篡改分桶/代码/策略/哈希、旧单条入口绕过；
- 独立scope、名单暂停、fencing、CAS、RLS/ACL、事务回滚。
- 完整原始快照持久化、接入复算SHA-256、对象键顺序无关而数组顺序敏感；
- 原哈希下改变内容/顺序拒绝；重新计算新哈希也不能替换已登记source；
- 自身哈希/运行字段拒绝，非JSON或跨语言歧义数值拒绝，Unicode及长ID跨Python/JS向量一致。

## 仍未完成，不能写成通过

1. 新发现P1：决定落账后需求行移动，原卡恢复得到原决定，但确认RPC仍按原assignment的rowIndex核验。
   本机独立复现：7001/7003移至7011/7013，未重新派人，确认返回QIANCHUAN_RECEIPT_CONFLICT，pending仍为2。
   内存实现与SQL实现均有相同旧行号绑定；尚未修复，不应放行。19项HTTP的历史权限阻塞已解除并补验通过。
2. 真实Supabase完整现行基线迁移、PostgREST、schema reload和advisors。
3. 真正多会话/多进程并发；PGlite单连接不构成并发验收。
4. 真实飞书隔离群/表、人工修改/行移动、按钮及网络长尾验收。
5. 用户已提供完整有序决策快照，但原报文快照只有7个决策字段，缺少完整派单目标；补齐版仅为本地诊断副本。
   原报文哈希验证通过、接入契约未通过。见 `qianchuan-provided-payload-review.md`。
6. 新策略的组级指定/改派未实现；旧单条入口安全拒绝，不允许绕过组账本。

## 上游交接原文

> 保留当前两个decision_group枚举、batch_id命名、source_batch_id、decision_policy_version；decision_snapshot_hash按完整有序快照的canonical JSON SHA-256计算。
> 在按代码分桶/每20条分片前冻结完整待派单列表，新增decision_snapshot数组；数组成员与items同形，保留原顺序。
> 同一source_batch_id下所有投递都携带同一份完整数组；items仍仅含当前桶当前片、最多20条。
> 冻结前完成ID和代码集合规范化，快照中不放自己的哈希、分片batch_id或运行时回执。UTF-8、ensure_ascii=False、sort_keys=True、separators=(',', ':')、allow_nan=False。
> 不要用contains_1005004当作同一个人员组；不要从分桶后的列表重算相邻关系。
> 中台将另算decision_manifest_hash并生成source_position，持久化完整人员计划；回调只携带引用。
> 本地候选未发布，补齐契约并完成剩余验收前不要切流或重投旧需求。

实现细节、迁移路径、风险与发布顺序见 `qianchuan-group-dispatch-v2.md`。
