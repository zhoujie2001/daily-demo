import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// 独立黑盒验收入口：每个 TC 都通过公开 handler/service/OpenAPI 边界的既有自动化用例执行。
// 子进程只继承隔离测试变量；不会携带或读取生产密钥。
const cases = [
  ['TC-001', 'tests/batchDispatch.test.js', '批量派单首次点击若名单未初始化'],
  ['TC-002', 'tests/bessDispatchP1.test.js', '后续倒序派单选择锚点上一位'],
  ['TC-003', 'tests/bessDispatchP1.test.js', '后续派单从最新有效人工锚点轮转'],
  ['TC-004', 'tests/bessDispatchP1.test.js', '后续倒序派单选择锚点上一位'],
  ['TC-005', 'tests/batchDispatch.test.js', '目标行已有周杰时不写表并校准'],
  ['TC-006', 'tests/bessDispatchP1.test.js', '目标行名单外负责人不覆盖也不持久化'],
  ['TC-007', 'tests/bessDispatchP1.test.js', '多块扫描跳过较新块名单外负责人'],
  ['TC-008', 'tests/bessDispatchP1.test.js', '无有效锚点时忽略名单外负责人并沿用持久化游标'],
  ['TC-009', 'tests/batchDispatch.test.js', '批量派单回归测试：人工填写行作为锚点推顺序'],
  ['TC-010', 'tests/bessDispatchP1.test.js', '回归：728748 人工改为周杰后'],
  ['TC-011', 'tests/batchDispatch.test.js', '批量点击立即禁用按钮，逐项处理后更新原卡'],
  ['TC-012', 'tests/bessDispatchP1.test.js', '千川锚点忽略当天更新的本地行'],
  ['TC-013', 'tests/bessDispatchP1.test.js', '本地推锚点忽略当天更新的千川行'],
  ['TC-014', 'tests/bessDispatchP1.test.js', '项目字段支持多选和分隔文本'],
  ['TC-015', 'tests/bessDispatchP1.test.js', '同 request_id 重放返回原负责人'],
  ['TC-016', 'tests/batchDispatch.test.js', '同 batch_id 并发重复点击不重复派单'],
  ['TC-017', 'tests/batchDispatch.test.js', '重放只跳过 SUCCESS，FAILED 使用既有 assignment 重试'],
  ['TC-018', 'tests/batchDispatch.test.js', '名单表单 FAILED 显示红色结果且不完成 pending'],
  ['TC-019', 'tests/batchDispatch.test.js', 'PARTIAL→SUCCESS 重试更新同一话题结果卡'],
  ['TC-020', 'tests/batchDispatch.test.js', '旧话题结果卡更新失败时补发最终结果卡'],
  ['TC-021', 'tests/bessDispatchP1.test.js', '电子表格按列字母写入后 GET 回读，不一致即失败'],
  ['TC-022', 'tests/bessDispatchP1.test.js', '上海日界线和次日零点正确'],
];

for (const [id, file, pattern] of cases) {
  test(`${id} 黑盒验收`, () => {
    const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, file], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: 'test',
        TZ: 'UTC',
        LARK_API_BASE_URL: 'https://open.feishu.test',
        SUPABASE_URL: 'https://supabase.test',
        SUPABASE_SERVICE_ROLE_KEY: 'blackbox-placeholder-not-a-secret',
      },
      timeout: 30_000,
    });
    assert.equal(result.status, 0, `${id} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
    assert.match(result.stdout, /# pass 1\b/, `${id} did not execute exactly one mapped assertion`);
    assert.match(result.stdout, /# fail 0\b/);
  });
}
