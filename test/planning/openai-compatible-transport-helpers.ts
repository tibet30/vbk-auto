import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type test from "node:test";
import type { PlannerRequest, PoiNameResolutionRequest } from "../../src/shared/contracts-planning.js";

export interface CapturedRequest {
  method: string;
  url: string;
  authHeader: string | undefined;
  contentType: string | undefined;
  body: string;
  parsedBody: Record<string, unknown>;
}

export interface ServerHandle {
  url: string;
  captured: CapturedRequest[];
  close: () => Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

export async function startCapturingServer(
  t: test.TestContext,
  respond: (req: CapturedRequest, res: ServerResponse) => void,
): Promise<ServerHandle> {
  const captured: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      const raw = await readBody(request);
      const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      const entry: CapturedRequest = {
        method: request.method ?? "GET",
        url: request.url ?? "/",
        authHeader: typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
        contentType: typeof request.headers["content-type"] === "string" ? request.headers["content-type"] : undefined,
        body: raw,
        parsedBody: parsed,
      };
      captured.push(entry);
      respond(entry, response);
    } catch (error) {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: { message: (error as Error).message } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    captured,
    close: async () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function okToolCallResponse(name: string, args: unknown): string {
  return JSON.stringify({
    choices: [{
      message: {
        content: null,
        tool_calls: [{ id: "call_x", type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  });
}

export const baseSkeleton = {
  destination: "太原", days: 2, nights: 1, productForm: "privateTour" as const,
  productType: "domesticShort" as const, supplierProductCode: "NEW",
};

export function basicInfoRequest(): PlannerRequest {
  return {
    stage: "basicInfo",
    context: { skeleton: baseSkeleton, acceptedModules: [], existingResearchTasks: [], currentProduct: { basicInfo: {} } },
  };
}

export function poiNameRequest(): PoiNameResolutionRequest {
  return { destination: "西安", originalName: "钟楼", attempt: 1, previousCandidates: [] };
}
