import test from "node:test";
import assert from "node:assert/strict";
import type {
  AdvisorOutcome,
  AdvisorRequest,
  AutomationRun,
  PhaseRecovery,
} from "../../src/shared/contracts.js";
import {
  runPhaseWithRecovery,
  MAX_PHASE_ATTEMPTS,
} from "../../src/main/automation/recovery/recovery.js";

function makeRun(): AutomationRun {
  return {
    id: "run-1",
    status: "running",
    phases: [],
    logs: [],
  };
}

interface SpyAdvisor {
  fn: (req: AdvisorRequest) => Promise<AdvisorOutcome>;
  calls: AdvisorRequest[];
  outcomes: AdvisorOutcome[];
}

function makeSpyAdvisor(outcomes: AdvisorOutcome[] = []): SpyAdvisor {
  const calls: AdvisorRequest[] = [];
  const queue = [...outcomes];
  const fn = async (req: AdvisorRequest): Promise<AdvisorOutcome> => {
    calls.push(req);
    const next = queue.shift();
    if (!next) {
      throw new Error("advisor queue exhausted");
    }
    return next;
  };
  return { fn, calls, outcomes };
}

function now(): () => Date {
  let counter = 0;
  return () => new Date(`2026-08-02T00:00:0${counter++}.000Z`);
}

interface ExecuteOptions {
  failTimes?: number;
  throwOn?: Array<{ message?: string }>;
}

function makeExecute(opts: ExecuteOptions = {}) {
  let calls = 0;
  const list: Array<{ message?: string }> = opts.throwOn ?? [];
  const failTimes = opts.failTimes ?? 0;
  return {
    fn: async () => {
      const idx = calls++;
      if (idx < failTimes) {
        throw new Error(`fail-${idx}`);
      }
      const fail = list[idx];
      if (fail) {
        throw new Error(fail.message ?? `failed-${idx}`);
      }
      return "ok";
    },
    calls: () => calls,
  };
}

export {
  test,
  assert,
  makeRun,
  makeSpyAdvisor,
  makeExecute,
  now,
  runPhaseWithRecovery,
  MAX_PHASE_ATTEMPTS,
  type SpyAdvisor,
  type ExecuteOptions,
  type AdvisorOutcome,
  type AdvisorRequest,
  type AutomationRun,
  type PhaseRecovery,
};
