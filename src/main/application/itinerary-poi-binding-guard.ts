/**
 * 写入护栏：本次写入**新出现**的 POI 绑定必须带当前槽位的受控凭证。
 *
 * 背景：绑定（itinerary.spots.poiId）、凭证（diagnostics.poiAdjudications）、
 * 决策门任务（research_tasks.state）是同一事实的三份投影。任何一条写路径只写
 * 绑定而不写凭证，就会留下「已绑定、无凭证」的中间态——任务永远不结清、地域
 * 核验继续拦，运营看到的就是「选过了还在待核查」。历史上这类问题按写路径逐个
 * 复发，所以把判定放到统一写入口，而不是继续给每条路径补代码。
 *
 * 口径：
 *  - 只检查「这一天此前没有过的 poiId」；沿用既有绑定（改名、patch 重放旧行程、
 *    资源回填、重新继承 spotId）不受影响，否则历史产品里没有凭证的旧绑定会被误伤；
 *  - `strip` 只在 AI patch 入口打开：`patch_product` 的工具契约本就禁止填写 POI，
 *    落库前剥离才能让契约生效，并逼 Agent 走受控选择器；
 *  - 其他写入保留绑定但记录告警：规划模块整包写、人工整包编辑都不能替调用方
 *    决定该不该写，但必须留下可追溯的痕迹。
 */

import { poiBindingWasAdjudicated } from '../../shared/poi-adjudication-receipt.js';
import { logWarn } from '../../shared/log-timestamp.js';

type Json = Record<string, unknown>;

export interface PoiBindingGuardContext {
  source: string;
  /** 无凭证的新绑定是否在落库前丢弃。 */
  strip: boolean;
  localProductId?: string;
}

export interface UnreceiptedPoiBinding {
  day: number;
  spotName: string;
  poiId: number;
}

export interface PoiBindingGuardResult {
  /** 护栏处理后的产品；`strip` 打开时无凭证的新绑定已被剥离。 */
  product: Json;
  /** 被剥离的绑定（已记日志）。 */
  dropped: UnreceiptedPoiBinding[];
  /** 保留但缺少凭证的绑定（已记日志，供其他写入路径追溯）。 */
  recorded: UnreceiptedPoiBinding[];
}

export function enforceReceiptedPoiBindings(
  current: Json,
  incoming: Json,
  context: PoiBindingGuardContext,
): PoiBindingGuardResult {
  const product = structuredClone(incoming) as Json;
  if (!Array.isArray(product.itinerary)) return { product, dropped: [], recorded: [] };
  const previous = poiIdsByDay(current);
  const dropped: UnreceiptedPoiBinding[] = [];
  const recorded: UnreceiptedPoiBinding[] = [];

  for (const day of product.itinerary) {
    if (!isRecord(day) || !Array.isArray(day.spots)) continue;
    const dayNumber = Number(day.day);
    if (!Number.isInteger(dayNumber) || dayNumber <= 0) continue;
    for (const spot of day.spots) {
      if (!isRecord(spot)) continue;
      const poiId = positiveInteger(spot.poiId);
      if (!poiId) continue;
      // 只拦「这天此前没有过的 POI」。按天取已有 ID 集合而不是按槽位比对：
      // 同一 spot 改名、patch 重放旧行程或重新继承 spotId 都会换键，按槽位
      // 比对会把沿用中的绑定误判成新写入。
      if (previous.get(dayNumber)?.has(poiId)) continue;
      const spotName = text(spot.name);
      if (!spotName) continue;
      // 凭证必须落在「写入后的产品」上：路线 key、槽位、poiId 三者同时成立才算数。
      if (poiBindingWasAdjudicated(product, dayNumber, spotName, poiId)) continue;
      const binding = { day: dayNumber, spotName, poiId };
      if (context.strip) {
        stripPoi(spot);
        dropped.push(binding);
      } else {
        recorded.push(binding);
      }
    }
  }

  if (dropped.length) {
    logWarn('[poi.guard] dropped unreceipted AI poi binding', { localProductId: context.localProductId, source: context.source, dropped });
  }
  if (recorded.length) {
    logWarn('[poi.guard] poi binding saved without controlled receipt', { localProductId: context.localProductId, source: context.source, recorded });
  }
  return { product, dropped, recorded };
}

/** 当前产品每天已有的 POI ID 集合，作为「这一天此前有过这个绑定」的唯一依据。 */
function poiIdsByDay(product: Json): Map<number, Set<number>> {
  const ids = new Map<number, Set<number>>();
  if (!Array.isArray(product.itinerary)) return ids;
  for (const day of product.itinerary) {
    if (!isRecord(day) || !Array.isArray(day.spots)) continue;
    const dayNumber = Number(day.day);
    if (!Number.isInteger(dayNumber) || dayNumber <= 0) continue;
    const set = ids.get(dayNumber) ?? new Set<number>();
    for (const spot of day.spots) {
      const poiId = isRecord(spot) ? positiveInteger(spot.poiId) : null;
      if (poiId) set.add(poiId);
    }
    ids.set(dayNumber, set);
  }
  return ids;
}

function stripPoi(spot: Json): void {
  for (const key of ['poiName', 'poiId', 'province', 'city', 'district', 'latitude', 'longitude']) delete spot[key];
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Json {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
