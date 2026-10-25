# 2026-10-25 新状态表单误报协议失效

## 已确认的生产证据

Vercel 生产仍运行 main@481b401，Ready / Current。通过本机 Chrome 的 Vercel 日志页面（连接器日志权限不足）读到三次 `legacy_status_form_rejected`：

- 2026-10-25 12:08:49.75 +08:00
- 2026-10-25 12:09:00.85 +08:00
- 2026-10-25 12:09:50.05 +08:00

三次均为 protocol_version=2、has_complete_snapshot=true、has_operation_id=true、has_all_status_fields=false。Supabase 只读回查对应两张当天表单：协议/CAS/operation 均完整，未完成且有效期未过。

因此不是未上线、旧表单、缺 CAS 或数据库超时；被拒绝的直接分支是三个字段必须全部存在且为数组的谓词。

原日志没有记录具体字段形态，不能断言本次空字段一定是 missing、null 或空字符串。修复安全支持这三种无内容形态；不把它们直接解释为清空。

## 两个代码缺陷

1. 三个非必填多选控件与服务端“必须回传三个数组”的契约矛盾。仅修改一份名单的稀疏请求被误报成协议失效。
2. JSON 2.0 多选默认值用了 `initial_options`；官方属性应为 `selected_values`，否则已有离岗人员不能可靠预选。

官方依据：https://open.feishu.cn/document/feishu-cards/card-json-v2-components/interactive-components/multi-select-dropdown-menu 。已在本机 Chrome 读取其 JSON 2.0 字段说明，未借助第三方博客认定契约。

## 安全语义

新打开的表单在服务端 pending 同时保存：

- 固定的 `statusFormSelectionMode=preserve-open-snapshot-v1`；
- 三份名单的 `initialAdOffDuty`；
- 原有协议 2、CAS 快照、confirmationOperationId 和消息/群/日期/scope 绑定。

提交规则：

- 未回传、null、空字符串：只能在存在完整服务端初始快照的新模式下保留打开时状态。
- 显式数组：更新对应名单；原有显式空数组清空合同继续支持。
- 提供“全员在岗（清空本名单离岗人员）”明确选项，仅单独选择时映射为空数组，不能与人员混选。
- 新控件通过 selected_values 正确预选；空名单使用空数组，不默认选择清空选项，避免用户添加一个人时意外混选。
- 不能使用按钮中的 mode/defaults，也不能改用数据库最新版本绕过 CAS。
- 旧 pending 没有初始快照且字段不全时继续零状态写入拒绝，但报字段错误，不再冒充协议失效。
- 非空字符串、对象、数字、非字符串数组元素、空白人员值等拒绝。
- 缺协议、缺 CAS、缺 operation、跨消息/群/日/scope、过期仍拒绝。
- 字段错误日志只保存预定义字段名和类型，不记录人名、原因、原始回调、token 或 Secret。

## 验证

先在未修改业务代码时加入两个反例，均明确失败：稀疏提交被拒绝；selected_values 不存在。补修后通过。

- 状态表单相关四文件：91/91 通过。
- 全量：883/883 通过，0 失败、0 跳过。
- 新增 24 项测试，覆盖三种空形态、保留非空初始状态、服务端快照防伪、旧 pending 拒绝、显式清空/混选、CAS、完成标记丢失，以及截图形态的真实 HTTP 入口模拟。
- HTTP 仍为本机模拟，远端飞书/PostgREST/RPC 事务采用模拟，不能称为真实生产写验收。

本次不涉及 SQL migration、RPC、权限、派单分配或游标算法变更。未修改生产名单、未重试旧批次。

## 测试遗漏复盘与发布边界

上一轮模拟虽然使用实际 callback 和客户端代码，但人为构造的提交始终包含三个数组，甚至把缺字段统一定义成拒绝场景。它无法覆盖非必填控件的空值契约，不能单凭测试总数认定实际 UI 正常。

本地补修不会自动改写已经发出的表单 pending。发布后需要从原卡重新打开新表单；旧表单缺少新模式元数据时仍安全拒绝稀疏提交。本轮未经新的发布确认不合并生产。
