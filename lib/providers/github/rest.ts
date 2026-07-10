import { fetchJson, HttpError, sleep, type Fetcher } from '../../http.ts'
import { isGitHubRateLimitError } from './errors.ts'

const BASE_URL = 'https://api.github.com'
export const GITHUB_SEARCH_REQUEST_INTERVAL_MS = 2500
const RATE_LIMIT_RESET_BUFFER_MS = 1000
const RATE_LIMIT_RETRIES = 5
const DEFAULT_REST_RETRIES = 6
const DEFAULT_REST_RETRY_DELAY_MS = 1_000
const TEST_REST_RETRY_DELAY_MS = 1

export interface RestClientOptions {
  token: string
  fetch?: Fetcher
  rateLimitRetries?: number
  searchRequestIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export type RestClient = <T = unknown>(
  path: string,
  params?: Record<string, string | number | undefined>
) => Promise<T>

export function restClient(options: RestClientOptions): RestClient {
  const {
    token,
    fetch,
    rateLimitRetries = RATE_LIMIT_RETRIES,
    searchRequestIntervalMs = fetch ? 0 : GITHUB_SEARCH_REQUEST_INTERVAL_MS,
    sleep: sleepFn = sleep,
    now = Date.now
  } = options
  let lastSearchRequestAt = 0

  return async function rest<T = unknown>(
    path: string,
    params: Record<string, string | number | undefined> = {}
  ): Promise<T> {
    const url = new URL(path.startsWith('http') ? path : `${BASE_URL}${path}`)

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value))
      }
    }

    if (isSearchRequest(url)) {
      const elapsed = now() - lastSearchRequestAt
      if (lastSearchRequestAt > 0 && elapsed < searchRequestIntervalMs) {
        await sleepFn(searchRequestIntervalMs - elapsed)
      }
      lastSearchRequestAt = now()
    }

    for (let attempt = 0; attempt <= rateLimitRetries; attempt += 1) {
      try {
        return await fetchJson<T>(
          url.toString(),
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
              'User-Agent': 'shiplog'
            }
          },
          {
            retries: DEFAULT_REST_RETRIES,
            retryDelayMs: fetch ? TEST_REST_RETRY_DELAY_MS : DEFAULT_REST_RETRY_DELAY_MS,
            timeoutMs: 60_000,
            ...(fetch ? { fetch } : {})
          }
        )
      } catch (err) {
        if (
          !(err instanceof HttpError) ||
          !isGitHubRateLimitError(err) ||
          attempt >= rateLimitRetries
        ) {
          throw err
        }

        await sleepFn(rateLimitDelayMs(err, now()))
      }
    }

    throw new Error('github rest client exhausted rate-limit retries')
  }
}

function isSearchRequest(url: URL): boolean {
  return url.hostname === 'api.github.com' && url.pathname.startsWith('/search/')
}

function rateLimitDelayMs(err: HttpError, nowMs: number): number {
  const retryAfterMs = retryAfterDelayMs(err.headers.get('retry-after'), nowMs)
  if (retryAfterMs !== null) return retryAfterMs

  const resetAtSeconds = Number(err.headers.get('x-ratelimit-reset'))
  if (Number.isFinite(resetAtSeconds) && resetAtSeconds > 0) {
    return Math.max(0, resetAtSeconds * 1000 - nowMs + RATE_LIMIT_RESET_BUFFER_MS)
  }

  return 60_000
}

function retryAfterDelayMs(value: string | null, nowMs: number): number | null {
  if (!value) return null

  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)

  const dateMs = Date.parse(value)
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - nowMs)

  return null
}
