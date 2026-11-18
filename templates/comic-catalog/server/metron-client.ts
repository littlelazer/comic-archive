// ABOUTME: HTTP client for the Metron comic database API with rate-limit, retry and timeout handling.
// ABOUTME: Sends no credentials; the credential gateway injects Authorization at the network boundary.

export const METRON_BASE_URL = 'https://metron.cloud/api/';

export type FailureReason = 'rate_limited' | 'metron_unavailable' | 'auth' | 'not_found' | 'bad_request';

export type MetronResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: FailureReason; retryable: boolean; retryAfterSeconds?: number };

export interface MetronIssueSummary {
  id: number;
  series: { id: number; name: string; volume: number; year_began: number };
  number: string;
  issue: string;
  cover_date: string | null;
  image: string | null;
}

// Metron's detail response has no `issue` label, and reports an absent upc or isbn as an empty string.
export interface MetronIssueDetail extends Omit<MetronIssueSummary, 'issue'> {
  publisher?: { name: string };
  upc: string;
  isbn: string;
  variants: { name: string }[];
  reprints: { id: number; issue: string }[];
}

export interface MetronPage<T> {
  count: number;
  next: string | null;
  results: T[];
}

export interface MetronClientOptions {
  baseUrl: string;
  userAgent: string;
  totalWaitBudgetMs?: number;
  requestTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TOTAL_WAIT_BUDGET_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_AFTER_SECONDS = 5;
const SERVER_ERROR_BACKOFF_MS = [1000, 2000];
const LOW_BURST_REMAINING = 2;

const unavailable = { ok: false, reason: 'metron_unavailable', retryable: true } as const;

export function createMetronClient(opts: MetronClientOptions) {
  const totalWaitBudgetMs = opts.totalWaitBudgetMs ?? DEFAULT_TOTAL_WAIT_BUDGET_MS;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // Epoch milliseconds before which no request should be sent, set when Metron reports a low burst allowance.
  let slowUntil = 0;

  function noteBurst(res: Response): void {
    const remaining = Number(res.headers.get('X-RateLimit-Burst-Remaining'));
    const resetSeconds = Number(res.headers.get('X-RateLimit-Burst-Reset'));
    if (res.headers.has('X-RateLimit-Burst-Remaining') && remaining <= LOW_BURST_REMAINING && resetSeconds > 0) {
      slowUntil = resetSeconds * 1000;
    }
  }

  async function get<T>(path: string, params: Record<string, string> = {}): Promise<MetronResult<T>> {
    const url = new URL(path, opts.baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    let waitedMs = 0;
    const wait = async (ms: number) => {
      waitedMs += ms;
      await sleep(ms);
    };

    // A burst wait longer than the budget is skipped: the request is sent and Metron's own 429 handling applies.
    const burstWaitMs = slowUntil - Date.now();
    if (burstWaitMs > 0 && burstWaitMs <= totalWaitBudgetMs) await wait(burstWaitMs);

    let serverErrors = 0;
    for (;;) {
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { 'User-Agent': opts.userAgent, Accept: 'application/json' },
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
      } catch {
        res = new Response(null, { status: 599 });
      }
      noteBurst(res);

      if (res.ok) return { ok: true, data: (await res.json()) as T };
      if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth', retryable: false };
      if (res.status === 404) return { ok: false, reason: 'not_found', retryable: false };

      if (res.status === 429) {
        const retryAfterSeconds = Number(res.headers.get('Retry-After')) || DEFAULT_RETRY_AFTER_SECONDS;
        if (waitedMs + retryAfterSeconds * 1000 > totalWaitBudgetMs) {
          return { ok: false, reason: 'rate_limited', retryable: true, retryAfterSeconds };
        }
        await wait(retryAfterSeconds * 1000);
        continue;
      }

      if (res.status >= 500 && serverErrors < SERVER_ERROR_BACKOFF_MS.length) {
        await wait(SERVER_ERROR_BACKOFF_MS[serverErrors++]);
        continue;
      }
      if (res.status >= 400 && res.status < 500) return { ok: false, reason: 'bad_request', retryable: false };
      return unavailable;
    }
  }

  return {
    searchIssues: (params: Record<string, string>) => get<MetronPage<MetronIssueSummary>>('issue/', params),
    getIssue: (id: number) => get<MetronIssueDetail>(`issue/${id}/`),
    searchSeries: (params: Record<string, string>) =>
      get<MetronPage<{ id: number; series: string; volume: number; year_began: number }>>('series/', params),
  };
}

export type MetronClient = ReturnType<typeof createMetronClient>;
