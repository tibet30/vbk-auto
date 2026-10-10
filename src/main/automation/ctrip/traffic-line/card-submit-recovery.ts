/** A definitive card rejection can leave complete formal resources behind.
 * Reuse only independently verified resources, then let the normal itinerary,
 * clauses and final readback pipeline finish. Never replay an uncertain submit.
 */
export async function submitWithFormalCardRecovery(actions: {
  submit(): Promise<unknown>;
  readFormalResources(): Promise<unknown>;
  onRecovery?(): void;
}): Promise<void> {
  try {
    await actions.submit();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/子产品资源提交未通过：资源配置中含有(?:机票|火车票)资源，需要行程描述中先添加(?:航班|火车)信息卡片/.test(message)) throw error;
    await actions.readFormalResources();
    actions.onRecovery?.();
  }
}
