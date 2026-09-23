import type { Context } from "@opencode/plugin/tui/context";
import type { ModelRef, OpenCodeEvent, SessionInfo, TokenUsageInfo } from "@opencode/client";
import {
  createEmptyState, markChildStatus, refreshDerivedFields, setChildModel,
  upsertChildDetails, upsertRunningChild,
  type ChildTokenState, type StatuslineState,
} from "./state.js";
import { nextBackoffState, type RunningReconcileCacheEntry } from "./reconcile.js";

export interface V2MonitorInput {
  session: Pick<Context["client"]["session"], "list" | "get" | "active">;
  cache: Pick<Context["data"]["session"], "get" | "list" | "sync" | "invalidate" | "message">;
  onChange: (state: StatuslineState) => void;
  onIssue: (issue: "refresh-failed") => void;
}
export interface V2Monitor {
  state(): StatuslineState;
  hint(childID: string): "interrupted" | undefined;
  stale(): boolean;
  accept(event: OpenCodeEvent): Promise<void>;
  refresh(parentID?: string): Promise<void>;
  reconnect(): Promise<void>;
  dispose(): void;
}

type Execution = {
  status: "running" | "done" | "error";
  at: number;
  interrupted?: boolean;
  shutdown?: boolean;
  hydrated?: boolean;
};
type Observed<T> = { at: number; value: T };
interface Tracked {
  revision: number;
  generation: number;
  seq?: number;
  deleted?: boolean;
  retired?: boolean;
  execution?: Execution;
  needsRefresh?: boolean;
  title?: Observed<string>;
  agent?: Observed<string>;
  model?: Observed<ModelRef>;
  usage?: Observed<ChildTokenState | undefined>;
}

function tokens(usage: TokenUsageInfo): ChildTokenState | undefined {
  const finite = (value: number) => Number.isFinite(value) && value >= 0 ? value : undefined;
  const input = finite(usage.input);
  const output = finite(usage.output);
  if (input === undefined && output === undefined) return undefined;
  const total = (input ?? 0) + (output ?? 0);
  return { input, output, total: Number.isFinite(total) ? total : undefined };
}
const iso = (at: number) => new Date(at).toISOString();

export function createV2Monitor(input: V2MonitorInput): V2Monitor {
  const current = createEmptyState();
  const tracked = new Map<string, Tracked>();
  let disposed = false;
  let epoch = 0;
  let revision = 0;
  let parentID: string | undefined;
  let failed = false;
  let failureRevision = 0;
  let retries = 0;
  let backoff: RunningReconcileCacheEntry | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  let flight: { epoch: number; promise: Promise<void> } | undefined;
  let reconnectFlight: Promise<void> | undefined;
  let detailsInFlight = 0;
  let inventoriesInFlight = 0;
  const detailQueue: Array<() => void> = [];

  function record(id: string): Tracked {
    let item = tracked.get(id);
    if (!item) {
      item = { revision: 0, generation: 0 };
      tracked.set(id, item);
    }
    return item;
  }
  const stale = () => failed || [...tracked.values()].some(item =>
    !item.deleted && !item.retired && (item.execution?.shutdown || item.needsRefresh));

  function forgetRetired() {
    // Keep watermarks until old reads finish; afterwards history retention also
    // bounds this adapter's terminal bookkeeping. Deletion tombstones remain.
    if (inventoriesInFlight || detailsInFlight || detailQueue.length) return;
    for (const [id, item] of tracked) if (item.retired) tracked.delete(id);
  }

  function publish() {
    if (disposed) return;
    const priorIDs = Object.keys(current.children);
    refreshDerivedFields(current);
    for (const id of priorIDs) {
      const item = tracked.get(id);
      if (item && !current.children[id]) item.retired = true;
    }
    forgetRetired();
    // Give the Solid consumer a fresh reference, and never mutate an earlier signal value.
    input.onChange(structuredClone(current));
  }
  function clearTimers() {
    clearTimeout(retryTimer); retryTimer = undefined;
    clearTimeout(hintTimer); hintTimer = undefined;
  }
  function scheduleRetry() {
    if (disposed || retryTimer || retries >= 6) return;
    backoff = nextBackoffState({ cache: backoff, nowMs: Date.now(), initialBackoffMs: 1_000, maxBackoffMs: 30_000 });
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      retries++;
      void refresh(parentID);
    }, backoff.backoffMs);
  }
  function issue() {
    if (disposed) return;
    failureRevision++;
    failed = true;
    input.onIssue("refresh-failed");
    publish();
    scheduleRetry();
  }

  // Both active discovery and event identity resolution share this four-read bound.
  async function detail(id: string, valid: () => boolean): Promise<SessionInfo | undefined> {
    if (detailsInFlight >= 4) await new Promise<void>(resolve => detailQueue.push(resolve));
    if (!valid()) {
      detailQueue.shift()?.();
      return undefined;
    }
    detailsInFlight++;
    try {
      const info = await input.session.get({ sessionID: id });
      return valid() ? info : undefined;
    } finally {
      detailsInFlight--;
      detailQueue.shift()?.();
    }
  }

  function applyExecution(id: string, item: Tracked) {
    const execution = item.execution;
    const row = current.children[id];
    if (!row || !execution) return;
    if (execution.status === "running") {
      current.children[id] = { ...row, status: "running", color: "yellow",
        endedAt: undefined, elapsedMs: undefined, updatedAt: iso(execution.at) };
    } else {
      markChildStatus(current, id, execution.status, iso(execution.at));
    }
  }

  function applyMetadata(info: SessionInfo, item: Tracked) {
    const row = current.children[info.id];
    if (!row) return;
    // Cache access is by session, never the launch directory or session location.
    const assistant = input.cache.message.list(info.id).filter(message => message.type === "assistant")
      .sort((a, b) => b.time.created - a.time.created)[0];
    const latest = <T>(observed: Observed<T> | undefined, value: T, at = info.time.updated): T =>
      observed && observed.at >= at ? observed.value : value;
    const model = latest(item.model, info.model ?? assistant?.model);
    upsertChildDetails(current, info.id, {
      title: latest(item.title, info.title), agentName: latest(item.agent, info.agent ?? assistant?.agent),
      updatedAt: row.updatedAt,
    });
    setChildModel(current, info.id, model ? {
      providerID: model.providerID, modelID: model.id, variant: model.variant,
    } : undefined);
    if (!item.usage || info.time.updated > item.usage.at) {
      item.usage = { at: info.time.updated, value: tokens(info.tokens) };
    }
    // V1's details helper merges tokens; V2 usage is a replacement, including omissions.
    current.children[info.id].tokens = item.usage.value;
  }

  function hydrate(info: SessionInfo, active: boolean, readRevision: number) {
    if (!info.parentID) return;
    if (!tracked.has(info.id) && !active && !(info.outcome && info.time.idle !== undefined)) return;
    const item = record(info.id);
    if (item.deleted || item.revision > readRevision) return;
    const idle = info.time.idle;
    if (active) {
      if (item.execution?.status !== "running") item.execution = { status: "running", at: Date.now() };
      item.needsRefresh = false;
    } else if (info.outcome && idle !== undefined && Number.isFinite(idle) && idle >= info.time.created &&
      (!item.execution || (item.execution.shutdown ? idle > item.execution.at : idle >= item.execution.at))) {
      item.execution = { status: info.outcome === "succeeded" ? "done" : "error", at: idle,
        interrupted: info.outcome === "interrupted", hydrated: true };
      item.needsRefresh = false;
    }
    insert(info, item);
  }
  function insert(info: SessionInfo, item: Tracked) {
    if (!info.parentID || item.deleted || !item.execution) return;
    item.retired = false;
    upsertRunningChild(current, { id: info.id, parentID: info.parentID, title: info.title ?? info.id,
      source: "session", targetSessionID: info.id, startedAt: iso(info.time.created), updatedAt: iso(item.execution.at) });
    applyMetadata(info, item);
    applyExecution(info.id, item);
  }

  async function readInventory(readEpoch: number): Promise<void> {
    const valid = () => !disposed && epoch === readEpoch;
    const readRevision = revision;
    const readFailureRevision = failureRevision;
    const selectedParent = parentID;
    let readFailed = false;
    // Each branch contains its failure: a failed history page must not cancel active discovery.
    const activeIDs = new Set<string>();
    const activeRead = (async () => {
      try {
        const activity = await input.session.active();
        if (!valid()) return;
        Object.keys(activity).forEach(id => activeIDs.add(id));
        const ids = [...new Set([...activeIDs, ...[...tracked].filter(([id, item]) =>
          !item.deleted && !item.retired && item.execution && !current.children[id]).map(([id]) => id)])];
        let offset = 0;
        await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
          while (offset < ids.length && valid()) {
            const id = ids[offset++];
            const unchanged = () => valid() && (tracked.get(id)?.revision ?? 0) <= readRevision && !tracked.get(id)?.deleted;
            if (!unchanged()) continue;
            try {
              const info = input.cache.get(id) ?? await detail(id, unchanged);
              if (info && unchanged()) { hydrate(info, activeIDs.has(id), readRevision); publish(); }
            } catch { if (unchanged()) readFailed = true; }
          }
        }));
      } catch { if (valid()) readFailed = true; }
    })();
    const historyRead = (async () => {
      try {
        if (!selectedParent) {
          for (const info of input.cache.list()) hydrate(info, activeIDs.has(info.id), readRevision);
          return;
        }
        let cursor: string | undefined;
        const cursors = new Set<string>();
        do {
          const page = await input.session.list({ parentID: selectedParent, limit: 100, cursor });
          if (!valid()) return;
          for (const info of page.data) {
            if (info.parentID === selectedParent) hydrate(info, activeIDs.has(info.id), readRevision);
          }
          publish();
          cursor = page.cursor.next ?? undefined;
          if (cursor && cursors.has(cursor)) { readFailed = true; break; }
          if (cursor) cursors.add(cursor);
        } while (cursor && valid());
      } catch { if (valid()) readFailed = true; }
    })();
    await Promise.all([activeRead, historyRead]);
    if (!valid()) return;
    if (readFailed) issue();
    else if (failureRevision === readFailureRevision) {
      failed = false; retries = 0; backoff = undefined;
      clearTimeout(retryTimer); retryTimer = undefined;
      publish();
    }
  }

  function refresh(selectedParent?: string): Promise<void> {
    if (disposed) return Promise.resolve();
    if (selectedParent !== parentID) {
      parentID = selectedParent; epoch++; clearTimers(); retries = 0; backoff = undefined;
    }
    if (flight?.epoch === epoch) return flight.promise;
    const readEpoch = epoch;
    inventoriesInFlight++;
    const promise = readInventory(readEpoch).finally(() => {
      inventoriesInFlight--;
      forgetRetired();
      if (flight?.promise === promise) flight = undefined;
    });
    flight = { epoch: readEpoch, promise };
    return promise;
  }

  function requestHint() {
    if (disposed || hintTimer || retryTimer) return;
    // Bursty activity is a refresh hint, never an outcome or a zero-delay polling loop.
    hintTimer = setTimeout(() => { hintTimer = undefined; void refresh(parentID); }, 1_000);
  }

  async function accept(event: OpenCodeEvent): Promise<void> {
    if (disposed) return;
    switch (event.type) {
      case "session.status": case "session.idle":
      case "session.step.ended": case "session.step.failed":
      case "session.tool.success": case "session.tool.failed":
      case "session.retry.scheduled":
        requestHint(); return;
      case "session.created": case "session.execution.started":
      case "session.execution.succeeded": case "session.execution.failed":
      case "session.execution.interrupted": case "session.deleted":
      case "session.renamed": case "session.agent.selected":
      case "session.model.selected": case "session.usage.updated": break;
      default: return;
    }
    const id = event.data.sessionID;
    const item = record(id);
    if (item.deleted) return;
    if ("durable" in event) {
      if (item.seq !== undefined && event.durable.seq <= item.seq) return;
      item.seq = event.durable.seq;
    } else if (item.usage && event.created <= item.usage.at) return;
    // A missed terminal read can precede delivery of its earlier start event.
    // Only idle outcome time supplies this boundary, never metadata time.updated.
    if (event.type.startsWith("session.execution.") && item.execution?.hydrated && event.created < item.execution.at) return;
    item.retired = false;
    // Reserve ordering before the first await, including sequence zero.
    item.revision = ++revision;
    const generation = ++item.generation;
    const readEpoch = epoch;
    const valid = () => !disposed && epoch === readEpoch && !item.deleted && item.generation === generation;
    switch (event.type) {
      case "session.deleted":
        item.deleted = true; item.execution = undefined;
        delete current.children[id]; input.cache.invalidate(id); publish(); return;
      case "session.execution.started":
        item.execution = { status: "running", at: event.created }; item.needsRefresh = false; break;
      case "session.execution.succeeded":
      case "session.execution.failed":
        item.execution = { status: event.type === "session.execution.succeeded" ? "done" : "error", at: event.created };
        item.needsRefresh = false; break;
      case "session.execution.interrupted":
        item.execution = { status: "error", at: event.created, interrupted: true, shutdown: event.data.reason === "shutdown" };
        item.needsRefresh = false; break;
      case "session.renamed": item.title = { at: event.created, value: event.data.title }; break;
      case "session.agent.selected": item.agent = { at: event.created, value: event.data.agent }; break;
      case "session.model.selected": item.model = { at: event.created, value: event.data.model }; break;
      case "session.usage.updated": item.usage = { at: event.created, value: tokens(event.data.tokens) }; break;
    }
    try {
      // Known identity needs no network round trip to reflect an authoritative event.
      if (current.children[id]) {
        const cached = input.cache.get(id);
        if (cached) applyMetadata(cached, item);
        else {
          if (event.type === "session.renamed") upsertChildDetails(current, id, { title: event.data.title });
          if (event.type === "session.agent.selected") upsertChildDetails(current, id, { agentName: event.data.agent });
          if (event.type === "session.model.selected") setChildModel(current, id, {
            providerID: event.data.model.providerID, modelID: event.data.model.id, variant: event.data.model.variant,
          });
          if (event.type === "session.usage.updated") current.children[id].tokens = item.usage?.value;
        }
        applyExecution(id, item); publish(); return;
      }
      const info = input.cache.get(id) ?? await detail(id, valid);
      if (!valid() || !info) return;
      if (!info.parentID) { tracked.delete(id); return; }
      // An execution event wins over persisted idle; creation/metadata may discover missed execution.
      if (!item.execution) hydrate(info, false, item.revision);
      else insert(info, item);
      publish();
    } catch { if (valid()) issue(); }
  }

  function reconnect(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (reconnectFlight) return reconnectFlight;
    epoch++; clearTimers(); retries = 0; backoff = undefined; failed = true;
    for (const [id, item] of tracked) {
      input.cache.invalidate(id);
      if (item.execution?.status === "running") item.needsRefresh = true;
    }
    publish();
    const promise = refresh(parentID).finally(() => {
      if (reconnectFlight === promise) reconnectFlight = undefined;
    });
    reconnectFlight = promise;
    return promise;
  }

  return {
    state: () => current, hint: id => current.children[id] && tracked.get(id)?.execution?.interrupted ? "interrupted" : undefined,
    stale, accept, refresh, reconnect,
    dispose() {
      if (disposed) return;
      disposed = true; epoch++; clearTimers();
      detailQueue.splice(0).forEach(resolve => resolve());
      tracked.clear();
    },
  };
}
