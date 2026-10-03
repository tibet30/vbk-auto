import { matchingGroupPricingDates, type GroupPricingExpectation } from './pricing-group-contract.js';

type Dimension = 'year' | 'quarter' | 'month' | 'day';
const labels: Record<Dimension,string> = {year:'全年',quarter:'季度',month:'月份',day:'逐日'};
export const GROUP_DAILY_FALLBACK_MAX_DAYS = 99;

function partition(dates: string[], dimension: Dimension): string[][] {
  if (dimension === 'year') return [dates.slice(0,300), dates.slice(300)].filter(batch=>batch.length);
  const groups=new Map<string,string[]>();
  for (const date of dates) {
    const key=dimension === 'day' ? date : dimension === 'month' ? date.slice(0,7)
      : `${date.slice(0,4)}-Q${Math.ceil(Number(date.slice(5,7))/3)}`;
    const batch=groups.get(key) ?? [];batch.push(date);groups.set(key,batch);
  }
  return [...groups.values()];
}

/** 每层结束后以远端证据重新计算剩余日期，部分成功不会被下一层重复覆盖。 */
export async function submitGroupPricingBatches(input: {
  dates: string[];
  remainingDates: string[];
  expected: GroupPricingExpectation;
  submit: (dates: string[]) => Promise<unknown>;
  readRows: () => Promise<any[]>;
  pause: () => Promise<void>;
  onProgress?: (message: string, level?: 'info' | 'warning' | 'error') => void;
}): Promise<any[]> {
  let remaining=input.remainingDates;
  let lastError: unknown;
  const readRemaining=async()=>{
    const rows=await input.readRows();
    const matched=matchingGroupPricingDates(rows,input.dates,input.expected);
    remaining=input.dates.filter(date=>!matched.has(date));
    return rows;
  };
  if (!remaining.length) return input.readRows();
  for (const dimension of ['year','quarter','month','day'] as const) {
    if (dimension === 'day' && remaining.length > GROUP_DAILY_FALLBACK_MAX_DAYS) {
      throw new Error(`拼小团价格库存批量录入未完成：剩余 ${remaining.length} 天，季度与月份批量仍未通过；`+
        `仅少于 100 天允许逐日录入，已保留远端成功日期。最近错误：${String(lastError ?? '回读不一致').slice(0,400)}`);
    }
    const batches=partition(remaining,dimension);
    input.onProgress?.(`拼小团价格库存按${labels[dimension]}提交：剩余 ${remaining.length} 天，共 ${batches.length} 批`);
    for (let index=0;index<batches.length;index++) {
      const batch=batches[index];
      try {
        await input.submit(batch);
        if (index === 0 || index === batches.length-1 || (index+1)%25 === 0) {
          input.onProgress?.(`拼小团价格库存${labels[dimension]}提交：${index+1}/${batches.length} 批（本批 ${batch.length} 天）`);
        }
      } catch (error) {
        lastError=error;
        input.onProgress?.(`拼小团价格库存${labels[dimension]}批次未完成（${batch[0]} 至 ${batch.at(-1)}），将回读后缩小范围`, 'warning');
        if (dimension === 'day') {
          const rows = await readRemaining();
          if (!remaining.length) return rows;
          if (!remaining.includes(batch[0])) continue;
          throw new Error(`拼小团价格库存逐日录入失败，剩余 ${remaining.length} 天；已保留成功日期。${String(error).slice(0,400)}`);
        }
      }
      if (index < batches.length-1) await input.pause();
    }
    // Ack 成功不足以证明全部日期落库；漏日、错价、错库存同样进入下一层。
    const rows=await readRemaining();
    if (!remaining.length) return rows;
    input.onProgress?.(`拼小团价格库存${labels[dimension]}回读后仍缺 ${remaining.length}/${input.dates.length} 天，继续缩小批次`, 'warning');
  }
  throw new Error(`拼小团价格库存回读不一致：${input.dates.length-remaining.length}/${input.dates.length} 个日期精确匹配；异常日期：${remaining.slice(0,5).join("、")}。未标记成功。`);
}
