import type { BoxRenderable, KeyEvent, MouseEvent, RGBA, ScrollBoxRenderable } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { createRequire } from "node:module";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import { byPriority, formatDuration, visibleSubagentWorkItems } from "./render.js";
import {
  countCountedSubagentExecutions,
  countHistoricalSubagentExecutions,
  countRetainedSubagentStatuses,
  type ChildSessionState,
  type StatusCounts,
  type StatuslineState,
} from "./state.js";
import { takeColumns, textColumns, truncateToColumns } from "./text-width.js";
import { shouldReleaseSidebarListFocus } from "./tui-focus.js";
import { t } from "./i18n.js";

export type MonitorTheme = Record<
  "text" | "textMuted" | "accent" | "warning" | "success" | "error" |
  "backgroundElement" | "backgroundPanel", RGBA
>;

export interface SidebarChildNavigation {
  parentSessionID: string;
  childSessionID: string;
  childRowID: string;
  showCompletedHistory: boolean;
}

export interface SidebarViewController {
  snapshotScroll(): void;
  focusList(preferredChildID?: string): boolean;
  blurList(): boolean;
  isListFocused(): boolean;
  toggleCompletedHistory(): boolean;
  target(): BoxRenderable | undefined;
  dispose(): void;
}

export interface SidebarViewProps {
  controller: SidebarViewController;
  sessionID: string;
  state: () => StatuslineState;
  nowMs: () => number;
  expanded: () => boolean;
  onToggleExpanded: () => void;
  onSetExpanded: (expanded: boolean) => void;
  onReturnFocus: () => void;
  onToggleListFocus: () => void;
  onNavigateToChild: (input: SidebarChildNavigation) => void;
  navigate: (sessionID: string | undefined) => void;
  modelLine: (child: ChildSessionState, width: number) => string | undefined;
  registerListKeys: (input: {
    target: () => BoxRenderable | undefined;
    onKeyDown: (event: KeyEvent) => void;
  }) => void;
  sidebarWidth?: () => number | undefined;
  theme: MonitorTheme;
  restoreFromChild?: { childRowID: string; showCompletedHistory: boolean };
  // Presentation-only additions are wired by the V2 integration task.
  notice?: () => string | undefined;
  childHint?: (childID: string) => string | undefined;
  usageLabel?: string;
  // V2's targeted layer only owns exact unmodified list keys (plus Alt+B).
  // Omitted on V1 so its legacy input behavior stays unchanged.
  strictInput?: boolean;
}

const FALLBACK_SIDEBAR_WIDTH = 34;
const MIN_ROW_WIDTH = 24;
const MIN_LABEL_WIDTH = 8;

const CLOCK_ICON = "";
const TOKEN_ICON = "";
const SIDEBAR_ARROW_EXPANDED = "▼";
const SIDEBAR_ARROW_COLLAPSED = "▶";

const SUBAGENTS_MAX_VISIBLE_ROWS = 5;
const SUBAGENTS_RUNNING_ROW_HEIGHT = 3;
const SUBAGENTS_TERMINAL_ROW_HEIGHT = 2;
const SUBAGENTS_MODEL_ROW_HEIGHT = 1;
const SUBAGENTS_ROW_GAP = 0;
const SUBAGENTS_ROW_MARKER_WIDTH = 4;
const SUBAGENTS_MAX_LIST_HEIGHT =
  SUBAGENTS_MAX_VISIBLE_ROWS *
    (SUBAGENTS_RUNNING_ROW_HEIGHT + SUBAGENTS_MODEL_ROW_HEIGHT) +
  (SUBAGENTS_MAX_VISIBLE_ROWS - 1) * SUBAGENTS_ROW_GAP;
const INACTIVE_SUBAGENT_OPACITY = 0.65;
const SIDEBAR_VERSION_OPACITY = 0.7;
const SIDEBAR_FOCUS_INDICATOR = "●";

const packageRequire = createRequire(import.meta.url);

function readPluginVersion(): string | undefined {
  try {
    const metadata = packageRequire("../package.json") as { version?: unknown };
    return typeof metadata.version === "string" && metadata.version.length > 0
      ? metadata.version
      : undefined;
  } catch {
    return undefined;
  }
}

const PLUGIN_VERSION = readPluginVersion();

interface SidebarScrollRegistration {
  getScrollbox: () => ScrollBoxRenderable | undefined;
  getAnchor: () => SidebarScrollAnchor | undefined;
  getRows: () => SidebarScrollRowLayout[];
  getLeadingHeight: () => number;
  offsetTop: number;
  anchor?: SidebarScrollAnchor;
  restoreFramesRemaining: number;
}

export interface SidebarScrollAnchor {
  childIDs: string[];
  intraRowOffset: number;
}

export interface SidebarScrollRowLayout {
  id: string;
  height: number;
}

interface SidebarListFocusRegistration {
  target: () => BoxRenderable | undefined;
  focusList: (preferredChildID?: string) => boolean;
  blurList: () => boolean;
  isListFocusModeActive: () => boolean;
}

interface SidebarCompletedHistoryRegistration {
  toggleCompletedHistory: () => boolean;
}

const SIDEBAR_SCROLL_RESTORE_FRAME_BUDGET = 2;

const registerSidebar = Symbol("registerSidebar");
interface RegisteredSidebarViewController extends SidebarViewController {
  [registerSidebar](input: {
    scroll: SidebarScrollRegistration;
    focus: SidebarListFocusRegistration;
    history: SidebarCompletedHistoryRegistration;
  }): () => void;
}

export function createSidebarViewController(): SidebarViewController {
  const sidebarScrollRegistrations = new Set<SidebarScrollRegistration>();
  const sidebarListFocusRegistrations = new Set<SidebarListFocusRegistration>();
  const sidebarCompletedHistoryRegistrations = new Set<SidebarCompletedHistoryRegistration>();
  let disposed = false;
  const controller: RegisteredSidebarViewController = {
    [registerSidebar]({ scroll, focus, history }) {
      if (disposed) return () => {};
      sidebarScrollRegistrations.add(scroll);
      sidebarListFocusRegistrations.add(focus);
      sidebarCompletedHistoryRegistrations.add(history);
      return () => {
        sidebarScrollRegistrations.delete(scroll);
        sidebarListFocusRegistrations.delete(focus);
        sidebarCompletedHistoryRegistrations.delete(history);
      };
    },
    snapshotScroll() {
      for (const registration of sidebarScrollRegistrations) {
        const scrollbox = registration.getScrollbox();
        if (!scrollbox) continue;
        registration.offsetTop = clampedScrollTop(scrollbox, scrollbox.scrollTop);
        registration.anchor = registration.getAnchor();
        registration.restoreFramesRemaining = SIDEBAR_SCROLL_RESTORE_FRAME_BUDGET;
      }
    },
    focusList(preferredChildID) {
      for (const registration of [...sidebarListFocusRegistrations].reverse()) {
        if (registration.focusList(preferredChildID)) return true;
      }
      return false;
    },
    blurList() {
      for (const registration of [...sidebarListFocusRegistrations].reverse()) {
        if (registration.blurList()) return true;
      }
      return false;
    },
    isListFocused() {
      return [...sidebarListFocusRegistrations].some((registration) =>
        registration.isListFocusModeActive(),
      );
    },
    toggleCompletedHistory() {
      for (const registration of [...sidebarCompletedHistoryRegistrations].reverse()) {
        if (registration.toggleCompletedHistory()) return true;
      }
      return false;
    },
    target() {
      for (const registration of [...sidebarListFocusRegistrations].reverse()) {
        const target = registration.target();
        if (target) return target;
      }
      return undefined;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const registration of sidebarListFocusRegistrations) registration.blurList();
      sidebarScrollRegistrations.clear();
      sidebarListFocusRegistrations.clear();
      sidebarCompletedHistoryRegistrations.clear();
    },
  };
  return controller;
}

function maxScrollTop(scrollbox: ScrollBoxRenderable): number {
  return Math.max(0, scrollbox.scrollHeight - scrollbox.viewport.height);
}

function clampedScrollTop(
  scrollbox: ScrollBoxRenderable,
  value: number,
): number {
  return Math.max(0, Math.min(value, maxScrollTop(scrollbox)));
}

function resolveSidebarAnchorScrollTop(input: {
  expanded: boolean;
  anchor?: SidebarScrollAnchor;
  rows: SidebarScrollRowLayout[];
  leadingHeight: number;
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
}): { matched: boolean; offsetTop?: number; scrollTop?: number } {
  if (!input.expanded || !input.anchor || input.anchor.childIDs.length === 0) {
    return { matched: false };
  }

  let top = input.leadingHeight;
  const rowTops = new Map<string, number>();
  for (const row of input.rows) {
    rowTops.set(row.id, top);
    top += row.height + SUBAGENTS_ROW_GAP;
  }

  for (const [index, childID] of input.anchor.childIDs.entries()) {
    const rowTop = rowTops.get(childID);
    if (rowTop === undefined) continue;

    const desiredTop = rowTop + (index === 0 ? input.anchor.intraRowOffset : 0);
    const maxTop = Math.max(0, input.scrollHeight - input.viewportHeight);
    const nextTop = Math.max(0, Math.min(desiredTop, maxTop));
    return {
      matched: true,
      offsetTop: nextTop,
      scrollTop: input.scrollTop !== nextTop ? nextTop : undefined,
    };
  }

  return { matched: false };
}

export function preservedSidebarAnchorScrollTop(input: {
  expanded: boolean;
  anchor?: SidebarScrollAnchor;
  rows: SidebarScrollRowLayout[];
  leadingHeight?: number;
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
}): number | undefined {
  return resolveSidebarAnchorScrollTop({
    ...input,
    leadingHeight: input.leadingHeight ?? 0,
  }).scrollTop;
}

export function preservedSidebarScrollTop(input: {
  expanded: boolean;
  offsetTop: number;
  anchor?: SidebarScrollAnchor;
  rows?: SidebarScrollRowLayout[];
  leadingHeight?: number;
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
}): number | undefined {
  if (!input.expanded) return undefined;

  const anchorTop = resolveSidebarAnchorScrollTop({
    expanded: input.expanded,
    anchor: input.anchor,
    rows: input.rows ?? [],
    leadingHeight: input.leadingHeight ?? 0,
    scrollTop: input.scrollTop,
    scrollHeight: input.scrollHeight,
    viewportHeight: input.viewportHeight,
  });
  if (anchorTop.matched) return anchorTop.scrollTop;

  const maxTop = Math.max(0, input.scrollHeight - input.viewportHeight);
  const top = Math.max(0, Math.min(input.offsetTop, maxTop));
  return top > 0 && input.scrollTop !== top ? top : undefined;
}

function elapsedMs(child: ChildSessionState, nowMs: number): number {
  if (child.status !== "running") {
    return child.elapsedMs ?? 0;
  }
  const started = Date.parse(child.startedAt);
  if (Number.isNaN(started)) return child.elapsedMs ?? 0;
  return Math.max(0, nowMs - started);
}

function taskStatusMarker(status: ChildSessionState["status"]): string {
  if (status === "done") return "[✓]";
  if (status === "error") return "[x]";
  return "[ ]";
}

function statusColor(
  status: ChildSessionState["status"],
  theme: MonitorTheme,
): MonitorTheme["warning"] {
  if (status === "done") return theme.success;
  if (status === "error") return theme.error;
  return theme.warning;
}

export function isSessionTarget(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("ses_");
}

export function resolveChildTargetSessionID(
  child: ChildSessionState,
): string | undefined {
  if (isSessionTarget(child.targetSessionID)) {
    return child.targetSessionID;
  }
  if (child.id.startsWith("ses_")) {
    return child.id;
  }
  return undefined;
}

export function resolveSyntheticTargetFromHydratedState(
  state: StatuslineState,
  synthetic: ChildSessionState,
): string | undefined {
  const messageMatches = Object.values(state.children).filter(
    (candidate) =>
      candidate.id.startsWith("ses_") &&
      candidate.parentID === synthetic.parentID &&
      synthetic.messageID &&
      candidate.messageID === synthetic.messageID,
  );
  if (messageMatches.length === 1) return messageMatches[0].id;

  const parentMatches = Object.values(state.children).filter(
    (candidate) =>
      candidate.id.startsWith("ses_") &&
      candidate.parentID === synthetic.parentID,
  );
  if (parentMatches.length === 1) return parentMatches[0].id;

  return undefined;
}


function ellipsize(value: string, maxColumns: number): string {
  return truncateToColumns(value, maxColumns);
}

function splitParentheticalTitle(title: string): {
  label: string;
  parenthetical?: string;
} {
  const match = title.match(/^(.*?)\s*(\([^)]*\))\s*$/);
  if (!match) return { label: title };

  const label = match[1]?.trim();
  const parenthetical = match[2]?.trim();
  if (!label || !parenthetical) return { label: title };

  return { label, parenthetical };
}

function childParenthetical(child: ChildSessionState): string | undefined {
  if (child.agentName?.trim()) return `(${child.agentName.trim()})`;

  const primary = splitParentheticalTitle(childPrimaryText(child));
  if (primary.parenthetical) return primary.parenthetical;

  return splitParentheticalTitle(child.title).parenthetical;
}

function formatSecondaryLine(
  continuation: string | undefined,
  parenthetical: string | undefined,
  width: number,
): string | undefined {
  if (!continuation) return parenthetical;
  if (!parenthetical) return continuation;

  const parentheticalWidth = Math.min(textColumns(parenthetical), width);
  const continuationWidth = width - parentheticalWidth - 1;
  if (continuationWidth >= MIN_LABEL_WIDTH) {
    return `${ellipsize(continuation, continuationWidth)} ${ellipsize(parenthetical, parentheticalWidth)}`;
  }

  return ellipsize(parenthetical, width);
}

function childPrimaryText(child: ChildSessionState): string {
  return child.summary?.trim() || child.title;
}

function resolveTokenTotal(child: ChildSessionState): number | undefined {
  const total = child.tokens?.total;
  if (typeof total === "number" && Number.isFinite(total)) {
    return total;
  }
  const input = child.tokens?.input;
  const output = child.tokens?.output;
  if (typeof input === "number" || typeof output === "number") {
    return Math.max(0, (input ?? 0) + (output ?? 0));
  }
  return undefined;
}

function formatCompactTokenCount(total: number): string {
  const value = Math.max(0, total);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M ctx`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k ctx`;
  return `${Math.round(value)} ctx`;
}

function formatCompactPercent(percent: number): string {
  return `${Math.max(0, Math.round(percent))}%`;
}

function contextVariants(child: ChildSessionState, usageLabel?: string): string[] {
  const total = resolveTokenTotal(child);
  const percent = usageLabel ? undefined : child.tokens?.contextPercent;
  const hasTotal = typeof total === "number" && Number.isFinite(total);
  const hasPercent = typeof percent === "number" && Number.isFinite(percent);

  if (!hasTotal && !hasPercent) return [""];

  const formattedTokens = hasTotal ? formatCompactTokenCount(total) : "";
  const tokenPart = usageLabel ? formattedTokens.replace(/ ctx$/, "") : formattedTokens;
  const percentPart = hasPercent ? formatCompactPercent(percent) : "";

  if (tokenPart && percentPart) {
    return [`${tokenPart} ${percentPart}`, percentPart, tokenPart, ""];
  }

  return [tokenPart || percentPart, ""];
}

function rowWidthBudget(sidebarWidth: number | undefined): number {
  const width = sidebarWidth ?? FALLBACK_SIDEBAR_WIDTH;
  const innerWidth = width - 4;
  return Math.max(MIN_ROW_WIDTH, Math.min(innerWidth, 52));
}

export function wrapCompactText(
  value: string,
  width: number,
  maxLines: number,
): string[] {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return [""];

  const lines: string[] = [];
  let remaining = normalized;

  while (textColumns(remaining) > width && lines.length < maxLines - 1) {
    const probe = takeColumns(remaining, width + 1);
    const breakAt = probe.lastIndexOf(" ");
    const breakPrefix = breakAt >= 0 ? probe.slice(0, breakAt) : "";
    const fit = takeColumns(remaining, width);
    const take =
      breakAt >= 0 &&
      textColumns(breakPrefix) >= MIN_LABEL_WIDTH &&
      textColumns(breakPrefix) <= width
        ? breakAt
        : fit.length;
    if (take <= 0) break;

    lines.push(remaining.slice(0, take).trimEnd());
    remaining = remaining.slice(take).trimStart();
  }

  lines.push(
    lines.length === maxLines - 1
      ? ellipsize(remaining, Math.max(1, width))
      : remaining,
  );
  return lines;
}

function formatChildRowLine(input: {
  child: ChildSessionState;
  nowMs: number;
  sidebarWidth?: number;
  reservedWidth?: number;
  usageLabel?: string;
}): {
  labelLines: string[];
  secondaryLine?: string;
  elapsed: string;
  meta: string;
} {
  const elapsed = formatDuration(elapsedMs(input.child, input.nowMs));
  const width = Math.max(
    MIN_ROW_WIDTH,
    rowWidthBudget(input.sidebarWidth) - (input.reservedWidth ?? 0),
  );
  const title = splitParentheticalTitle(childPrimaryText(input.child));
  const parenthetical = childParenthetical(input.child);

  for (const meta of contextVariants(input.child, input.usageLabel)) {
    const detailChars =
      2 + textColumns(elapsed) + (meta ? 3 + textColumns(meta) : 0);
    const labelBudget = Math.min(
      width - 2,
      width - Math.max(0, detailChars - width),
    );
    if (labelBudget >= MIN_LABEL_WIDTH || textColumns(meta) === 0) {
      const labelLines = wrapCompactText(
        title.label,
        Math.max(1, labelBudget),
        2,
      );
      return {
        labelLines,
        secondaryLine: formatSecondaryLine(
          labelLines[1],
          parenthetical,
          Math.max(1, labelBudget),
        ),
        elapsed,
        meta,
      };
    }
  }

  const labelLines = wrapCompactText(title.label, MIN_LABEL_WIDTH, 2);
  return {
    labelLines,
    secondaryLine: formatSecondaryLine(
      labelLines[1],
      parenthetical,
      MIN_LABEL_WIDTH,
    ),
    elapsed,
    meta: "",
  };
}

function formatTerminalChildRowLine(input: {
  child: ChildSessionState;
  nowMs: number;
  sidebarWidth?: number;
  reservedWidth?: number;
  usageLabel?: string;
}): {
  label: string;
  meta: string;
} {
  const elapsed = formatDuration(elapsedMs(input.child, input.nowMs));
  const width = Math.max(MIN_ROW_WIDTH, rowWidthBudget(input.sidebarWidth));
  const title = splitParentheticalTitle(childPrimaryText(input.child));
  const parenthetical = childParenthetical(input.child);
  const labelSource = parenthetical
    ? `${title.label} ${parenthetical}`
    : title.label;
  const context = contextVariants(input.child, input.usageLabel).find(
    (variant) => variant.length > 0,
  );

  return {
    label: ellipsize(
      labelSource,
      Math.max(1, width - (input.reservedWidth ?? 0)),
    ),
    meta: context ? `${elapsed} ${context}` : elapsed,
  };
}

export function subagentRowHeight(input: {
  child: ChildSessionState;
  nowMs: number;
  sidebarWidth?: number;
  reservedWidth?: number;
  usageLabel?: string;
  childHint?: string;
}): number {
  const hintHeight = input.childHint ? 1 : 0;
  const modelHeight = input.child.model?.variant
    ? SUBAGENTS_MODEL_ROW_HEIGHT
    : 0;
  if (input.child.status !== "running") {
    return SUBAGENTS_TERMINAL_ROW_HEIGHT + modelHeight + hintHeight;
  }

  const line = formatChildRowLine(input);
  return (
    (line.secondaryLine
      ? SUBAGENTS_RUNNING_ROW_HEIGHT
      : SUBAGENTS_RUNNING_ROW_HEIGHT - 1) + modelHeight + hintHeight
  );
}


export interface TuiSubagentSnapshot {
  visibleChildren: ChildSessionState[];
  visibleCounts: StatusCounts;
  totalExecuted: number;
  showingOtherSessions: boolean;
}

export function resolveTuiSubagentSnapshot(input: {
  state: StatuslineState;
  sessionID?: string;
  nowMs?: number;
  showCompletedHistory?: boolean;
}): TuiSubagentSnapshot {
  const allChildren = Object.values(input.state.children);
  const options = { showCompletedHistory: input.showCompletedHistory };
  const nowMs = input.nowMs ?? Date.now();
  const ownChildren = input.sessionID
    ? allChildren.filter((child) => child.parentID === input.sessionID)
    : allChildren;
  const ownVisibleChildren = visibleSubagentWorkItems(
    ownChildren,
    nowMs,
    options,
  ).sort(byPriority);
  const totalExecuted = input.sessionID
    ? countCountedSubagentExecutions({
        children: allChildren,
        countedChildIDs: input.state.countedChildIDs,
        parentSessionID: input.sessionID,
      })
    : countHistoricalSubagentExecutions({ children: allChildren });

  return {
    visibleChildren: ownVisibleChildren,
    visibleCounts: countRetainedSubagentStatuses({
      children: allChildren,
      parentSessionID: input.sessionID,
    }),
    totalExecuted,
    showingOtherSessions: false,
  };
}

export function resolveSidebarSubagentSnapshot(input: {
  state: StatuslineState;
  sessionID: string;
  nowMs?: number;
  showCompletedHistory?: boolean;
}): TuiSubagentSnapshot {
  return resolveTuiSubagentSnapshot(input);
}

export function SidebarSubagents(props: SidebarViewProps): JSX.Element {
  const [showCompletedHistory, setShowCompletedHistory] = createSignal(
    props.restoreFromChild?.showCompletedHistory ?? false,
  );
  const completedHistoryOptions = () => ({
    showCompletedHistory: showCompletedHistory(),
  });
  const snapshot = createMemo(() =>
    resolveSidebarSubagentSnapshot({
      state: props.state(),
      sessionID: props.sessionID,
      nowMs: props.nowMs(),
      ...completedHistoryOptions(),
    }),
  );
  const visibleChildren = createMemo(() => snapshot().visibleChildren);
  const counts = createMemo(() => snapshot().visibleCounts);
  const totalExecuted = createMemo(() => snapshot().totalExecuted);

  const visibleChildIDs = createMemo(() =>
    visibleChildren().map((child) => child.id),
  );
  const [selectedChildID, setSelectedChildID] = createSignal<
    string | undefined
  >(props.restoreFromChild?.childRowID);
  let restoreChildRowID = props.restoreFromChild?.childRowID;
  const [mouseDownChildID, setMouseDownChildID] = createSignal<
    string | undefined
  >();
  const [listFocused, setListFocused] = createSignal(false);
  const [listFocusModeActive, setListFocusModeActive] = createSignal(false);

  const visibleChildLayoutSignature = createMemo(() =>
    visibleChildren()
      .map((child) =>
        JSON.stringify([
          child.id,
          child.status,
          child.title,
          child.summary ?? "",
          child.agentName ?? "",
          child.tokens?.input ?? "",
          child.tokens?.output ?? "",
          child.tokens?.total ?? "",
          child.tokens?.contextPercent ?? "",
          child.model?.providerID ?? "",
          child.model?.modelID ?? "",
          child.model?.variant ?? "",
          props.childHint?.(child.id) ?? "",
        ]),
      )
      .join("|"),
  );

  const listHeight = createMemo(() => {
    const nowMs = props.nowMs();
    const sidebarWidth = props.sidebarWidth?.();
    const contentHeight =
      visibleChildren().reduce(
        (height, child) =>
          height +
          subagentRowHeight({
            child,
            nowMs,
            sidebarWidth,
            reservedWidth: SUBAGENTS_ROW_MARKER_WIDTH,
            usageLabel: props.usageLabel,
            childHint: props.childHint?.(child.id),
          }),
        0,
      ) +
      Math.max(0, visibleChildren().length - 1) * SUBAGENTS_ROW_GAP;

    return Math.max(1, Math.min(SUBAGENTS_MAX_LIST_HEIGHT, contentHeight));
  });

  let listContainer: BoxRenderable | undefined;
  let scrollbox: ScrollBoxRenderable | undefined;
  const scrollRegistration: SidebarScrollRegistration = {
    getScrollbox: () => scrollbox,
    getAnchor: () => currentSidebarScrollAnchor(),
    getRows: () => rowLayouts(),
    getLeadingHeight: () => 0,
    offsetTop: 0,
    restoreFramesRemaining: 0,
  };
  const focusRegistration: SidebarListFocusRegistration = {
    target: () => props.strictInput && visibleChildIDs().length === 0 ? undefined : listContainer,
    focusList: (preferredChildID?: string) => {
      if (!listContainer || (props.strictInput &&
        (listContainer.isDestroyed || !listContainer.visible || visibleChildIDs().length === 0))) return false;
      const ids = visibleChildIDs();
      if (preferredChildID && ids.includes(preferredChildID)) {
        setSelectedChildID(preferredChildID);
      } else if (!selectedChildID() && ids[0]) {
        setSelectedChildID(ids[0]);
      }
      listContainer.focus();
      setListFocused(true);
      setListFocusModeActive(true);
      return true;
    },
    blurList: () => {
      if (!listFocused() && !listFocusModeActive()) return false;
      listContainer?.blur();
      setListFocused(false);
      setListFocusModeActive(false);
      return true;
    },
    isListFocusModeActive: () => listFocusModeActive(),
  };
  let previousRunningCount: number | undefined;
  createEffect(() => {
    const runningCount = counts().running;
    const shouldReleaseFocus = shouldReleaseSidebarListFocus({
      previousRunningCount,
      runningCount,
      listFocusModeActive: listFocusModeActive(),
    });
    previousRunningCount = runningCount;
    if (!shouldReleaseFocus) return;

    focusRegistration.blurList();
    props.onReturnFocus();
  });
  const completedHistoryRegistration: SidebarCompletedHistoryRegistration = {
    toggleCompletedHistory: () => {
      setShowCompletedHistory((current) => !current);
      return true;
    },
  };
  onCleanup((props.controller as RegisteredSidebarViewController)[registerSidebar]({
    scroll: scrollRegistration,
    focus: focusRegistration,
    history: completedHistoryRegistration,
  }));

  createEffect(() => {
    const ids = visibleChildIDs();
    const current = selectedChildID();
    if (ids.length === 0) {
      if (current) setSelectedChildID(undefined);
      return;
    }
    if (!current || !ids.includes(current)) setSelectedChildID(ids[0]);
  });

  const refreshListFocused = (): void => {
    if (listFocused() && !listContainer) {
      setListFocused(false);
      return;
    }
    const focused = Boolean(
      listContainer?.focused || listContainer?.hasFocusedDescendant,
    );
    if (!focused && listFocused()) setListFocused(false);
  };

  const rowTopForIndex = (index: number): number => {
    let top = 0;
    const nowMs = props.nowMs();
    const sidebarWidth = props.sidebarWidth?.();
    for (let i = 0; i < index; i += 1) {
      const child = visibleChildren()[i];
      if (child) {
        top +=
          subagentRowHeight({
            child,
            nowMs,
            sidebarWidth,
            reservedWidth: SUBAGENTS_ROW_MARKER_WIDTH,
            usageLabel: props.usageLabel,
            childHint: props.childHint?.(child.id),
          }) + SUBAGENTS_ROW_GAP;
      }
    }
    return top;
  };

  const rowLayouts = (): SidebarScrollRowLayout[] => {
    const nowMs = props.nowMs();
    const sidebarWidth = props.sidebarWidth?.();
    return visibleChildren().map((child) => ({
      id: child.id,
      height: subagentRowHeight({
        child,
        nowMs,
        sidebarWidth,
        reservedWidth: SUBAGENTS_ROW_MARKER_WIDTH,
        usageLabel: props.usageLabel,
        childHint: props.childHint?.(child.id),
      }),
    }));
  };

  const currentSidebarScrollAnchor = (): SidebarScrollAnchor | undefined => {
    if (!scrollbox) return undefined;
    const rows = rowLayouts();
    if (rows.length === 0) return undefined;

    const viewportTop = clampedScrollTop(scrollbox, scrollbox.scrollTop);
    let top = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row) continue;
      const rowBottom = top + row.height;
      if (rowBottom > viewportTop) {
        return {
          childIDs: rows.slice(index).map((candidate) => candidate.id),
          intraRowOffset: Math.max(0, viewportTop - top),
        };
      }
      top = rowBottom + SUBAGENTS_ROW_GAP;
    }

    const lastRow = rows[rows.length - 1];
    return lastRow ? { childIDs: [lastRow.id], intraRowOffset: 0 } : undefined;
  };

  const scrollChildIntoView = (childID: string | undefined): void => {
    if (!scrollbox) return;
    const selectedIndex = visibleChildIDs().findIndex((id) => id === childID);
    if (selectedIndex < 0) return;
    const selectedChild = visibleChildren()[selectedIndex];
    if (!selectedChild) return;

    const rowTop = rowTopForIndex(selectedIndex);
    const rowBottom =
      rowTop +
      subagentRowHeight({
        child: selectedChild,
        nowMs: props.nowMs(),
        sidebarWidth: props.sidebarWidth?.(),
        reservedWidth: SUBAGENTS_ROW_MARKER_WIDTH,
        usageLabel: props.usageLabel,
        childHint: props.childHint?.(selectedChild.id),
      });
    const viewportTop = scrollbox.scrollTop;
    const viewportBottom = viewportTop + listHeight();

    if (rowTop < viewportTop) {
      const nextTop = clampedScrollTop(scrollbox, rowTop);
      scrollRegistration.offsetTop = nextTop;
      scrollbox.scrollTop = nextTop;
    } else if (rowBottom > viewportBottom) {
      const nextTop = clampedScrollTop(scrollbox, rowBottom - listHeight());
      scrollRegistration.offsetTop = nextTop;
      scrollbox.scrollTop = nextTop;
    }
  };

  const scrollSelectedChildIntoView = (): void => {
    if (!listFocusModeActive()) return;
    scrollChildIntoView(selectedChildID());
  };

  const moveSelection = (delta: number): void => {
    const ids = visibleChildIDs();
    if (ids.length === 0) return;
    const currentIndex = ids.findIndex((id) => id === selectedChildID());
    const fallbackIndex = delta > 0 ? 0 : ids.length - 1;
    const nextIndex = Math.max(
      0,
      Math.min(
        ids.length - 1,
        currentIndex < 0 ? fallbackIndex : currentIndex + delta,
      ),
    );
    setSelectedChildID(ids[nextIndex]);
    scrollChildIntoView(ids[nextIndex]);
  };

  const rowActivations = new Map<string, () => void>();

  const resolveNavigableChildTargetSessionID = (
    child: ChildSessionState,
  ): string | undefined =>
    resolveChildTargetSessionID(child) ??
    resolveSyntheticTargetFromHydratedState(props.state(), child);

  const selectedTargetSessionID = (): string | undefined => {
    const selected = visibleChildren().find(
      (child) => child.id === selectedChildID(),
    );
    return selected
      ? resolveNavigableChildTargetSessionID(selected)
      : undefined;
  };

  const activateSelectedChild = (): void => {
    const selectedID = selectedChildID();
    const activateRow = selectedID ? rowActivations.get(selectedID) : undefined;
    if (activateRow) {
      activateRow();
      return;
    }
    props.navigate(selectedTargetSessionID());
  };

  const toggleCompletedHistory = (): void => {
    completedHistoryRegistration.toggleCompletedHistory();
  };

  createEffect(() => {
    selectedChildID();
    listHeight();
    if (!listFocused()) return;
    scrollSelectedChildIntoView();
  });

  const handleListKeyDown = (event: KeyEvent): void => {
    if (!listFocused()) return;
    const name = event.name.toLowerCase();
    if (props.strictInput && (event.ctrl || event.shift || event.super || event.hyper ||
      ((event.meta || event.option) && name !== "b"))) return;
    if ((event.meta || event.option) && name === "b") {
      props.onToggleListFocus();
    } else if (name === "j" || name === "down" || name === "arrowdown") {
      moveSelection(1);
    } else if (name === "k" || name === "up" || name === "arrowup") {
      moveSelection(-1);
    } else if (name === "return" || name === "enter") {
      activateSelectedChild();
    } else if (name === "h" || name === "left" || name === "arrowleft") {
      if (props.expanded()) props.onSetExpanded(false);
    } else if (name === "l" || name === "right" || name === "arrowright") {
      if (!props.expanded()) props.onSetExpanded(true);
    } else if (name === "c") {
      toggleCompletedHistory();
    } else if (name === "escape" || name === "esc") {
      focusRegistration.blurList();
      props.onReturnFocus();
    } else {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  };

  props.registerListKeys({ target: () => listContainer, onKeyDown: handleListKeyDown });

  const restorePreservedScroll = (): void => {
    if (!scrollbox) return;
    if (scrollRegistration.restoreFramesRemaining <= 0) return;
    scrollRegistration.restoreFramesRemaining -= 1;

    if (restoreChildRowID) {
      const childRowID = restoreChildRowID;
      restoreChildRowID = undefined;
      scrollRegistration.restoreFramesRemaining = 0;
      if (visibleChildIDs().includes(childRowID)) {
        scrollChildIntoView(childRowID);
      } else {
        scrollbox.scrollTop = 0;
      }
      return;
    }

    const top = preservedSidebarScrollTop({
      expanded: props.expanded(),
      offsetTop: scrollRegistration.offsetTop,
      anchor: scrollRegistration.anchor,
      rows: scrollRegistration.getRows(),
      leadingHeight: scrollRegistration.getLeadingHeight(),
      scrollTop: scrollbox.scrollTop,
      scrollHeight: scrollbox.scrollHeight,
      viewportHeight: scrollbox.viewport.height,
    });
    if (top === undefined) return;
    scrollRegistration.offsetTop = top;
    scrollbox.scrollTop = top;
  };

  createEffect(() => {
    props.expanded();
    visibleChildIDs().join("|");
    visibleChildLayoutSignature();
    props.sidebarWidth?.();

    restorePreservedScroll();
  });

  const ChildRow = (rowProps: { childID: string }) => {
    const child = createMemo(() =>
      visibleChildren().find((candidate) => candidate.id === rowProps.childID),
    );
    const [hovered, setHovered] = createSignal(false);
    const [focused, setFocused] = createSignal(false);
    const targetSessionID = createMemo(() => {
      const currentChild = child();
      return currentChild
        ? resolveNavigableChildTargetSessionID(currentChild)
        : undefined;
    });
    const clickable = createMemo(() => isSessionTarget(targetSessionID()));
    const selected = createMemo(
      () => listFocused() && selectedChildID() === rowProps.childID,
    );
    const emphasized = createMemo(
      () => clickable() && (hovered() || focused() || selected()),
    );
    const status = createMemo<ChildSessionState["status"]>(
      () => child()?.status ?? "running",
    );
    const muted = createMemo(
      () => status() !== "running" && clickable() && !emphasized(),
    );
    const rowOpacity = createMemo(() =>
      status() === "running" ? 1 : INACTIVE_SUBAGENT_OPACITY,
    );
    const line = createMemo(() => {
      const currentChild = child();
      if (!currentChild) {
        return { labelLines: [""], elapsed: "00:00", meta: "" };
      }
      return formatChildRowLine({
        child: currentChild,
        nowMs: props.nowMs(),
        sidebarWidth: props.sidebarWidth?.(),
        reservedWidth: SUBAGENTS_ROW_MARKER_WIDTH,
        usageLabel: props.usageLabel,
      });
    });
    const terminalLine = createMemo(() => {
      const currentChild = child();
      if (!currentChild) return { label: "", meta: "00:00" };
      return formatTerminalChildRowLine({
        child: currentChild,
        nowMs: props.nowMs(),
        sidebarWidth: props.sidebarWidth?.(),
        reservedWidth: SUBAGENTS_ROW_MARKER_WIDTH,
        usageLabel: props.usageLabel,
      });
    });
    const rowHeight = createMemo(() => {
      const currentChild = child();
      if (!currentChild) return SUBAGENTS_TERMINAL_ROW_HEIGHT;
      return subagentRowHeight({
        child: currentChild,
        nowMs: props.nowMs(),
        sidebarWidth: props.sidebarWidth?.(),
        reservedWidth: SUBAGENTS_ROW_MARKER_WIDTH,
        usageLabel: props.usageLabel,
        childHint: props.childHint?.(currentChild.id),
      });
    });
    const modelLine = createMemo(() => {
      const currentChild = child();
      if (!currentChild) return undefined;
      return props.modelLine(
        currentChild,
        rowWidthBudget(props.sidebarWidth?.()) - SUBAGENTS_ROW_MARKER_WIDTH,
      );
    });
    const activate = () => {
      const target = targetSessionID();
      if (target) {
        props.onNavigateToChild({
          parentSessionID: props.sessionID,
          childSessionID: target,
          childRowID: rowProps.childID,
          showCompletedHistory: showCompletedHistory(),
        });
      }
      props.controller.snapshotScroll();
      props.navigate(target);
    };
    rowActivations.set(rowProps.childID, activate);
    onCleanup(() => {
      rowActivations.delete(rowProps.childID);
    });
    const handleKeyDown = (event: KeyEvent): void => {
      if (!clickable()) return;
      if (props.strictInput && (event.ctrl || event.meta || event.option || event.shift || event.super || event.hyper)) return;
      setFocused(true);
      if (event.name === "return" || event.name === "space") {
        activate();
        event.preventDefault();
        event.stopPropagation();
      }
    };

    return (
      <box
        flexDirection="column"
        height={rowHeight()}
        opacity={rowOpacity()}
        backgroundColor={selected() ? props.theme.backgroundElement : undefined}
        onMouseOver={clickable() ? () => setHovered(true) : undefined}
        onMouseOut={
          clickable()
            ? () => {
                setHovered(false);
                setFocused(false);
                setMouseDownChildID(undefined);
              }
            : undefined
        }
        onMouseDown={
          clickable()
            ? (event: MouseEvent) => {
                event.stopPropagation();
                setSelectedChildID(rowProps.childID);
                setMouseDownChildID(rowProps.childID);
              }
            : undefined
        }
        onMouseUp={
          clickable()
            ? (event: MouseEvent) => {
                if (mouseDownChildID() === rowProps.childID) {
                  event.stopPropagation();
                  activate();
                }
                setMouseDownChildID(undefined);
              }
            : undefined
        }
        onKeyDown={clickable() ? handleKeyDown : undefined}
        focusable={clickable()}
        focused={clickable() && focused()}
      >
        <Show
          when={status() === "running"}
          fallback={
            <box flexDirection="column">
              <box flexDirection="row">
                <text
                  fg={selected() ? props.theme.accent : props.theme.textMuted}
                >
                  {selected() ? "›" : " "}
                </text>
                <text fg={statusColor(status(), props.theme)}>
                  {taskStatusMarker(status())}
                </text>
                <text
                  fg={
                    selected()
                      ? props.theme.text
                      : muted()
                        ? props.theme.textMuted
                        : props.theme.text
                  }
                >{` ${terminalLine().label}`}</text>
              </box>
              <text
                fg={emphasized() ? props.theme.text : props.theme.textMuted}
              >{`    ↳ ${CLOCK_ICON} ${terminalLine().meta}`}</text>
              <Show when={modelLine()}>
                {(metadata: Accessor<string>) => (
                  <text fg={props.theme.textMuted}>{`    ${metadata()}`}</text>
                )}
              </Show>
            </box>
          }
        >
          <box flexDirection="column">
            <box flexDirection="row">
              <text
                fg={selected() ? props.theme.accent : props.theme.textMuted}
              >
                {selected() ? "›" : " "}
              </text>
              <text fg={statusColor(status(), props.theme)}>
                {taskStatusMarker(status())}
              </text>
              <text
                fg={
                  selected()
                    ? props.theme.text
                    : muted()
                      ? props.theme.textMuted
                      : props.theme.text
                }
              >{` ${line().labelLines[0] ?? ""}`}</text>
            </box>
            <Show when={line().secondaryLine}>
              {(secondaryLine: Accessor<string>) => (
                <text
                  fg={muted() ? props.theme.textMuted : props.theme.text}
                >{`    ${secondaryLine()}`}</text>
              )}
            </Show>
            <box flexDirection="row" paddingLeft={4}>
              <text
                fg={emphasized() ? props.theme.text : props.theme.textMuted}
              >{`↳ ${CLOCK_ICON} ${line().elapsed}`}</text>
              <Show when={line().meta.length > 0}>
                <text
                  fg={emphasized() ? props.theme.text : props.theme.textMuted}
                >{` ${TOKEN_ICON} ${line().meta}`}</text>
              </Show>
            </box>
            <Show when={modelLine()}>
              {(metadata: Accessor<string>) => (
                <text fg={props.theme.textMuted}>{`    ${metadata()}`}</text>
              )}
            </Show>
          </box>
        </Show>
        <Show when={props.childHint?.(rowProps.childID)}>
          {(hint: Accessor<string>) => <text fg={props.theme.warning}>{`    ${hint()}`}</text>}
        </Show>
      </box>
    );
  };

  const AggregateBar = () => (
    <box flexDirection="row" paddingRight={1}>
      <text fg={props.theme.warning}>{`● ${counts().running} run`}</text>
      <text fg={props.theme.textMuted}> · </text>
      <text fg={props.theme.success}>{`✓ ${counts().done} done`}</text>
      <text fg={props.theme.textMuted}> · </text>
      <text fg={props.theme.error}>{`✕ ${counts().error} err`}</text>
      <text fg={props.theme.textMuted}> · </text>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI text supports mouse targets. */}
      <text
        fg={showCompletedHistory() ? props.theme.accent : props.theme.text}
        selectable={false}
        onMouseDown={toggleCompletedHistory}
      >{`Σ ${totalExecuted()}`}</text>
    </box>
  );

  return (
    <box
      ref={(element) => {
        listContainer = element;
        if (!element) setListFocused(false);
      }}
      flexDirection="column"
      backgroundColor={listFocused() ? props.theme.backgroundPanel : undefined}
      focusable
      focused={listFocused()}
      renderBefore={() => {
        refreshListFocused();
        restorePreservedScroll();
      }}
    >
      <box flexDirection="row">
        <text
          fg={props.theme.text}
          selectable={false}
          onMouseDown={props.onToggleExpanded}
        >{`${props.expanded() ? SIDEBAR_ARROW_EXPANDED : SIDEBAR_ARROW_COLLAPSED} ${t("subagents")}`}</text>
        <Show when={PLUGIN_VERSION}>
          {(version: Accessor<string>) => (
            <box flexDirection="row">
              <text
                fg={props.theme.textMuted}
                opacity={SIDEBAR_VERSION_OPACITY}
                selectable={false}
                onMouseDown={props.onToggleExpanded}
              >{` ${version()}`}</text>
              <Show when={listFocused()}>
                <text
                  fg={props.theme.accent}
                  selectable={false}
                  onMouseDown={props.onToggleExpanded}
                >{` ${SIDEBAR_FOCUS_INDICATOR}`}</text>
              </Show>
            </box>
          )}
        </Show>
      </box>
      <AggregateBar />
      <Show when={props.notice?.()}>
        {(notice: Accessor<string>) => (
          <text fg={props.theme.warning}>{wrapCompactText(notice(), rowWidthBudget(props.sidebarWidth?.()), 3).join("\n")}</text>
        )}
      </Show>
      <Show when={props.usageLabel}>
        {(label: Accessor<string>) => (
          <text fg={props.theme.textMuted}>{wrapCompactText(label(), rowWidthBudget(props.sidebarWidth?.()), 3).join("\n")}</text>
        )}
      </Show>

      <Show when={props.expanded()}>
        <scrollbox
          ref={(element) => {
            scrollbox = element;
            restorePreservedScroll();
          }}
          height={listHeight()}
          scrollY
          viewportCulling={false}
        >
          <box flexDirection="column" rowGap={SUBAGENTS_ROW_GAP}>
            <For each={visibleChildIDs()}>
              {(childID: string) => <ChildRow childID={childID} />}
            </For>
          </box>
        </scrollbox>
      </Show>
    </box>
  );
}

export function HomeBottomStatus(props: {
  state: () => StatuslineState;
  theme: MonitorTheme;
}): JSX.Element {
  const snapshot = createMemo(() =>
    resolveTuiSubagentSnapshot({ state: props.state() }),
  );
  const counts = createMemo(() => snapshot().visibleCounts);
  const totalExecuted = createMemo(() => snapshot().totalExecuted);
  const visible = createMemo(
    () => counts().running > 0 || counts().error > 0 || totalExecuted() > 0,
  );

  return (
    <Show when={visible()}>
      <box paddingLeft={1} paddingRight={1}>
        <box flexDirection="row">
          <text fg={props.theme.warning}>{`● ${counts().running}`}</text>
          <text fg={props.theme.textMuted}> · </text>
          <text fg={props.theme.success}>{`✓ ${counts().done}`}</text>
          <text fg={props.theme.textMuted}> · </text>
          <text fg={props.theme.error}>{`✕ ${counts().error}`}</text>
          <text fg={props.theme.textMuted}> · </text>
          <text fg={props.theme.text}>{`Σ ${totalExecuted()}`}</text>
        </box>
      </box>
    </Show>
  );
}
