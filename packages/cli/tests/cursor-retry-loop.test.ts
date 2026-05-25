import { test } from "vitest";
import { expect_deep, expect_eq, expect_truthy } from "./_assert-shim.js";

import type { CriticResult } from "@momentiq/dark-factory-schemas";
import {
  runRetryLoop,
  type RetryableFailure,
} from "../src/adapters/_retry.js";

function retryableFailure(idx: number): RetryableFailure {
  return {
    kind: "retryable_failure",
    errorCode: "capacity_exceeded",
    statusMessage: null,
    message: `transient-${idx}`,
    runId: `run-${idx}`,
    agentId: "agent-1",
  };
}

function abortError(): Error {
  const err = new Error("aborted during retry backoff");
  err.name = "AbortError";
  return err;
}

test("runRetryLoop counts the attempt completed before abort during backoff", async () => {
  const seenAttempts: number[] = [];
  let sleepCalls = 0;
  let captured:
    | {
        last: RetryableFailure | null;
        totalAttempts: number;
        aborted: boolean;
      }
    | null = null;

  await runRetryLoop({
    attempt: async (idx) => {
      seenAttempts.push(idx);
      return retryableFailure(idx);
    },
    sleep: async () => {
      sleepCalls++;
      if (sleepCalls === 2) {
        throw abortError();
      }
    },
    buildExhausted: (info) => {
      captured = info;
      return { status: "ERROR" } as CriticResult;
    },
  });

  expect_deep(seenAttempts, [0, 1]);
  expect_truthy(captured !== null);
  expect_eq(captured!.aborted, true);
  expect_eq(captured!.totalAttempts, 2);
  expect_eq(captured!.last?.message, "transient-1");
});

test("runRetryLoop still reports all attempts when retry budget is exhausted", async () => {
  const seenAttempts: number[] = [];
  let captured:
    | {
        last: RetryableFailure | null;
        totalAttempts: number;
        aborted: boolean;
      }
    | null = null;

  await runRetryLoop({
    attempt: async (idx) => {
      seenAttempts.push(idx);
      return retryableFailure(idx);
    },
    sleep: async () => {},
    buildExhausted: (info) => {
      captured = info;
      return { status: "ERROR" } as CriticResult;
    },
  });

  expect_deep(seenAttempts, [0, 1, 2]);
  expect_truthy(captured !== null);
  expect_eq(captured!.aborted, false);
  expect_eq(captured!.totalAttempts, 3);
  expect_eq(captured!.last?.message, "transient-2");
});
