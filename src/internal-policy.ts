// Internal runtime policy. Not a package entry or public API.
export const TERMINAL_CHILD_TTL_MS = 3 * 24 * 60 * 60 * 1000;
export const MAX_TERMINAL_CHILDREN = 1_500;

export const V2_RETRY_INITIAL_DELAY_MS = 1_000;
export const V2_RETRY_MAX_DELAY_MS = 30_000;
export const V2_RETRY_MAX_ATTEMPTS = 6;
export const V2_DETAIL_CONCURRENCY = 4;
export const V2_HISTORY_PAGE_SIZE = 100;

export const V2_FOCUS_MAX_ATTEMPTS = 10;
export const V2_FOCUS_RETRY_DELAY_MS = 30;

export const ELAPSED_TICK_MS = 1000;
export const DONE_TOKEN_REHYDRATE_THROTTLE_MS = 2000;
export const MAINTENANCE_TICK_MS = DONE_TOKEN_REHYDRATE_THROTTLE_MS;

export const MAX_SYNC_LOG_READ_BYTES = 1024 * 1024;
