import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiPromptRef,
  TuiSlotContext,
} from "@opencode-ai/plugin/tui";
import { useKeyboard } from "@opentui/solid";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import {
  Show,
  createRoot,
  createEffect,
  createSignal,
  onCleanup,
} from "solid-js";
import {
  applySubagentEvent,
  extractChildDetails,
  extractLatestAssistantModel,
  extractTaskToolEvidence,
} from "./events.js";
import { readOpenCodeLogFileIfSmall } from "./logs.js";
import { byPriority, renderStatusLine, visibleSubagentWorkItems } from "./render.js";
import {
  canSafelyCloseNoTargetPersistedCandidate,
  capCandidates,
  deriveOpenCodeSessionStatus,
  hasRecentMessageActivity,
  nextBackoffState,
  parseStaleRunningThresholdMs as parseConfiguredStaleRunningThresholdMs,
  resolvePersistedStaleSubtaskFromParentMessages,
  resolveSessionStatusWithMessageSummary,
  shouldApplyStaleRunningFallback,
  shouldSkipCandidateForBackoff,
  summarizeSessionMessages,
  type PersistedStaleSubtaskCandidate,
  type RunningReconcileCacheEntry,
  type RunningReconcileEvidence,
  type SessionMessageSummary,
} from "./reconcile.js";
import {
  focusPromptWithDeferredRetry,
  resolveSidebarReturnFocusAction,
  resolveSiblingSidebarRefocus,
  type PendingSidebarRefocus,
} from "./tui-focus.js";
import {
  createEmptyState,
  markChildStatus,
  refreshDerivedFields,
  resolveStatePath,
  resolveTextPath,
  saveState,
  saveStatusText,
  setChildModel,
  upsertChildDetails,
  type ChildTokenState,
  type ChildSessionState,
  type StatuslineState,
} from "./state.js";
import { truncateToColumns } from "./text-width.js";
import { registerSubagentCommands } from "./tui-commands.js";
import {
  createSidebarViewController,
  HomeBottomStatus,
  SidebarSubagents,
  isSessionTarget,
  resolveChildTargetSessionID,
  resolveSyntheticTargetFromHydratedState,
} from "./tui-view.js";
export {
  preservedSidebarAnchorScrollTop,
  preservedSidebarScrollTop,
  resolveSidebarSubagentSnapshot,
  resolveTuiSubagentSnapshot,
  subagentRowHeight,
  wrapCompactText,
  type SidebarScrollAnchor,
  type SidebarScrollRowLayout,
  type TuiSubagentSnapshot,
} from "./tui-view.js";

const TUI_PLUGIN_ID = "subagent-statusline.tui";
const ELAPSED_TICK_MS = 1000;
const DONE_TOKEN_REHYDRATE_THROTTLE_MS = 2000;
const DONE_TOKEN_REHYDRATE_MAX_ATTEMPTS = 15;
const MAINTENANCE_TICK_MS = DONE_TOKEN_REHYDRATE_THROTTLE_MS;
const HYDRATE_RETRY_BASE_DELAY_MS = 1000;
const HYDRATE_RETRY_MAX_DELAY_MS = 30_000;
const HYDRATE_RETRY_MAX_ATTEMPTS = 6;
const RUNNING_RECONCILE_MAINTENANCE_INTERVAL_MS = 10 * 60_000;
const RUNNING_RECONCILE_MAX_CANDIDATES = 8;
const RUNNING_RECONCILE_INITIAL_BACKOFF_MS = 15_000;
const RUNNING_RECONCILE_MAX_BACKOFF_MS = 5 * 60_000;
const RUNNING_RECONCILE_MESSAGE_AGE_GATE_MS = 60_000;
const RUNNING_RECONCILE_OLD_CANDIDATE_AGE_MS = 5 * 60_000;
const SUBAGENTS_EXPANDED_KV_KEY = "subagents.sidebar.expanded";
const SUBAGENTS_SECTION_ENABLED_KV_KEY = "subagents.sidebar.enabled";

type SidebarContentContext = TuiSlotContext & { session_id?: string };
type HomeBottomContext = TuiSlotContext;
type PromptRefProp =
  | ((ref: TuiPromptRef | undefined) => void)
  | { current?: TuiPromptRef | undefined }
  | undefined;
type HomePromptProps = {
  workspaceID?: string;
  workspace_id?: string;
  ref?: PromptRefProp;
  [key: string]: unknown;
};
type SessionPromptProps = {
  sessionID?: string;
  session_id?: string;
  right?: unknown;
  visible?: boolean;
  disabled?: boolean;
  onSubmit?: () => void;
  on_submit?: () => void;
  ref?: PromptRefProp;
  [key: string]: unknown;
};

interface RehydratedTokenCacheEntry {
  attempts: number;
  checkedAtMs: number;
  tokens?: ChildTokenState;
}

interface RunningReconcileCandidate {
  childID: string;
  targetSessionID?: string;
  parentID?: string;
  messageID?: string;
  source?: ChildSessionState["source"];
  title?: string;
  summary?: string;
  agentName?: string;
  startedMs: number;
  updatedMs: number;
}

const doneTokenCache = new Map<string, RehydratedTokenCacheEntry>();

function debugLog(input: Record<string, unknown>): void {
  if (!process.env.OPENCODE_SUBAGENT_STATUSLINE_DEBUG_EVENTS) return;
  try {
    const path = join(
      process.env.XDG_RUNTIME_DIR ?? os.tmpdir(),
      "opencode-subagent-statusline",
      "tui-events.log",
    );
    mkdirSync(dirname(path), { recursive: true });
    const line = JSON.stringify({ time: new Date().toISOString(), ...input });
    appendFileSync(path, `${line}\n`, "utf8");
  } catch {
    // Debug logging must never crash the TUI.
  }
}

function debugEvent(event: unknown): void {
  const e = event as {
    type?: unknown;
    properties?: { sessionID?: unknown; part?: unknown; info?: unknown };
  };
  const part = e.properties?.part as
    | { type?: unknown; tool?: unknown; state?: { status?: unknown } }
    | undefined;
  debugLog({
    kind: "event",
    type: e.type,
    sessionID: e.properties?.sessionID,
    partType: part?.type,
    tool: part?.tool,
    toolStatus: part?.state?.status,
  });
}

function cloneState(state: StatuslineState): StatuslineState {
  return {
    updatedAt: state.updatedAt,
    totalExecuted: state.totalExecuted,
    countedChildIDs: { ...state.countedChildIDs },
    children: Object.fromEntries(
      Object.entries(state.children).map(([id, child]) => [
        id,
        {
          ...child,
          tokens: child.tokens ? { ...child.tokens } : undefined,
          model: child.model ? { ...child.model } : undefined,
        },
      ]),
    ),
  };
}

function mergeTokenState(
  existing: ChildTokenState | undefined,
  incoming: ChildTokenState | undefined,
): ChildTokenState | undefined {
  if (!existing && !incoming) return undefined;
  return {
    input: incoming?.input ?? existing?.input,
    output: incoming?.output ?? existing?.output,
    total: incoming?.total ?? existing?.total,
    contextPercent: incoming?.contextPercent ?? existing?.contextPercent,
  };
}

function hasTokenTotal(tokens: ChildTokenState | undefined): boolean {
  return typeof tokens?.total === "number" && Number.isFinite(tokens.total);
}

function sameTokens(
  left: ChildTokenState | undefined,
  right: ChildTokenState | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function tokenStateFromMessageData(data: string): ChildTokenState | undefined {
  const parsed = safeRead(
    () => JSON.parse(data) as { tokens?: ChildTokenState },
  );
  return parsed?.tokens;
}

function resolveOpenCodeDataDir(): string {
  return join(
    process.env.XDG_DATA_HOME ?? join(os.homedir(), ".local", "share"),
    "opencode",
  );
}

function resolveOpenCodeDbPath(): string {
  return (
    process.env.OPENCODE_SUBAGENT_STATUSLINE_OPENCODE_DB ??
    join(resolveOpenCodeDataDir(), "opencode.db")
  );
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function readDoneTokensFromOpenCodeDb(
  sessionID: string,
): ChildTokenState | undefined {
  const dbPath = resolveOpenCodeDbPath();
  if (!existsSync(dbPath)) return undefined;

  // Keep JSON parsing in TypeScript instead of relying on sqlite JSON functions.
  // Some sqlite3 builds, especially on WSL/Linux distributions, are compiled
  // without JSON support and fail with `no such function json_extract`.
  const output = safeRead(() =>
    execFileSync(
      "sqlite3",
      [
        dbPath,
        `select data from message where session_id='${escapeSqlString(sessionID)}' order by time_created desc limit 50;`,
      ],
      { encoding: "utf8", timeout: 1000, maxBuffer: 1024 * 1024 },
    ),
  );
  if (!output) return undefined;

  let tokens: ChildTokenState | undefined;
  for (const line of output.split("\n")) {
    const hydrated = tokenStateFromMessageData(line.trim());
    tokens = mergeTokenState(tokens, hydrated);
    if (hasTokenTotal(tokens)) break;
  }
  return tokens;
}

function readDoneTokensFromOpenCodeLogs(
  sessionID: string,
): ChildTokenState | undefined {
  const logDir = join(resolveOpenCodeDataDir(), "log");
  if (!existsSync(logDir)) return undefined;

  const files = safeRead(() =>
    readdirSync(logDir)
      .filter((file) => file.endsWith(".log"))
      .sort()
      .reverse()
      .slice(0, 8),
  );
  if (!files) return undefined;

  const tokenPattern = /"tokens"\s*:\s*(\{[^\n]*?\})/g;
  let tokens: ChildTokenState | undefined;
  for (const file of files) {
    const contents = readOpenCodeLogFileIfSmall(join(logDir, file));
    if (!contents || !contents.includes(sessionID)) continue;

    for (const line of contents.split("\n")) {
      if (!line.includes(sessionID) || !line.includes('"tokens"')) continue;
      for (const match of line.matchAll(tokenPattern)) {
        const hydrated = safeRead(
          () => JSON.parse(match[1] ?? "{}") as ChildTokenState,
        );
        tokens = mergeTokenState(tokens, hydrated);
        if (hasTokenTotal(tokens)) return tokens;
      }
    }
  }
  return tokens;
}

function rehydrateDoneChildTokens(
  child: ChildSessionState,
): ChildTokenState | undefined {
  if (child.status !== "done") return undefined;
  if (hasTokenTotal(child.tokens)) return undefined;
  if (!child.id.startsWith("ses_")) return undefined;

  const nowMs = Date.now();
  const cached = doneTokenCache.get(child.id);
  if (cached?.tokens) return cached.tokens;
  if (cached && cached.attempts >= DONE_TOKEN_REHYDRATE_MAX_ATTEMPTS) {
    return undefined;
  }
  if (cached && nowMs - cached.checkedAtMs < DONE_TOKEN_REHYDRATE_THROTTLE_MS) {
    return undefined;
  }

  const tokens =
    readDoneTokensFromOpenCodeDb(child.id) ??
    readDoneTokensFromOpenCodeLogs(child.id);
  doneTokenCache.set(child.id, {
    attempts: (cached?.attempts ?? 0) + 1,
    checkedAtMs: nowMs,
    tokens,
  });

  if (tokens) {
    debugLog({
      kind: "state.tokens.rehydrated.done",
      id: child.id,
      title: child.title,
      tokens,
    });
  }

  return tokens;
}

function safeRead<Value>(read: () => Value): Value | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function messageIDOf(message: unknown): string | undefined {
  const record = asRecord(message);
  if (!record) return undefined;
  const id = record.id ?? record.messageID ?? record.messageId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function pushSessionCandidates(
  api: TuiPluginApi,
  sessionID: string | undefined,
  candidates: unknown[],
): void {
  if (!sessionID) return;

  const status = safeRead(() => api.state.session.status(sessionID));
  if (status) candidates.push(status);

  const messages = safeRead(() => api.state.session.messages(sessionID));
  if (!messages) return;

  candidates.push(messages);
  for (const message of messages) {
    const messageID = messageIDOf(message);
    if (!messageID) continue;
    const parts = safeRead(() => api.state.part(messageID));
    if (parts) candidates.push(parts);
  }
}

function hydrateChildTokensFromTuiState(
  api: TuiPluginApi,
  child: ChildSessionState,
): ChildTokenState | undefined {
  const candidates: unknown[] = [];

  pushSessionCandidates(api, child.id, candidates);

  if (child.messageID) {
    const parentParts = safeRead(() =>
      api.state.part(child.messageID as string),
    );
    if (parentParts) candidates.push(parentParts);

    const parentMessages = safeRead(() =>
      api.state.session.messages(child.parentID),
    );
    const parentMessage = parentMessages?.find(
      (message) => messageIDOf(message) === child.messageID,
    );
    if (parentMessage) candidates.push(parentMessage);
  }

  let tokens: ChildTokenState | undefined;
  for (const candidate of candidates) {
    tokens = mergeTokenState(
      tokens,
      extractChildDetails(
        candidate as Parameters<typeof extractChildDetails>[0],
      ).tokens,
    );
  }

  tokens = mergeTokenState(tokens, rehydrateDoneChildTokens(child));

  return tokens;
}

function hydrateStateTokensFromTuiState(
  api: TuiPluginApi,
  state: StatuslineState,
): boolean {
  let changed = false;

  for (const child of Object.values(state.children)) {
    if (child.status !== "running" && hasTokenTotal(child.tokens)) continue;
    const hydrated = hydrateChildTokensFromTuiState(api, child);
    const nextTokens = mergeTokenState(child.tokens, hydrated);
    if (!sameTokens(child.tokens, nextTokens)) {
      child.tokens = nextTokens;
      child.updatedAt = new Date().toISOString();
      changed = true;
    }
  }

  if (changed) {
    state.updatedAt = new Date().toISOString();
    debugLog({
      kind: "state.tokens.hydrated",
      children: Object.values(state.children).map((child) => ({
        id: child.id,
        title: child.title,
        tokens: child.tokens,
      })),
    });
  }

  return changed;
}

function persistStateSnapshot(
  statePath: string,
  textPath: string,
  state: StatuslineState,
): void {
  const snapshot = cloneState(state);
  void (async () => {
    try {
      await saveState(statePath, snapshot);
      await saveStatusText(textPath, renderStatusLine(snapshot));
    } catch {
      // Persistence is best-effort; TUI rendering must not fail because of files.
    }
  })();
}

function refreshLiveState(state: StatuslineState): boolean {
  const beforeChildIDs = new Set(Object.keys(state.children));
  refreshDerivedFields(state);

  if (Object.keys(state.children).length !== beforeChildIDs.size) {
    return true;
  }

  for (const childID of beforeChildIDs) {
    if (!state.children[childID]) return true;
  }

  return false;
}

export function runTuiStateMaintenance(
  api: TuiPluginApi,
  current: StatuslineState,
): StatuslineState {
  const next = cloneState(current);
  const hydrated = hydrateStateTokensFromTuiState(api, next);
  const refreshed = refreshLiveState(next);
  return hydrated || refreshed ? next : current;
}

export function createTuiMaintenanceTimers(input: {
  onElapsedTick: () => void;
  onMaintenanceTick: () => void;
}): {
  syncElapsedTimer: (hasRunningChild: boolean) => void;
  dispose: () => void;
} {
  let elapsedTimer: ReturnType<typeof setInterval> | undefined;
  const maintenanceTimer = setInterval(
    input.onMaintenanceTick,
    MAINTENANCE_TICK_MS,
  );

  return {
    syncElapsedTimer(hasRunningChild) {
      if (hasRunningChild && !elapsedTimer) {
        elapsedTimer = setInterval(input.onElapsedTick, ELAPSED_TICK_MS);
      } else if (!hasRunningChild && elapsedTimer) {
        clearInterval(elapsedTimer);
        elapsedTimer = undefined;
      }
    },
    dispose() {
      if (elapsedTimer) clearInterval(elapsedTimer);
      clearInterval(maintenanceTimer);
      elapsedTimer = undefined;
    },
  };
}

export function backfillHydratedTargetSessionIDs(
  state: StatuslineState,
  parentSessionID: string,
): boolean {
  let changed = false;

  for (const child of Object.values(state.children)) {
    if (child.parentID !== parentSessionID) continue;
    if (resolveChildTargetSessionID(child)) continue;
    if (child.source === "session" || child.id.startsWith("ses_")) {
      child.targetSessionID = child.id;
      changed = true;
      continue;
    }

    const syntheticTarget = resolveSyntheticTargetFromHydratedState(
      state,
      child,
    );
    if (syntheticTarget) {
      child.targetSessionID = syntheticTarget;
      changed = true;
    }
  }

  if (changed) {
    state.updatedAt = new Date().toISOString();
  }

  return changed;
}

function navigateToSessionTarget(
  api: TuiPluginApi,
  targetSessionID: string | undefined,
): void {
  if (!isSessionTarget(targetSessionID)) return;

  // Verified against local typings in `@opencode-ai/plugin/dist/tui.d.ts`:
  // api.route.navigate(name: string, params?: Record<string, unknown>)
  api.route.navigate("session", { sessionID: targetSessionID });
}

function toFinitePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : undefined;
}

function parseStaleRunningThresholdMs(): number {
  return parseConfiguredStaleRunningThresholdMs(
    process.env.OPENCODE_SUBAGENT_STATUSLINE_STALE_RUNNING_MS,
  );
}

const STALE_RUNNING_THRESHOLD_MS = parseStaleRunningThresholdMs();

function resolveSidebarWidth(ctx: unknown): number | undefined {
  const source = asRecord(ctx);
  if (!source) return undefined;

  const direct =
    toFinitePositiveInt(source.width) ??
    toFinitePositiveInt(source.columns) ??
    toFinitePositiveInt(source.cols);
  if (direct) return direct;

  const size = asRecord(source.size);
  const viewport = asRecord(source.viewport);
  const bounds = asRecord(source.bounds);

  return (
    toFinitePositiveInt(size?.width) ??
    toFinitePositiveInt(viewport?.width) ??
    toFinitePositiveInt(bounds?.width)
  );
}

export function formatChildModelLine(
  child: ChildSessionState,
  providers: TuiPluginApi["state"]["provider"],
  width: number,
): string | undefined {
  if (!child.model?.variant) return undefined;
  const provider = providers.find(
    (candidate) => candidate.id === child.model?.providerID,
  );
  const name = provider?.models[child.model.modelID]?.name || child.model.modelID;
  return truncateToColumns(`${name} · ${child.model.variant}`, Math.max(1, width));
}


export async function hydratePreviousSubagents(
  api: TuiPluginApi,
  currentSessionID: string,
  statePath: string,
  textPath: string,
  setState: (fn: (prev: StatuslineState) => StatuslineState) => void,
): Promise<boolean> {
  if (!currentSessionID) return false;

  try {
    const directory = api.state.path.directory;
    const sessionClient = api.client.session;
    let topLevelHydrationFailed = false;
    let statusHydrationFailed = false;
    let parentMessageHydrationFailed = false;

    const [childrenResp, messagesResp, statusResp] = await Promise.all([
      (async () => {
        const response = await safeReadAsync(
          () =>
            sessionClient?.children?.({
              sessionID: currentSessionID,
              directory,
            }) ?? Promise.resolve({ data: [] }),
        );
        if (!response) topLevelHydrationFailed = true;
        return response;
      })(),
      (async () => {
        const response = await safeReadAsync(
          () =>
            sessionClient?.messages?.({
              sessionID: currentSessionID,
              directory,
            }) ?? Promise.resolve({ data: [] }),
        );
        if (!response) {
          topLevelHydrationFailed = true;
          parentMessageHydrationFailed = true;
        }
        return response;
      })(),
      (async () => {
        const response = await safeReadAsync(
          () =>
            sessionClient?.status?.({ directory }) ??
            Promise.resolve({ data: {} }),
        );
        if (!response) {
          topLevelHydrationFailed = true;
          statusHydrationFailed = true;
        }
        return response;
      })(),
    ]);

    const children = Array.isArray(childrenResp?.data) ? childrenResp.data : [];
    const messages = Array.isArray(messagesResp?.data) ? messagesResp.data : [];
    const allStatuses = asRecord(statusResp?.data) ?? {};
    const parentTaskEvidenceByChildID =
      collectParentTaskEvidenceByChildSessionID(messages, currentSessionID);
    let childHydrationFailed = false;
    const childMessageResults: Array<
      SessionMessageSummary & {
        childID?: string;
        fetchFailed: boolean;
        model?: ReturnType<typeof extractLatestAssistantModel>;
      }
    > = await Promise.all(
      children.map(async (child) => {
        const session = asRecord(child);
        const childID =
          typeof session?.id === "string" ? session.id : undefined;
        if (!childID) {
          return {
            childID: undefined,
            completedAt: undefined,
            evidenceAt: undefined,
            hasError: false,
            fetchFailed: false,
          };
        }
        const childMessagesResp = await safeReadAsync(
          () =>
            sessionClient?.messages?.({ sessionID: childID, directory }) ??
            Promise.resolve({ data: [] }),
        );
        let fetchFailed = false;
        if (!childMessagesResp) {
          childHydrationFailed = true;
          fetchFailed = true;
        }
        const childMessages = Array.isArray(childMessagesResp?.data)
          ? childMessagesResp.data
          : [];
        return {
          childID,
          ...summarizeSessionMessages(childMessages),
          model: extractLatestAssistantModel(childMessages),
          fetchFailed,
        };
      }),
    );
    const childMessageSummaryByID = new Map(
      childMessageResults
        .filter((result) => result.childID)
        .map((result) => [result.childID as string, result]),
    );

    setState((current) => {
      const next = cloneState(current);
      let changed = false;

      for (const rawSession of children) {
        const session = asRecord(rawSession);
        if (!session || typeof session.id !== "string") continue;
        const status = allStatuses[session.id];
        const sessionStatus = deriveSessionChildStatus(status);
        const childSummary = childMessageSummaryByID.get(session.id);
        const hasHydrationEvidence = shouldHydrateSessionChild({
          childID: session.id,
          sessionStatus,
          childSummary,
          parentTaskEvidenceByChildID,
        });
        const parentTaskEvidence = parentTaskEvidenceByChildID.get(session.id);
        const explicitCompletionEvidence =
          !!childSummary &&
          !childSummary.fetchFailed &&
          (typeof childSummary.completedAt === "string" ||
            childSummary.hasError);
        const fallbackEndedAt =
          childSummary?.completedAt ?? childSummary?.evidenceAt;
        const statusEndedAt =
          fallbackEndedAt ??
          sessionTimestamp(session, "completed") ??
          sessionTimestamp(session, "updated");
        const shouldHydrateChildFromSession = hasHydrationEvidence;

        if (!shouldHydrateChildFromSession) {
          const existing = next.children[session.id];
          if (
            !statusHydrationFailed &&
            !parentMessageHydrationFailed &&
            !!childSummary &&
            !childSummary.fetchFailed &&
            existing?.parentID === currentSessionID &&
            existing.source === "session" &&
            existing.status === "running"
          ) {
            delete next.children[session.id];
            changed = true;
          }
          continue;
        }

        const fakeEvent = {
          type: "session.created",
          properties: {
            sessionID: session.id,
            info: session,
          },
        };
        if (applySubagentEvent(next, fakeEvent)) changed = true;
        if (childSummary?.model) {
          changed =
            setChildModel(
              next,
              session.id,
              childSummary.model.model,
              childSummary.model.updatedAt,
            ) || changed;
        }

        const resolvedStatus = resolveSessionStatusWithMessageSummary({
          status: sessionStatus ?? parentTaskEvidence?.status,
          summary: childSummary,
        });

        if (
          resolvedStatus.status === "done" ||
          resolvedStatus.status === "error"
        ) {
          if (
            markChildStatus(
              next,
              session.id,
              resolvedStatus.status,
              resolvedStatus.endedAt ??
                parentTaskEvidence?.endedAt ??
                statusEndedAt,
            )
          )
            changed = true;
          continue;
        }

        if (
          !sessionStatus &&
          !statusHydrationFailed &&
          explicitCompletionEvidence
        ) {
          const childStatus = childSummary?.hasError ? "error" : "done";
          if (markChildStatus(next, session.id, childStatus, fallbackEndedAt))
            changed = true;
        }
      }

      for (const rawMessage of messages) {
        const message = asRecord(rawMessage);
        const info = asRecord(message?.info);
        const parts = Array.isArray(message?.parts) ? message.parts : [];
        const parentMessageID = messageIDOf(message);
        const isAssistant = info?.role === "assistant";
        const time = asRecord(info?.time);
        const eventInfo = {
          id: typeof info?.id === "string" ? info.id : undefined,
          role: typeof info?.role === "string" ? info.role : undefined,
          parentID:
            typeof info?.parentID === "string" ? info.parentID : undefined,
          time,
        };
        const completedAt = timestampFromUnknown(time?.completed);
        const isCompleted = typeof completedAt === "string";
        const hasError = !!info?.error;

        for (const rawPart of parts) {
          const part = asRecord(rawPart);
          if (!part) continue;
          const partWithMessageID =
            typeof part.messageID === "string" && part.messageID.length > 0
              ? part
              : parentMessageID
                ? { ...part, messageID: parentMessageID }
                : part;
          if (
            part.type === "subtask" ||
            (part.type === "tool" &&
              (part.tool === "delegate" || part.tool === "task"))
          ) {
            const fakeEvent = {
              type: "message.part.updated",
              properties: {
                sessionID: currentSessionID,
                info: eventInfo,
                part: partWithMessageID,
              },
            };
            if (applySubagentEvent(next, fakeEvent)) changed = true;

            if (part.type === "subtask" && isAssistant && isCompleted) {
              const childID = `subtask:${part.id}`;
              const status = hasError ? "error" : "done";
              if (markChildStatus(next, childID, status, completedAt))
                changed = true;
            }
          }
        }
      }

      if (backfillHydratedTargetSessionIDs(next, currentSessionID)) {
        changed = true;
      }

      const refreshed = refreshLiveState(next);
      if (!changed && !refreshed) return current;
      persistStateSnapshot(statePath, textPath, next);
      return next;
    });
    if (topLevelHydrationFailed || childHydrationFailed) return false;
    return true;
  } catch (err) {
    debugLog({
      kind: "hydration.error",
      sessionID: currentSessionID,
      error: String(err),
    });
    return false;
  }
}

function shouldHydrateSessionChild(input: {
  childID: string;
  sessionStatus?: ChildSessionState["status"];
  childSummary?: SessionMessageSummary;
  parentTaskEvidenceByChildID: ReadonlyMap<string, ParentTaskEvidence>;
}): boolean {
  if (input.sessionStatus) return true;
  if (input.parentTaskEvidenceByChildID.has(input.childID)) return true;

  const summary = input.childSummary;
  if (!summary || summary.fetchFailed) return false;

  return (
    summary.hasError === true ||
    typeof summary.completedAt === "string" ||
    typeof summary.evidenceAt === "string" ||
    typeof summary.latestAssistantActivityAt === "string" ||
    typeof summary.latestMessageActivityAt === "string"
  );
}

type ParentTaskEvidence = {
  status: ChildSessionState["status"];
  endedAt?: string;
};

function collectParentTaskEvidenceByChildSessionID(
  messages: unknown[],
  parentSessionID: string,
): Map<string, ParentTaskEvidence> {
  const evidenceByID = new Map<string, ParentTaskEvidence>();
  for (const rawMessage of messages) {
    const message = asRecord(rawMessage);
    const info = asRecord(message?.info);
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    for (const rawPart of parts) {
      const part = asRecord(rawPart);
      if (!part || part.type !== "tool" || part.tool !== "task") continue;
      const state = asRecord(part.state);
      const metadata = asRecord(state?.metadata);
      const childID =
        typeof metadata?.sessionId === "string"
          ? metadata.sessionId
          : undefined;
      if (!childID || childID === parentSessionID) continue;

      const taskEvidence = extractTaskToolEvidence({
        type: "message.part.updated",
        properties: {
          sessionID: parentSessionID,
          info: {
            time: info?.time,
          },
          part: rawPart,
        },
      });
      evidenceByID.set(childID, {
        status: taskEvidence?.status ?? "running",
        endedAt: taskEvidence?.endedAt,
      });
    }
  }
  return evidenceByID;
}

async function safeReadAsync<Value>(
  read: () => Promise<Value>,
): Promise<Value | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

function deriveSessionChildStatus(
  status: unknown,
): ChildSessionState["status"] | undefined {
  return deriveOpenCodeSessionStatus(status);
}

function sessionTimestamp(
  session: Record<string, unknown>,
  key: string,
): string | undefined {
  const time = asRecord(session.time);
  return timestampFromUnknown(time?.[key]);
}

function timestampFromUnknown(value: unknown): string | undefined {
  const millis = timestampMillisFromUnknown(value);
  return millis === undefined ? undefined : new Date(millis).toISOString();
}

function timestampMillisFromUnknown(value: unknown): number | undefined {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? undefined : millis;
  }
  return undefined;
}

function resolveRouteSessionID(api: TuiPluginApi): string | undefined {
  return api.route.current.name === "session" &&
    typeof api.route.current.params?.sessionID === "string"
    ? api.route.current.params.sessionID
    : undefined;
}

function resolveRunningChildAgeMillis(
  child: ChildSessionState,
  nowMs: number,
): {
  startedMs: number;
  updatedMs: number;
} {
  const startedMs = Date.parse(child.startedAt);
  const updatedMs = Date.parse(child.updatedAt);
  return {
    startedMs: Number.isNaN(startedMs) ? 0 : Math.max(0, nowMs - startedMs),
    updatedMs: Number.isNaN(updatedMs) ? 0 : Math.max(0, nowMs - updatedMs),
  };
}

function resolveReconcileTargetSessionID(
  state: StatuslineState,
  child: ChildSessionState,
): string | undefined {
  return (
    resolveChildTargetSessionID(child) ??
    resolveSyntheticTargetFromHydratedState(state, child)
  );
}

function selectRunningReconcileCandidates(input: {
  state: StatuslineState;
  currentSessionID?: string;
  nowMs: number;
  maxCandidates: number;
}): RunningReconcileCandidate[] {
  const runningChildren = Object.values(input.state.children).filter(
    (child) => child.status === "running",
  );
  if (runningChildren.length === 0) return [];

  const prioritized = visibleSubagentWorkItems(
    runningChildren,
    input.nowMs,
  ).sort(byPriority);
  const prioritizedForSession = prioritized.filter((child) =>
    input.currentSessionID ? child.parentID === input.currentSessionID : true,
  );

  const veryOldIDs = new Set(
    runningChildren
      .filter((child) => {
        const age = resolveRunningChildAgeMillis(child, input.nowMs);
        return (
          age.startedMs >= RUNNING_RECONCILE_OLD_CANDIDATE_AGE_MS ||
          age.updatedMs >= RUNNING_RECONCILE_OLD_CANDIDATE_AGE_MS
        );
      })
      .map((child) => child.id),
  );

  const ordered = [
    ...prioritizedForSession,
    ...runningChildren.filter((child) => veryOldIDs.has(child.id)),
  ];

  const selected: RunningReconcileCandidate[] = [];
  const seen = new Set<string>();
  for (const child of ordered) {
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    const age = resolveRunningChildAgeMillis(child, input.nowMs);
    const targetSessionID = resolveReconcileTargetSessionID(input.state, child);
    const canProbePersistedSubtask =
      child.source === "subtask" &&
      !targetSessionID &&
      typeof child.parentID === "string" &&
      child.parentID.length > 0 &&
      typeof child.messageID === "string" &&
      child.messageID.length > 0 &&
      (age.startedMs >= RUNNING_RECONCILE_OLD_CANDIDATE_AGE_MS ||
        age.updatedMs >= RUNNING_RECONCILE_OLD_CANDIDATE_AGE_MS);
    if (!targetSessionID && !canProbePersistedSubtask) continue;
    selected.push({
      childID: child.id,
      targetSessionID,
      parentID: child.parentID,
      messageID: child.messageID,
      source: child.source,
      title: child.title,
      summary: child.summary,
      agentName: child.agentName,
      startedMs: age.startedMs,
      updatedMs: age.updatedMs,
    });
    if (selected.length >= input.maxCandidates) break;
  }

  return capCandidates(selected, input.maxCandidates);
}

export async function probeRunningEvidence(input: {
  api: TuiPluginApi;
  targetSessionID: string;
  directory: string;
  candidateAgeMs: number;
  nowMs: number;
}): Promise<RunningReconcileEvidence> {
  let probeFailed = false;

  const directStatus = safeRead(() =>
    input.api.state.session.status(input.targetSessionID),
  );
  if (directStatus === undefined) probeFailed = true;
  const statusFromState = deriveSessionChildStatus(directStatus);
  if (statusFromState === "error") {
    return { status: statusFromState, endedAt: new Date().toISOString() };
  }
  if (statusFromState === "running") {
    return { status: "running", sawRunningEvidence: true };
  }

  const doneFromState = statusFromState === "done";
  let doneFromClient = false;

  const statusResp = await safeReadAsync(() =>
    input.api.client.session.status({ directory: input.directory }),
  );
  if (statusResp === undefined) probeFailed = true;
  const statuses = asRecord(statusResp?.data);
  const statusFromClient = deriveSessionChildStatus(
    statuses?.[input.targetSessionID],
  );
  if (statusFromClient === "error") {
    return { status: statusFromClient, endedAt: new Date().toISOString() };
  }
  if (statusFromClient === "running") {
    return { status: "running", sawRunningEvidence: true };
  }
  doneFromClient = statusFromClient === "done";

  const hasDoneStatus = doneFromState || doneFromClient;

  if (
    !hasDoneStatus &&
    input.candidateAgeMs < RUNNING_RECONCILE_MESSAGE_AGE_GATE_MS
  ) {
    return { probeFailed, canApplyStaleFallback: false };
  }

  const messagesResp = await safeReadAsync(() =>
    input.api.client.session.messages({
      sessionID: input.targetSessionID,
      directory: input.directory,
    }),
  );
  if (messagesResp === undefined || !Array.isArray(messagesResp?.data)) {
    if (hasDoneStatus) {
      return {
        status: "done",
        endedAt: new Date().toISOString(),
        checkedMessages: false,
        probeFailed: true,
        canApplyStaleFallback: false,
      };
    }
    return {
      checkedMessages: false,
      probeFailed: true,
      canApplyStaleFallback: false,
    };
  }
  const messages = Array.isArray(messagesResp?.data) ? messagesResp.data : [];
  const summary = summarizeSessionMessages(messages);
  const resolvedStatus = resolveSessionStatusWithMessageSummary({
    status: hasDoneStatus ? "done" : undefined,
    summary,
  });

  if (resolvedStatus.status === "error") {
    return {
      status: "error",
      endedAt: resolvedStatus.endedAt,
      checkedMessages: true,
      canApplyStaleFallback: false,
    };
  }

  if (resolvedStatus.status === "done") {
    return {
      status: "done",
      endedAt: resolvedStatus.endedAt ?? new Date().toISOString(),
      checkedMessages: true,
      canApplyStaleFallback: false,
    };
  }

  if (
    hasRecentMessageActivity({
      nowMs: input.nowMs,
      latestMessageActivityAtMs: summary.latestMessageActivityAtMs,
      staleThresholdMs: STALE_RUNNING_THRESHOLD_MS,
    })
  ) {
    return {
      checkedMessages: true,
      sawRunningEvidence: true,
      endedAt: summary.latestMessageActivityAt,
      probeFailed,
      canApplyStaleFallback: false,
    };
  }

  return {
    checkedMessages: true,
    probeFailed,
    canApplyStaleFallback: !probeFailed,
  };
}

function initializeTui(api: TuiPluginApi, disposeRoot: () => void): void {
  const view = createSidebarViewController();
  onCleanup(() => view.dispose());
  const statePath = resolveStatePath();
  const textPath = resolveTextPath(statePath);
  const [state, setState] = createSignal<StatuslineState>(createEmptyState());
  const [nowMs, setNowMs] = createSignal(Date.now());
  const [hydratedSessions, setHydratedSessions] = createSignal<Set<string>>(
    new Set(),
  );
  const [hydratingSessions, setHydratingSessions] = createSignal<Set<string>>(
    new Set(),
  );
  const [hydrateRetryPendingSessions, setHydrateRetryPendingSessions] =
    createSignal<Set<string>>(new Set());
  const [hydrateRetryAttempts, setHydrateRetryAttempts] = createSignal<
    Map<string, number>
  >(new Map());
  const [hydrateRetryTick, setHydrateRetryTick] = createSignal(0);
  const [subagentsExpanded, setSubagentsExpanded] = createSignal(
    api.kv.get<boolean>(SUBAGENTS_EXPANDED_KV_KEY, true) !== false,
  );
  const [subagentsSectionEnabled, setSubagentsSectionEnabled] = createSignal(
    api.kv.get<boolean>(SUBAGENTS_SECTION_ENABLED_KV_KEY, true) !== false,
  );
  const hydrateRetryTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  const runningReconcileBackoff = new Map<string, RunningReconcileCacheEntry>();
  let reconcileInFlight = false;
  let lastRunningReconcileAtMs = 0;
  let disposed = false;
  let previousRouteSessionID: string | undefined;
  let pendingSidebarRefocus: PendingSidebarRefocus | undefined;
  let pendingRefocusConsumed = false;
  let activePromptRef: TuiPromptRef | undefined;

  const consumePendingSidebarRefocus = ():
    | PendingSidebarRefocus
    | undefined => {
    if (pendingRefocusConsumed) return undefined;
    pendingRefocusConsumed = true;
    return pendingSidebarRefocus;
  };

  const setActivePromptRef = (ref: TuiPromptRef | undefined): void => {
    activePromptRef = ref;
  };

  const composePromptRef = (slotRef: PromptRefProp) => {
    return (ref: TuiPromptRef | undefined): void => {
      setActivePromptRef(ref);
      if (typeof slotRef === "function") {
        slotRef(ref);
      } else if (slotRef && "current" in slotRef) {
        slotRef.current = ref;
      }
    };
  };

  const focusActivePrompt = (): void => {
    focusPromptWithDeferredRetry(() => {
      if (!activePromptRef) return false;
      activePromptRef.focus();
      return true;
    });
  };

  const rememberSidebarChildNavigation = (
    input: PendingSidebarRefocus,
  ): void => {
    pendingSidebarRefocus = input;
  };

  const setSubagentsExpandedPreference = (expanded: boolean): void => {
    setSubagentsExpanded(expanded);
    api.kv.set(SUBAGENTS_EXPANDED_KV_KEY, expanded);
    api.ui.toast({
      variant: "info",
      message: expanded ? "Subagent list expanded" : "Subagent list collapsed",
    });
  };

  const setSubagentsExpandedSilently = (expanded: boolean): void => {
    setSubagentsExpanded(expanded);
    api.kv.set(SUBAGENTS_EXPANDED_KV_KEY, expanded);
  };

  const setSubagentsSectionEnabledPreference = (enabled: boolean): void => {
    setSubagentsSectionEnabled(enabled);
    api.kv.set(SUBAGENTS_SECTION_ENABLED_KV_KEY, enabled);
    api.ui.toast({
      variant: "info",
      message: enabled
        ? "Subagent section enabled"
        : "Subagent section disabled",
    });
  };

  const toggleSidebarListFocus = (): void => {
    api.ui.dialog.clear();
    if (view.isListFocused()) {
      view.blurList();
      focusActivePrompt();
      return;
    }

    setSubagentsSectionEnabled(true);
    setSubagentsExpanded(true);
    api.kv.set(SUBAGENTS_SECTION_ENABLED_KV_KEY, true);
    api.kv.set(SUBAGENTS_EXPANDED_KV_KEY, true);
    setTimeout(() => {
      view.focusList();
    }, 0);
  };

  const toggleSidebarCompletedHistory = (): void => {
    api.ui.dialog.clear();
    setSubagentsSectionEnabled(true);
    setSubagentsExpanded(true);
    api.kv.set(SUBAGENTS_SECTION_ENABLED_KV_KEY, true);
    api.kv.set(SUBAGENTS_EXPANDED_KV_KEY, true);
    setTimeout(() => {
      view.toggleCompletedHistory();
    }, 0);
  };

  const commandDispose = registerSubagentCommands({
    api,
    sectionEnabled: subagentsSectionEnabled,
    toggleSection: setSubagentsSectionEnabledPreference,
    focusSidebarList: toggleSidebarListFocus,
    toggleCompletedHistory: toggleSidebarCompletedHistory,
  });

  const clearHydrateRetryTimeout = (sessionID: string): void => {
    const timeout = hydrateRetryTimeouts.get(sessionID);
    if (timeout) {
      clearTimeout(timeout);
      hydrateRetryTimeouts.delete(sessionID);
    }
  };

  const resetHydrateRetry = (sessionID: string | undefined): void => {
    if (!sessionID) return;
    clearHydrateRetryTimeout(sessionID);
    setHydrateRetryPendingSessions((prev) => {
      if (!prev.has(sessionID)) return prev;
      const next = new Set(prev);
      next.delete(sessionID);
      return next;
    });
    setHydrateRetryAttempts((prev) => {
      if (!prev.has(sessionID)) return prev;
      const next = new Map(prev);
      next.delete(sessionID);
      return next;
    });
  };

  createEffect(() => {
    hydrateRetryTick();
    void api.route.current;
    const routeSessionID = resolveRouteSessionID(api);

    if (previousRouteSessionID && previousRouteSessionID !== routeSessionID) {
      resetHydrateRetry(previousRouteSessionID);
    }

    const siblingRefocus = resolveSiblingSidebarRefocus({
      pendingSidebarRefocus,
      routeSessionID,
      children: state().children,
    });
    if (siblingRefocus && pendingSidebarRefocus) {
      pendingSidebarRefocus = {
        ...pendingSidebarRefocus,
        ...siblingRefocus,
      };
    }

    const sidebarReturnAction = resolveSidebarReturnFocusAction({
      pendingSidebarRefocus,
      previousRouteSessionID,
      routeSessionID,
    });
    pendingRefocusConsumed = false;
    if (sidebarReturnAction === "focus-prompt") {
      view.blurList();
      focusActivePrompt();
    } else if (sidebarReturnAction === "clear-pending") {
      pendingSidebarRefocus = undefined;
    }

    previousRouteSessionID = routeSessionID;

    if (!routeSessionID) return;

    const sessionID = routeSessionID;
    if (
      hydratedSessions().has(sessionID) ||
      hydratingSessions().has(sessionID) ||
      hydrateRetryPendingSessions().has(sessionID)
    ) {
      return;
    }

    setHydratingSessions((prev) => {
      const next = new Set(prev);
      next.add(sessionID);
      return next;
    });

    void (async () => {
      const finishHydrating = (): void => {
        setHydratingSessions((prev) => {
          const next = new Set(prev);
          next.delete(sessionID);
          return next;
        });
      };

      const hydrated = await hydratePreviousSubagents(
        api,
        sessionID,
        statePath,
        textPath,
        (update) => {
          // Hydration keeps its helper signature; only this setup owns the view.
          view.snapshotScroll();
          setState(update);
        },
      );
      if (disposed) {
        clearHydrateRetryTimeout(sessionID);
        finishHydrating();
        return;
      }
      if (hydrated) {
        resetHydrateRetry(sessionID);
        setHydratedSessions((prev) => {
          const next = new Set(prev);
          next.add(sessionID);
          return next;
        });
        finishHydrating();
        return;
      }

      const attempts = hydrateRetryAttempts().get(sessionID) ?? 0;

      const delayMs = Math.min(
        HYDRATE_RETRY_MAX_DELAY_MS,
        HYDRATE_RETRY_BASE_DELAY_MS * 2 ** attempts,
      );

      setHydrateRetryAttempts((prev) => {
        const next = new Map(prev);
        next.set(sessionID, Math.min(attempts + 1, HYDRATE_RETRY_MAX_ATTEMPTS));
        return next;
      });

      setHydrateRetryPendingSessions((prev) => {
        const next = new Set(prev);
        next.add(sessionID);
        return next;
      });
      finishHydrating();

      clearHydrateRetryTimeout(sessionID);
      const timeout = setTimeout(() => {
        hydrateRetryTimeouts.delete(sessionID);
        setHydrateRetryPendingSessions((prev) => {
          if (!prev.has(sessionID)) return prev;
          const next = new Set(prev);
          next.delete(sessionID);
          return next;
        });
        if (disposed) return;
        setHydrateRetryTick((value) => value + 1);
      }, delayMs);
      hydrateRetryTimeouts.set(sessionID, timeout);
    })();
  });

  const reconcileRunningChildren = async (): Promise<void> => {
    if (reconcileInFlight || disposed) return;
    reconcileInFlight = true;
    lastRunningReconcileAtMs = Date.now();

    try {
      const snapshot = cloneState(state());
      const nowMs = Date.now();
      const currentSessionID = resolveRouteSessionID(api);
      const directory = api.state.path.directory;

      const selected = selectRunningReconcileCandidates({
        state: snapshot,
        currentSessionID,
        nowMs,
        maxCandidates: RUNNING_RECONCILE_MAX_CANDIDATES,
      });

      const mutations: Array<{
        childID: string;
        targetSessionID: string;
        status: "done" | "error";
        endedAt?: string;
        reconcileWithoutTargetSessionID?: boolean;
      }> = [];

      const parentMessagesCache = new Map<string, unknown[] | null>();

      for (const candidate of selected) {
        const key = candidate.targetSessionID ?? candidate.childID;
        const cache = runningReconcileBackoff.get(key);
        if (shouldSkipCandidateForBackoff(cache, nowMs)) continue;

        if (!candidate.targetSessionID) {
          const isPersistedSubtaskCandidate =
            candidate.source === "subtask" &&
            typeof candidate.parentID === "string" &&
            candidate.parentID.length > 0 &&
            typeof candidate.messageID === "string" &&
            candidate.messageID.length > 0;
          if (!isPersistedSubtaskCandidate) continue;

          const parentSessionID = candidate.parentID as string;
          let parentMessages = parentMessagesCache.get(parentSessionID);
          if (parentMessages === undefined) {
            const parentMessagesResp = await safeReadAsync(() =>
              api.client.session.messages({
                sessionID: parentSessionID,
                directory,
              }),
            );
            parentMessages = Array.isArray(parentMessagesResp?.data)
              ? parentMessagesResp.data
              : null;
            parentMessagesCache.set(parentSessionID, parentMessages);
          }
          if (parentMessages === null) {
            runningReconcileBackoff.set(
              key,
              nextBackoffState({
                cache,
                nowMs,
                initialBackoffMs: RUNNING_RECONCILE_INITIAL_BACKOFF_MS,
                maxBackoffMs: RUNNING_RECONCILE_MAX_BACKOFF_MS,
              }),
            );
            continue;
          }

          const evidence = resolvePersistedStaleSubtaskFromParentMessages({
            candidate: {
              childID: candidate.childID,
              parentID: candidate.parentID as string,
              messageID: candidate.messageID as string,
              title: candidate.title,
              summary: candidate.summary,
              agentName: candidate.agentName,
            } satisfies PersistedStaleSubtaskCandidate,
            messages: parentMessages,
          });
          if (!evidence) {
            const parentSummary = summarizeSessionMessages(parentMessages);
            const canSafelyFallbackByParentInactivity =
              canSafelyCloseNoTargetPersistedCandidate({
                nowMs,
                staleThresholdMs: STALE_RUNNING_THRESHOLD_MS,
                startedMs: candidate.startedMs,
                updatedMs: candidate.updatedMs,
                latestMessageActivityAtMs:
                  parentSummary.latestMessageActivityAtMs,
              });
            if (canSafelyFallbackByParentInactivity) {
              mutations.push({
                childID: candidate.childID,
                targetSessionID: candidate.childID,
                status: "done",
                endedAt:
                  parentSummary.latestMessageActivityAt ??
                  new Date(nowMs - candidate.updatedMs).toISOString(),
                reconcileWithoutTargetSessionID: true,
              });
              runningReconcileBackoff.delete(key);
              continue;
            }
            runningReconcileBackoff.set(
              key,
              nextBackoffState({
                cache,
                nowMs,
                initialBackoffMs: RUNNING_RECONCILE_INITIAL_BACKOFF_MS,
                maxBackoffMs: RUNNING_RECONCILE_MAX_BACKOFF_MS,
              }),
            );
            continue;
          }

          mutations.push({
            childID: candidate.childID,
            targetSessionID: evidence.targetSessionID ?? candidate.childID,
            status: evidence.status,
            endedAt: evidence.endedAt,
            reconcileWithoutTargetSessionID: true,
          });
          runningReconcileBackoff.delete(key);
          continue;
        }

        const evidence = await probeRunningEvidence({
          api,
          targetSessionID: candidate.targetSessionID,
          directory,
          candidateAgeMs: Math.max(candidate.startedMs, candidate.updatedMs),
          nowMs,
        });

        if (evidence.status === "done" || evidence.status === "error") {
          mutations.push({
            childID: candidate.childID,
            targetSessionID: candidate.targetSessionID,
            status: evidence.status,
            endedAt: evidence.endedAt,
          });
          runningReconcileBackoff.delete(key);
          continue;
        }

        if (evidence.sawRunningEvidence) {
          runningReconcileBackoff.set(key, {
            backoffMs: RUNNING_RECONCILE_INITIAL_BACKOFF_MS,
            nextAllowedAtMs: nowMs + RUNNING_RECONCILE_INITIAL_BACKOFF_MS,
          });
          continue;
        }

        const shouldApplyFallback = shouldApplyStaleRunningFallback({
          staleThresholdMs: STALE_RUNNING_THRESHOLD_MS,
          evidence,
          startedMs: candidate.startedMs,
          updatedMs: candidate.updatedMs,
        });

        if (shouldApplyFallback) {
          mutations.push({
            childID: candidate.childID,
            targetSessionID: candidate.targetSessionID,
            status: "done",
            endedAt: new Date(nowMs - candidate.updatedMs).toISOString(),
          });
          runningReconcileBackoff.delete(key);
          continue;
        }

        runningReconcileBackoff.set(
          key,
          nextBackoffState({
            cache,
            nowMs,
            initialBackoffMs: RUNNING_RECONCILE_INITIAL_BACKOFF_MS,
            maxBackoffMs: RUNNING_RECONCILE_MAX_BACKOFF_MS,
          }),
        );
      }

      if (mutations.length === 0) return;

      view.snapshotScroll();
      setState((current: StatuslineState) => {
        const next = cloneState(current);
        let changed = false;

        for (const mutation of mutations) {
          if (
            mutation.reconcileWithoutTargetSessionID &&
            mutation.targetSessionID.startsWith("ses_")
          ) {
            changed =
              upsertChildDetails(next, mutation.childID, {
                targetSessionID: mutation.targetSessionID,
                updatedAt: mutation.endedAt,
              }) || changed;
          }
          if (
            markChildStatus(
              next,
              mutation.reconcileWithoutTargetSessionID
                ? mutation.childID
                : mutation.targetSessionID,
              mutation.status,
              mutation.endedAt,
            )
          ) {
            changed = true;
          }
        }

        const refreshed = refreshLiveState(next);
        if (!changed && !refreshed) return current;
        persistStateSnapshot(statePath, textPath, next);
        return next;
      });
    } finally {
      reconcileInFlight = false;
    }
  };

  const timers = createTuiMaintenanceTimers({
    onElapsedTick: () => {
      view.snapshotScroll();
      setNowMs(Date.now());
    },
    onMaintenanceTick: () => {
      const currentNowMs = Date.now();
      if (
        currentNowMs - lastRunningReconcileAtMs >=
        RUNNING_RECONCILE_MAINTENANCE_INTERVAL_MS
      ) {
        void reconcileRunningChildren();
      }

      setState((current: StatuslineState) => {
        const next = runTuiStateMaintenance(api, current);
        if (next === current) return current;
        view.snapshotScroll();
        persistStateSnapshot(statePath, textPath, next);
        return next;
      });
    },
  });

  createEffect(() => {
    timers.syncElapsedTimer(
      Object.values(state().children).some((child) => child.status === "running"),
    );
  });

  const applyEvent = (event: unknown): void => {
    debugEvent(event);
    view.snapshotScroll();
    setState((current: StatuslineState) => {
      const next = cloneState(current);
      const changed = applySubagentEvent(next, event);
      const hydrated = hydrateStateTokensFromTuiState(api, next);
      if (changed) {
        debugLog({
          kind: "state.changed",
          children: Object.values(next.children).map((child) => ({
            id: child.id,
            parentID: child.parentID,
            title: child.title,
            status: child.status,
            source: child.source,
          })),
        });
      }
      const refreshed = refreshLiveState(next);
      if (!changed && !hydrated && !refreshed) return current;
      persistStateSnapshot(statePath, textPath, next);
      return next;
    });
  };

  const disposers = [
    api.event.on("session.created", applyEvent),
    api.event.on("session.updated", applyEvent),
    api.event.on("session.status", applyEvent),
    api.event.on("session.idle", applyEvent),
    api.event.on("session.error", applyEvent),
    api.event.on("message.updated", applyEvent),
    api.event.on("message.part.updated", applyEvent),
  ];

  api.lifecycle.onDispose(() => {
    disposed = true;
    timers.dispose();
    for (const timeout of hydrateRetryTimeouts.values()) {
      clearTimeout(timeout);
    }
    hydrateRetryTimeouts.clear();
    commandDispose();
    for (const dispose of disposers) {
      dispose();
    }
    disposeRoot();
  });

  api.slots.register({
    order: 90,
    slots: {
      sidebar_content(ctx: SidebarContentContext) {
        const routeSessionID = resolveRouteSessionID(api);
        const sessionID = ctx.session_id ?? routeSessionID ?? "";
        debugLog({
          kind: "slot.sidebar_content",
          ctxSessionID: ctx.session_id,
          resolvedSessionID: sessionID,
          route: api.route.current,
          childCount: Object.keys(state().children).length,
        });
        const restoreFromChild = (() => {
          const pending = consumePendingSidebarRefocus();
          if (pending?.parentSessionID !== sessionID) return undefined;
          return {
            childRowID: pending.childRowID,
            showCompletedHistory: pending.showCompletedHistory ?? false,
          };
        })();
        return (
          <Show when={subagentsSectionEnabled()}>
            <SidebarSubagents
              controller={view}
              navigate={(id) => navigateToSessionTarget(api, id)}
              modelLine={(child, width) => formatChildModelLine(child, api.state.provider, width)}
              registerListKeys={({ onKeyDown }) => useKeyboard(onKeyDown)}
              sessionID={sessionID}
              state={state}
              nowMs={nowMs}
              expanded={subagentsExpanded}
              onToggleExpanded={() =>
                setSubagentsExpandedPreference(!subagentsExpanded())
              }
              onSetExpanded={setSubagentsExpandedSilently}
              onReturnFocus={focusActivePrompt}
              onToggleListFocus={toggleSidebarListFocus}
              onNavigateToChild={rememberSidebarChildNavigation}
              sidebarWidth={() => resolveSidebarWidth(ctx)}
              theme={ctx.theme.current}
              restoreFromChild={restoreFromChild}
            />
          </Show>
        );
      },
      home_bottom(ctx: HomeBottomContext) {
        return <HomeBottomStatus state={state} theme={ctx.theme.current} />;
      },
      home_prompt(_ctx: TuiSlotContext, props: HomePromptProps) {
        const promptProps = {
          ...props,
          ...(props.workspaceID === undefined &&
          props.workspace_id !== undefined
            ? { workspaceID: props.workspace_id }
            : {}),
          ref: composePromptRef(props.ref),
        };
        return <api.ui.Prompt {...promptProps} />;
      },
      session_prompt(_ctx: TuiSlotContext, props: SessionPromptProps) {
        const sessionID = props.sessionID ?? props.session_id;
        const promptProps = {
          ...props,
          ...(props.sessionID === undefined && props.session_id !== undefined
            ? { sessionID: props.session_id }
            : {}),
          ...(props.onSubmit === undefined && props.on_submit !== undefined
            ? { onSubmit: props.on_submit }
            : {}),
          right:
            props.right ??
            (sessionID ? (
              <api.ui.Slot name="session_prompt_right" session_id={sessionID} />
            ) : undefined),
          ref: composePromptRef(props.ref),
        };
        return <api.ui.Prompt {...promptProps} />;
      },
    },
  });
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  createRoot((disposeRoot) => initializeTui(api, disposeRoot));
};

const plugin: TuiPluginModule = {
  id: TUI_PLUGIN_ID,
  tui,
};

export default plugin;
