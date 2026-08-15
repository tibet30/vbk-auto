/**
 * 真实接机站 / 送机站搜索接口：
 *   - suggestAirport      (POST /restapi/soa2/20049/suggestAirport)
 *       请求：{ requestHeader:{locale:"zh-CN"}, keyword, contentType:"json" }
 *       响应：{ ResponseStatus, airports: [{ code, name }] }
 *   - suggestTrainStation (POST /restapi/soa2/20049/suggestTrainStation)
 *       请求：{ requestHeader:{locale:"zh-CN"}, keyword, contentType:"json" }
 *       响应：{ ResponseStatus, trainStations: [{ stationNo, stationName, locationCode, geoId }] }
 *
 * 设计要点：
 *   - 两个接口 Ack="Success" 但 keyword 没有匹配时都会返回空数组（不是
 *     Ack=Failure），所以调用方必须把「空列表」与「业务失败」区分开；
 *   - 关键词过短（≤1 字）会返回大量候选（含海外同名），由调用方负责挑唯一匹配；
 *   - 返回类型化候选 StationCandidate，便于 itinerary-transform 直接消费；
 *   - 不写 Cookie / token，只看是否有匹配。
 */

import { vbkSessionRequest, type VbkSessionRequestBrowser } from "../../../infrastructure/vbk-session-request.js";

const SUGGEST_AIRPORT_ENDPOINT =
  "https://online.ctrip.com/restapi/soa2/20049/suggestAirport";
const SUGGEST_TRAIN_ENDPOINT =
  "https://online.ctrip.com/restapi/soa2/20049/suggestTrainStation";

interface AirportApiItem {
  code?: unknown;
  name?: unknown;
  airportCode?: unknown;
  airportName?: unknown;
}

interface TrainApiItem {
  locationCode?: unknown;
  stationName?: unknown;
}

/**
 * 候选站点的稳定抽象类型：
 *   - type: "air" | "train"（决定后续写入 pickup/dropoff 哪个字段）；
 *   - id:  业务方稳定 ID（airportCode / locationCode），用于幂等回写；
 *   - code: 同 id，写入 VBK 协议时使用；
 *   - name: 中文/英文展示名；
 *   - raw:  原始响应字段（供其它转换层做 cityId / geoId 等扩展读取）。
 *
 * 强约束：code 与 name 都必须是非空字符串；缺任一项视为废数据直接过滤，
 * 禁止让 name 充当 id（避免后续 VBK 协议字段误填）。
 */
export interface StationCandidate {
  type: "air" | "train";
  id: string;
  code: string;
  name: string;
  raw: Record<string, unknown>;
}

/**
 * 把 suggestAirport 的 airports 项规整成 StationCandidate。
 *  - 过滤掉 code 或 name 任一为空的废数据；
 *  - type 固定为 "air"，id/code 都取 airportCode（VBK 协议只认这个码）。
 */
export function normalizeAirportCandidates(items: unknown): StationCandidate[] {
  if (!Array.isArray(items)) return [];
  const out: StationCandidate[] = [];
  for (const item of items as AirportApiItem[]) {
    if (!item || typeof item !== "object") continue;
    const code = String(item.code ?? item.airportCode ?? "").trim();
    const name = String(item.name ?? item.airportName ?? "").trim();
    if (!code || !name) continue;
    out.push({
      type: "air",
      id: code,
      code,
      name,
      raw: { ...(item as Record<string, unknown>) },
    });
  }
  return out;
}

/**
 * 把 suggestTrainStation 的 trainStations 项规整成 StationCandidate。
 *  - 过滤掉 code 或 name 任一为空的废数据；
 *  - locationCode 是 VBK 行程详情中的稳定站码；
 *  - geoId / stationNo 仅在「同一城市多站」时用来做消歧；
 *  - 不在底层调用层做业务「同名唯一胜出」决策，由调用方按业务规则处理。
 */
export function normalizeTrainCandidates(items: unknown): StationCandidate[] {
  if (!Array.isArray(items)) return [];
  const out: StationCandidate[] = [];
  for (const item of items as TrainApiItem[]) {
    if (!item || typeof item !== "object") continue;
    const code = String(item.locationCode ?? "").trim();
    const name = String(item.stationName ?? "").trim();
    if (!code || !name) continue;
    out.push({
      type: "train",
      id: code,
      code,
      name,
      raw: { ...(item as Record<string, unknown>) },
    });
  }
  return out;
}

interface AckStatusPayload {
  ResponseStatus?: {
    Ack?: unknown;
    Errors?: Array<{ Message?: unknown; message?: unknown }>;
  };
}

function describeAckErrors(payload: AckStatusPayload): string {
  const errors = payload.ResponseStatus?.Errors;
  if (Array.isArray(errors) && errors.length) {
    return errors.map((e) => e?.Message || e?.message || String(e)).join(", ");
  }
  return "未知业务失败";
}

function assertAck(payload: AckStatusPayload, label: string): void {
  if (payload.ResponseStatus?.Ack === "Failure") {
    throw new Error(`${label}业务失败（Ack=Failure）：${describeAckErrors(payload)}`);
  }
}

/**
 * 真实接机站搜索：返回 suggestAirport 的全部机场候选（包含 0 个 = 「找不到」）。
 *  - Ack=Failure → 抛错（业务失败）；
 *  - Ack=Success + airports 空数组 → 返回 []（找不到）；
 *  - Ack=Success + airports 非空 → 返回规整后的候选列表。
 */
export async function searchAirports(
  page: VbkSessionRequestBrowser,
  keyword: string,
): Promise<StationCandidate[]> {
  const trimmed = String(keyword ?? "").trim();
  if (!trimmed) return [];
  const response = await vbkSessionRequest(page, {
    endpoint: SUGGEST_AIRPORT_ENDPOINT,
    browserRequestTimeoutMs: 12_000,
    evaluateTimeoutMs: 15_000,
    errorLabel: "VBK 接机站搜索",
    body: {
      requestHeader: { locale: "zh-CN" },
      contentType: "json",
      keyword: trimmed,
    },
    headers: { "x-tt-core": "1" },
  });
  assertAck(response.payload as AckStatusPayload, "VBK 接机站搜索");
  const airports = (response.payload as { airports?: unknown }).airports;
  return normalizeAirportCandidates(airports);
}

/**
 * 真实送机站（火车站）搜索：返回 suggestTrainStation 的全部候选。
 *  - 同 searchAirports 的失败/空列表语义；
 *  - keyword 是地点关键字（如「丽江」「南京」），返回同地点的全部火车站。
 */
export async function searchTrainStations(
  page: VbkSessionRequestBrowser,
  keyword: string,
): Promise<StationCandidate[]> {
  const trimmed = String(keyword ?? "").trim();
  if (!trimmed) return [];
  const response = await vbkSessionRequest(page, {
    endpoint: SUGGEST_TRAIN_ENDPOINT,
    browserRequestTimeoutMs: 12_000,
    evaluateTimeoutMs: 15_000,
    errorLabel: "VBK 火车站搜索",
    body: {
      requestHeader: { locale: "zh-CN" },
      keyword: trimmed,
      contentType: "json",
    },
    headers: { "x-tt-core": "1" },
  });
  assertAck(response.payload as AckStatusPayload, "VBK 火车站搜索");
  const trainStations = (response.payload as { trainStations?: unknown }).trainStations;
  return normalizeTrainCandidates(trainStations);
}
