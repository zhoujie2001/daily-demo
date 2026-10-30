# 千川1000676中台先行发布记录

日期：2026-10-30。目标：zhoujie2001/daily-demo，Vercel daily-demo，自定义生产域www.littlearisa88.com。
用户授权先修改和发布中台；不上传Skill、不重派历史批次、不推进水位线。

## 契约和兼容

- 新契约：code-membership-1000676/v2、contains_code_1000676、contains_1000676/without_1000676。
- 新契约仅精确匹配1000676；1005004、1000567和10006760均不视为特殊项，理由文字不参与。
- 旧code-membership-1005004/v1独立保留原语义，不能在同一source中升级或替换快照。
- 同对象优先，孤立特殊项跟随前项，连续特殊项一组；完整源顺序不因分桶或20条分卡改变。
- 旧无v2元数据路径及其他业务沿用原逻辑。
- 组级指定/改派尚未支持；v2单条指定入口安全拒绝，不能宣称完整旧能力兼容。

## 恢复修复

决定提交后行移动：源表write_bindings记录当前claim、writer、最新定位行，确认对照此绑定；
原assignment行提示、快照、人员计划、游标和assignment_seq不改写。
旧行回执、过期claim、并发接管均拒绝。GET→PUT窗口仍非原子，绝对人工保护依赖列权限治理。

## 发布前证据

- GitHub main和Vercel现有生产均为19c2972c040b7b6fffde3b3b40175dae885ce902。
- 生产Supabase项目cusjrnfczwrbmgkihwls已只读核验；源表尚不存在，新增迁移不替换旧RPC。
- Node完整回归1035/1035通过（含19项本机HTTP），聚焦58/58通过。
- PGlite最小夹具39项通过；Lint、Vite build、diff check通过。
- 真实隔离Supabase/PostgREST、多会话并发和飞书按钮验收未完成，不冒充通过。
- 旧下载payload、旧哈希夹具和报告保留为旧契约历史回归材料，不在原文件上换码。

## 发布顺序

先审查增量迁移和PR，数据库迁移并验证权限/schema reload，再合入main并确认Vercel生产SHA。
生产验证仅无发卡探针；Skill保持现状。新策略正式切流须更新Skill草稿、重新冻结新源快照并联合验收。
回滚只停止新投递/撤销新能力，不删除决定账本、不回退游标、不重派原需求。
