# 用户提供的4条、两桶隔离报文复验 — 2026-10-26

## 结论必须分两层

**原报文没有完整通过。** 哈希、顺序、对象ID及代码分桶正确，但完整快照只保留7个决策键，缺少派单目标信息。
中台当前候选的原报文复现结果是两个投递都返回 `INVALID_REQUEST_NAME`。
继续只补名称也不够，还需业务分类、sheet_url/sheet_id、行定位、负责人列及日期列等完整item契约。

读取的原文件是 `C:/Users/Admin/Downloads/qianchuan-review-v2-isolated-test-payload.json`，本轮没有修改它。
原 `chat_id` 为脱敏占位值，因此仅在本地校验副本中替换为固定测试群；这不影响快照哈希。
测试没有发起网络请求、连接生产DB、发卡或操作真实表格。

## 原报文已确认

- 顺序：QC-T001 → QC-T002 → QC-T003 → QC-T004。
- 两桶的完整快照在JSON语义上相同，哈希均为：
  `6b2bdfb445c543d290f3fb3266d6d94ad1f71a7e4803965df171c980f3f154a4`。
- Node中台及Python分别复算均一致。
- T001/T002对象ID均为同一长字符串，没有经过Number转换。
- T002代码集合只有10050040等值，拒绝文案出现1005004不会命中特殊规则。

## 明确标记的诊断补齐版

从本文件两个投递的 `items` 合并出全部4个完整item，再严格按原快照的request_id顺序补齐目标字段；
保持对象、代码、原始顺序和策略不变，重新计算SHA256。
生成的 `tests/fixtures/qianchuan-isolated-4.complete-targets.json` 具有明确的 `diagnostic_note`。

新哈希：`de0037d086b419d5dbe984f1c1f68d7e76a2dd18553e4dbfc84dee5a13253d9d`。
此副本用于未登记的本地隔离测试，**不得覆盖任何已登记的生产source**。

### 本地真实代码 + 内存替身的结果

调用现行候选的normalizer、按钮解析、分组执行器、内存事务契约和虚拟表格读写；不是线上、PostgREST或真实飞书验收。

| 原始需求 | 结果（测试名单A/B/C） | 原因 |
| --- | --- | --- |
| QC-T001 | A | 原批次第一条特殊理由无前项，正常取下一位 |
| QC-T002 | A | 与T001同审核对象，优先复用 |
| QC-T003 | A | 原顺序中为单条特殊理由，跟随T002 |
| QC-T004 | B | 普通新对象，取下一位 |

先点contains桶和先点without桶分别在独立内存store执行，结果完全相同：

- 4条逐需求账本，2个轮转位置。
- 每桶一次批量写入，每次2格；没有逐格写入。
- 重放原投递：零新增写表、零游标推进、零新增assignment。
- 相同source内容改变并重新计算自洽哈希：`QIANCHUAN_SOURCE_CONFLICT`，不能覆盖原计划。

## 上游最小修改

在分桶前就冻结完整待派单item，排除运行字段，别只投影为7个决策键。
快照中的row_index是冻结时的提示，不因后续插行改变；执行时按request_id重新定位，resolvedRowIndex不得回写冻结快照或重试payload。
每个投递携带同一份完整数组和同一哈希；原始顺序必须来自分桶前列表，不能靠事后拼桶重建生产顺序。
本次能补齐仅因为测试资料同时给出了两桶全部item，并且另有可信原始顺序。

此文件没有连续两条特殊理由的场景，也没有超过20条的场景；它不替代已有连续规则、25条跨卡及故障注入回归。

机器结果见 `qianchuan-provided-payload-review.json`。复现入口：
原始报文即使开启诊断补齐，CLI仍以退出码2表示原报文契约未通过；补齐版自身契约通过才返回0。

```powershell
node tools/qianchuan-payload-acceptance.mjs <原始隔离JSON路径> --diagnostic-complete-targets
node --test tests/qianchuanProvidedPayload.test.js
```

生产仍未发布；19项本机HTTP权限阻塞及真实隔离Supabase/飞书验收门槛不因本轮模拟通过而取消。
