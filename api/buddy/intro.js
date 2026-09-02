import process from 'node:process';
import { LarkClient, LarkApiError } from '../../lib/lark/client.js';
import { DispatchIngestError, verifyDispatchIngestSignature } from '../../lib/dispatch/ingest.js';

export const BUDDY_INTRO_CHAT_ID = 'oc_aa1602f07bf35a5fdfd289aff67025a4';

const defaultClient = new LarkClient({
  appId: () => process.env.LARK_APP_ID,
  appSecret: () => process.env.LARK_APP_SECRET,
  baseUrl: () => process.env.LARK_API_BASE_URL || 'https://open.feishu.cn',
});

export function buildBuddyIntroCard() {
  const section = (title, content, color = 'blue') => ({
    tag: 'column_set', flex_mode: 'none',
    columns: [{
      tag: 'column', width: 'weighted', weight: 1,
      background_style: `${color}-50`, padding: '12px', vertical_spacing: '4px',
      elements: [
        { tag: 'markdown', content: `**<font color='${color}'>${title}</font>**` },
        { tag: 'markdown', content },
      ],
    }],
  });
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default', summary: { content: '自我介绍｜排单 Buddy' } },
    header: {
      title: { tag: 'plain_text', content: '自我介绍' },
      subtitle: { tag: 'plain_text', content: '排单 Buddy' },
      template: 'blue',
      icon: { tag: 'standard_icon', token: 'myai_colorful' },
    },
    body: {
      direction: 'vertical', padding: '12px 12px 20px 12px', vertical_spacing: '12px',
      elements: [
        section('我能干什么', '• 接收批量派单需求\n• 根据每日排班名单分配执行人\n• 按千川、本地推和存量等业务规则轮转\n• 将负责人写回对应台账并回读核验\n• 更新派单卡片，汇总展示处理结果'),
        section('我的工作逻辑', '我以每日排班名单为基础，结合不同业务的轮转方向和台账中最近一次有效负责人，计算下一位执行人。派单使用批次与需求双层幂等：成功项不会重复处理，失败项可以单独重试。写回后还会重新读取台账，确认负责人填写正确。', 'violet'),
        section('我在什么情况下出现', '当 BESS 监控发现新增需求、完成二次确认并成功写入台账后，我会在对应业务群中发送派单卡片。没有新增需求、需求被过滤、写表失败或流程异常时，我不会发起派单。'),
        section('使用方式', '1. 在派单卡片中点击“批量自动派单”\n2. 当天首次使用时，按提示提交真实姓名排班名单\n3. 我会自动完成轮转计算、负责人写回和卡片更新\n4. 如有失败项，可再次点击进行补偿重试', 'grey'),
      ],
    },
  };
}

export function createBuddyIntroHandler({ client = defaultClient } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error_code: 'METHOD_NOT_ALLOWED' });
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ ok: false, error_code: 'INVALID_JSON' }); }
    }
    try {
      verifyDispatchIngestSignature({
        body,
        timestamp: req.headers?.['x-bess-timestamp'],
        signature: req.headers?.['x-bess-signature'],
        secret: process.env.BESS_DISPATCH_INGEST_SECRET,
      });
      // This endpoint is intentionally fixed-purpose: no caller-supplied chat or card is accepted.
      if (!body || Object.keys(body).length !== 1 || body.action !== 'send_buddy_intro') {
        throw new DispatchIngestError('INVALID_SCHEMA', '仅支持发送固定的排单 Buddy 自我介绍卡');
      }
      const message = await client.sendMessage({
        receiveId: BUDDY_INTRO_CHAT_ID,
        msgType: 'interactive',
        content: buildBuddyIntroCard(),
        uuid: 'bess-buddy-intro-v1-main-chat',
      });
      console.info(JSON.stringify({ module: 'bess-buddy-intro', stage: 'sent', chat_id: BUDDY_INTRO_CHAT_ID, message_id: message.message_id }));
      return res.status(200).json({ ok: true, message_id: message.message_id });
    } catch (error) {
      const status = error instanceof DispatchIngestError ? error.status : error?.status || 502;
      const code = error instanceof DispatchIngestError ? error.code : error instanceof LarkApiError ? error.code : error?.code || 'INTRO_SEND_FAILED';
      console.error(JSON.stringify({ module: 'bess-buddy-intro', stage: 'failed', error_code: code }));
      return res.status(status).json({ ok: false, error_code: code });
    }
  };
}

export default createBuddyIntroHandler();
