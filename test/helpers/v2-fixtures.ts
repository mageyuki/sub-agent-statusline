import type {
  SessionInfo, SessionExecutionStarted, SessionExecutionSucceeded,
  SessionExecutionInterrupted, SessionExecutionFailed, SessionDeleted,
  SessionUsageUpdated,
} from "@opencode/client";

export const T0 = Date.parse("2026-09-23T10:00:00.000Z");
export function childInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "ses_child", parentID: "ses_parent", projectID: "project_test",
    title: "Owned child", location: { directory: "/fixture/project" },
    cost: 0, tokens: { input: 12, output: 3, reasoning: 8, cache: { read: 4, write: 2 } },
    time: { created: T0, updated: T0 }, ...overrides,
  };
}
export function header(seq: number, created: number, sessionID = "ses_child") {
  return { id: `evt_${sessionID}_${seq}`, created,
    durable: { aggregateID: sessionID, seq, version: 1 as const } };
}
export function started(seq: number, created: number, sessionID = "ses_child"): SessionExecutionStarted {
  return { ...header(seq, created, sessionID), type: "session.execution.started", data: { sessionID } };
}
export function succeeded(seq: number, created: number, sessionID = "ses_child"): SessionExecutionSucceeded {
  return { ...header(seq, created, sessionID), type: "session.execution.succeeded", data: { sessionID } };
}
export function shutdown(seq: number, created: number): SessionExecutionInterrupted {
  return { ...header(seq, created), type: "session.execution.interrupted",
    data: { sessionID: "ses_child", reason: "shutdown" } };
}
export function failed(seq: number, created: number): SessionExecutionFailed {
  return { ...header(seq, created), type: "session.execution.failed",
    data: { sessionID: "ses_child", error: { type: "unknown", message: "PRIVATE EXCEPTION" } } };
}
export function deleted(seq: number, created: number): SessionDeleted {
  return { ...header(seq, created), type: "session.deleted",
    durable: { aggregateID: "ses_child", seq, version: 2 }, data: { sessionID: "ses_child" } };
}
export function usage(created: number, input = 40, output = 7): SessionUsageUpdated {
  return { id: `evt_usage_${created}`, created, type: "session.usage.updated",
    data: { sessionID: "ses_child", cost: 0,
      tokens: { input, output, reasoning: 100, cache: { read: 100, write: 100 } } } };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
