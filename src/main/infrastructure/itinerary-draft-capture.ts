import {
  asCaptureRecord,
  parseCaptureRecord,
  versionProjection,
  type ItineraryDraftCapturePayload,
} from "./itinerary-draft-capture-projection.js";

export type {
  ItineraryDraftCaptureLocations,
  ItineraryDraftCapturePayload,
  ItineraryDraftCaptureProtocolValues,
  ItineraryDraftCaptureVersionValues,
} from "./itinerary-draft-capture-projection.js";

const CAPTURE_ORIGIN = "https://online.ctrip.com";
const CAPTURE_TIMEOUT_MS = 5 * 60_000;

const CAPTURE_ENDPOINTS = {
  checkTourDaily: /^\/restapi\/soa2\/\d+\/checkTourDaily(?:\.json)?$/,
  saveTourDailyDetail: /^\/restapi\/soa2\/\d+\/saveTourDailyDetail(?:\.json)?$/,
  saveProductTourInfo: /^\/restapi\/soa2\/\d+\/saveProductTourInfo(?:\.json)?$/,
} as const;

type CaptureStep = keyof typeof CAPTURE_ENDPOINTS;
type CapturedStep = CaptureStep | "relatedSoa";

export interface ItineraryDraftCaptureExchange {
  observedAt: string;
  responseAt?: string;
  request: ItineraryDraftCapturePayload;
  response?: ItineraryDraftCapturePayload;
}

export interface ItineraryDraftCaptureObservedExchange extends ItineraryDraftCaptureExchange {
  /** Known save step, or a same-product/version-related SOA endpoint discovered during a UI save. */
  step: CapturedStep;
  /** Endpoint method name only; never an URL, query string, header, or body. */
  endpointName: string;
  /** Numeric SOA service only; the request URL is never retained. */
  serviceId: string;
  source: "page" | "native";
  /** Bounded, non-sensitive top-level request field names. Values are never retained. */
  requestFieldNames: string[];
}

type CaptureStopReason = "timeout" | "disposed" | "rearmed";

export interface ItineraryDraftCaptureRead {
  armedAt: string;
  productId: string;
  capturedAt?: string;
  complete: boolean;
  missingSteps: CaptureStep[];
  /** Every whitelisted, product-bound exchange seen in order; never raw bodies. */
  exchanges?: ItineraryDraftCaptureObservedExchange[];
  /** The observer remains armed after a complete sequence to expose later calls. */
  stoppedAt?: string;
  stopReason?: CaptureStopReason;
  /** Proven saveProductTourInfo request. */
  payload?: ItineraryDraftCapturePayload;
  /** Related calls from the same normal save; complete request/response bodies are never retained. */
  checkTourDaily?: ItineraryDraftCaptureExchange[];
  saveTourDailyDetail?: ItineraryDraftCaptureExchange;
}

export interface DebuggerTarget {
  isAttached(): boolean;
  attach(protocolVersion: string): void;
  detach(): void;
  sendCommand(command: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: "message", listener: DebuggerMessageListener): void;
  removeListener(event: "message", listener: DebuggerMessageListener): void;
}

export interface CaptureWebContents {
  debugger: DebuggerTarget;
}

type DebuggerMessageListener = (event: unknown, method: string, params: unknown) => void;

interface ActiveCapture extends ItineraryDraftCaptureRead {
  target: CaptureWebContents;
  listener: DebuggerMessageListener;
  attachedHere: boolean;
  timeout: ReturnType<typeof setTimeout>;
  requests: Map<string, CapturedRequest>;
  nativeRequestCount: number;
  onStop?: () => void;
}

interface CapturedRequest {
  step: CapturedStep;
  endpointName: string;
  serviceId: string;
  source: "page" | "native";
  observedAt: string;
  requestFieldNames: string[];
  responseAt?: string;
  request: ItineraryDraftCapturePayload;
  response?: ItineraryDraftCapturePayload;
}

function sameProductId(value: unknown, productId: string): boolean {
  return (typeof value === "string" || typeof value === "number") && String(value) === productId;
}

function captureEndpoint(endpoint: string): { step: CapturedStep; endpointName: string; serviceId: string } | undefined {
  let url: URL;
  try { url = new URL(endpoint); } catch { return undefined; }
  if (url.origin !== CAPTURE_ORIGIN) return undefined;
  const pathMatch = url.pathname.match(/^\/restapi\/soa2\/(\d+)\/([A-Za-z][A-Za-z0-9_]*)(?:\.json)?$/);
  if (!pathMatch) return undefined;
  const serviceId = pathMatch[1]!;
  const endpointName = pathMatch[2]!;
  const step = (Object.keys(CAPTURE_ENDPOINTS) as CaptureStep[]).find((key) => CAPTURE_ENDPOINTS[key].test(url.pathname));
  return { step: step ?? "relatedSoa", endpointName, serviceId };
}

function diagnosticFieldNames(body: Record<string, unknown>): string[] {
  return Object.keys(body)
    .filter((key) => /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(key))
    .filter((key) => !/(?:authorization|cookie|header|secret|token|password)/i.test(key))
    .sort()
    .slice(0, 24);
}

function requestInfo(params: unknown): {
  requestId: string;
  step: CapturedStep;
  endpointName: string;
  serviceId: string;
  body: Record<string, unknown>;
  requestFieldNames: string[];
} | undefined {
  const event = asCaptureRecord(params);
  const request = asCaptureRecord(event?.request);
  if (typeof request?.url !== "string" || typeof request.postData !== "string" || typeof event?.requestId !== "string") return undefined;
  const endpoint = captureEndpoint(request.url);
  if (!endpoint) return undefined;
  const body = parseCaptureRecord(request.postData);
  return body ? { requestId: event.requestId, ...endpoint, body, requestFieldNames: diagnosticFieldNames(body) } : undefined;
}

function requestBelongsToProduct(body: Record<string, unknown>, productId: string): boolean {
  return [body.tourInfo, body.productTourInfo, body.result, parseCaptureRecord(body.tourDaily), body]
    .map(asCaptureRecord)
    .some((record) => sameProductId(record?.productId, productId));
}

function explicitlyTargetsOtherProduct(body: Record<string, unknown>, productId: string): boolean {
  const records = [body.tourInfo, body.productTourInfo, body.result, parseCaptureRecord(body.tourDaily), body]
    .map(asCaptureRecord)
    .filter((record): record is Record<string, unknown> => Boolean(record));
  return records.some((record) => record.productId !== undefined && !sameProductId(record.productId, productId));
}

function versionIds(payload: ItineraryDraftCapturePayload | undefined): Set<string> {
  const ids = [payload?.tourInfoId, payload?.draftTourInfoId, payload?.auditTourInfoId, payload?.previewTourInfoId];
  const fromTourInfoIds = payload?.protocolValues.fromTourInfoId.map((entry) => entry.value) ?? [];
  return new Set([...ids, ...fromTourInfoIds].filter((id) => id !== null && id !== 0 && id !== "").map(String));
}

function hasKnownVersion(body: Record<string, unknown>, requests: Iterable<CapturedRequest>): boolean {
  const known = new Set<string>();
  for (const request of requests) {
    for (const id of versionIds(request.request)) known.add(id);
    for (const id of versionIds(request.response)) known.add(id);
  }
  return [...versionIds(versionProjection(body))].some((id) => known.has(id));
}

function belongsToCapture(body: Record<string, unknown>, active: ActiveCapture): boolean {
  if (explicitlyTargetsOtherProduct(body, active.productId)) return false;
  return requestBelongsToProduct(body, active.productId) || hasKnownVersion(body, active.requests.values());
}

function detailMatchesCurrentSequence(detail: ItineraryDraftCapturePayload, requests: Iterable<CapturedRequest>): boolean {
  const known = new Set<string>();
  for (const request of requests) {
    if (request.step !== "checkTourDaily") continue;
    for (const id of versionIds(request.request)) known.add(id);
    for (const id of versionIds(request.response)) known.add(id);
  }
  return [...versionIds(detail)].some((id) => known.has(id));
}

/** One-shot, redacted CDP observation for a normal operator save. */
export class ItineraryDraftCapture {
  private active?: ActiveCapture;
  private last?: ItineraryDraftCaptureRead;

  constructor(private readonly timeoutMs = CAPTURE_TIMEOUT_MS) {}

  async arm(target: CaptureWebContents, productId: string, onStop?: () => void): Promise<ItineraryDraftCaptureRead> {
    this.cleanup(undefined, "rearmed");
    const normalizedProductId = productId.trim();
    if (!normalizedProductId) throw new Error("缺少当前产品 ID，无法开始行程草稿诊断。");
    const debuggerApi = target.debugger;
    const attachedHere = !debuggerApi.isAttached();
    try {
      if (attachedHere) debuggerApi.attach("1.3");
      await debuggerApi.sendCommand("Network.enable");
    } catch (error) {
      if (attachedHere && debuggerApi.isAttached()) {
        try { debuggerApi.detach(); } catch { /* diagnostics must not mask the enable failure */ }
      }
      throw error;
    }
    const armedAt = new Date().toISOString();
    const state = { armedAt, productId: normalizedProductId, complete: false, missingSteps: Object.keys(CAPTURE_ENDPOINTS) as CaptureStep[] };
    const listener: DebuggerMessageListener = (_event, method, params) => {
      if (method === "Network.requestWillBeSent") this.captureRequest(listener, params);
      if (method === "Network.loadingFinished") void this.captureResponse(listener, params);
    };
    const timeout = setTimeout(() => this.cleanup(listener, "timeout"), this.timeoutMs);
    this.active = { ...state, target, listener, attachedHere, timeout, requests: new Map(), nativeRequestCount: 0, onStop };
    debuggerApi.on("message", listener);
    this.last = state;
    return state;
  }

  read(): ItineraryDraftCaptureRead | null {
    return this.last ? structuredClone(this.last) : null;
  }

  dispose(): void { this.cleanup(undefined, "disposed"); }

  /** Receives only an in-memory native-fallback exchange and retains its whitelist projection. */
  observeNative(endpoint: string, observedAt: string, requestBody: unknown, responsePayload: unknown): void {
    const active = this.active;
    const target = captureEndpoint(endpoint);
    const body = asCaptureRecord(requestBody);
    if (!active || !target || !body || !belongsToCapture(body, active)) return;
    const { step, endpointName, serviceId } = target;
    const request = versionProjection(body);
    if (step === "saveTourDailyDetail" && !detailMatchesCurrentSequence(request, active.requests.values())) return;
    const response = versionProjection(responsePayload);
    active.nativeRequestCount += 1;
    active.requests.set(`native-${active.nativeRequestCount}`, {
      step, endpointName, serviceId, source: "native", observedAt, requestFieldNames: diagnosticFieldNames(body), responseAt: new Date().toISOString(), request, response,
    });
    this.last = this.snapshot(active);
    this.finishWhenComplete(active.listener);
  }

  private captureRequest(listener: DebuggerMessageListener, params: unknown): void {
    const active = this.active;
    const info = requestInfo(params);
    if (!active || active.listener !== listener || !info || !belongsToCapture(info.body, active)) return;
    const request = versionProjection(info.body);
    if (info.step === "saveTourDailyDetail" && !detailMatchesCurrentSequence(request, active.requests.values())) return;
    active.requests.set(info.requestId, {
      step: info.step, endpointName: info.endpointName, serviceId: info.serviceId, source: "page",
      observedAt: new Date().toISOString(), requestFieldNames: info.requestFieldNames, request,
    });
    this.last = this.snapshot(active);
  }

  private async captureResponse(listener: DebuggerMessageListener, params: unknown): Promise<void> {
    const active = this.active;
    const requestId = asCaptureRecord(params)?.requestId;
    if (!active || active.listener !== listener || typeof requestId !== "string") return;
    const captured = active.requests.get(requestId);
    if (!captured) return;
    try {
      const response = await active.target.debugger.sendCommand("Network.getResponseBody", { requestId });
      if (!this.active || this.active.listener !== listener) return;
      const responseRecord = asCaptureRecord(response);
      const rawBody = responseRecord?.body;
      const body = responseRecord?.base64Encoded === true && typeof rawBody === "string"
        ? Buffer.from(rawBody, "base64").toString("utf8")
        : rawBody;
      const parsed = parseCaptureRecord(body);
      if (!parsed) return;
      captured.response = versionProjection(parsed);
      captured.responseAt = new Date().toISOString();
      this.last = this.snapshot(active);
      this.finishWhenComplete(listener);
    } catch {
      // This observer is diagnostic-only. Navigation can make a response body unavailable.
    }
  }

  private finishWhenComplete(listener: DebuggerMessageListener): void {
    const active = this.active;
    if (!active || active.listener !== listener) return;
    const checks = [...active.requests.values()].filter((request) => request.step === "checkTourDaily");
    const detail = [...active.requests.values()].find((request) => request.step === "saveTourDailyDetail");
    const association = [...active.requests.values()].find((request) => request.step === "saveProductTourInfo");
    if (!checks.length || !detail || !association || !checks.every((request) => request.response) || !detail.response || !association.response) return;
    if (!active.complete) active.capturedAt = new Date().toISOString();
    active.complete = true;
    this.last = this.snapshot(active);
  }

  private snapshot(active: ActiveCapture): ItineraryDraftCaptureRead {
    const requests = [...active.requests.values()];
    const checks = requests.filter((request) => request.step === "checkTourDaily");
    const detail = requests.filter((request) => request.step === "saveTourDailyDetail").at(-1);
    const association = requests.filter((request) => request.step === "saveProductTourInfo").at(-1);
    const missingSteps = (Object.keys(CAPTURE_ENDPOINTS) as CaptureStep[]).filter((step) => !requests.some((request) => request.step === step));
    return {
      armedAt: active.armedAt,
      productId: active.productId,
      complete: active.complete,
      missingSteps,
      ...(active.capturedAt ? { capturedAt: active.capturedAt } : {}),
      ...(requests.length ? { exchanges: requests.map((request) => ({
        step: request.step, endpointName: request.endpointName, serviceId: request.serviceId, source: request.source,
        observedAt: request.observedAt,
        requestFieldNames: request.requestFieldNames,
        ...(request.responseAt ? { responseAt: request.responseAt } : {}),
        request: request.request,
        ...(request.response ? { response: request.response } : {}),
      })) } : {}),
      ...(association ? { payload: association.request } : {}),
      ...(checks.length ? { checkTourDaily: checks.map((request) => ({
        observedAt: request.observedAt,
        ...(request.responseAt ? { responseAt: request.responseAt } : {}),
        request: request.request,
        ...(request.response ? { response: request.response } : {}),
      })) } : {}),
      ...(detail ? { saveTourDailyDetail: {
        observedAt: detail.observedAt,
        ...(detail.responseAt ? { responseAt: detail.responseAt } : {}),
        request: detail.request,
        ...(detail.response ? { response: detail.response } : {}),
      } } : {}),
    };
  }

  private cleanup(expectedListener?: DebuggerMessageListener, reason?: CaptureStopReason): void {
    const active = this.active;
    if (!active || (expectedListener && active.listener !== expectedListener)) return;
    if (reason) {
      this.last = {
        ...this.snapshot(active),
        stoppedAt: new Date().toISOString(),
        stopReason: reason,
      };
    }
    this.active = undefined;
    clearTimeout(active.timeout);
    try { active.onStop?.(); } catch { /* diagnostic observer cleanup cannot block shutdown */ }
    active.target.debugger.removeListener("message", active.listener);
    if (active.attachedHere && active.target.debugger.isAttached()) {
      try { active.target.debugger.detach(); } catch { /* target can close during cleanup */ }
    }
  }
}
