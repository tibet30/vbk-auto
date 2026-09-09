/** Operational recovery keeps the already approved business intent intact. */
export function preservesApprovedIntent(content: string): boolean {
  const text = content.trim().replace(/\s+/g, "").replace(/[。！!]+$/g, "");
  // A recovery command has no new business noun/value. Keep this deliberately
  // conservative: any edit verb, explicit field, price, date, or new POI turns
  // the message into a new intent and therefore requires a new approval.
  const explicitlyPreservesPlan = /(?:不要|无需|不再|别|勿).{0,6}(?:修改|调整|变更)/.test(text)
    && /(?:保持|沿用|按|使用).{0,10}(?:当前|原|既有).{0,8}(?:方案|行程|设置)/.test(text)
    && /(?:重试|继续|恢复|从.+阶段)/.test(text);
  if (!explicitlyPreservesPlan && /(?:改|修改|调整|变更|新增|删除|替换|更换|重做|重新规划|重新生成|添加).{0,20}(?:价格|成人|儿童|酒店|行程|景点|POI|日期|人数|套餐|用车|资源|城市)/i.test(text)) return false;
  const bareRecovery = /^(?:继续(?:吧|啊|一下|下去|处理|执行)?|接着(?:做|处理|执行)?|再试(?:一次|下)?|重试(?:一下|失败(?:的)?(?:阶段)?)?|从(?:刚才|原处|报错处|失败处)(?:继续|接着)(?:做|处理|执行)?|恢复(?:执行|处理)?|按原方案(?:继续|重试))$/i;
  if (bareRecovery.test(text)) return true;
  return explicitlyPreservesPlan;
}

/**
 * A final approval is created only after local readiness passes. A follow-up
 * about a displayed pending item must therefore keep that approval instead of
 * restarting the same planning loop.
 */
export function isPendingApprovalStatusFollowup(content: string): boolean {
  const text = content.trim().replace(/\s+/g, "");
  if (!text) return false;
  // Real edit requests must restart planning — including recommendation/cover
  // copy — even when the message also mentions a pending item.
  if (/(?:改|修改|调整|变更|新增|删除|替换|更换|重做|重新规划|重新生成|添加|更新).{0,20}(?:价格|成人|儿童|酒店|行程|景点|POI|日期|人数|套餐|用车|资源|城市|推荐理由|推荐|封面)/i.test(text)) {
    return false;
  }
  if (/(?:推荐理由|推荐|封面).{0,12}(?:改|修改|调整|变更|重做|重新生成|更新)/i.test(text)) return false;
  return /推荐理由|待处理事项|待办事项|当前状态|处理进度|是否完成/.test(text);
}
