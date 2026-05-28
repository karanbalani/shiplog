export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

export interface FetchJsonOptions {
  fetch?: Fetcher
  retries?: number
  retryDelayMs?: number
  maxRetryDelayMs?: number
  retryStatuses?: number[]
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
}

export class HttpError extends Error {
  readonly status: number
  readonly body: string
  readonly headers: Headers

  constructor(url: string, status: number, body: string, headers: Headers) {
    super(`HTTP ${status} ${url}: ${body.slice(0, 200)}`)
    this.name = 'HttpError'
    this.status = status
    this.body = body
    this.headers = headers
  }
}

export async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit = {},
  opts: FetchJsonOptions = {}
): Promise<T> {
  const fetcher = opts.fetch ?? globalThis.fetch
  const retries = opts.retries ?? 3
  const retryDelayMs = opts.retryDelayMs ?? 500
  const maxRetryDelayMs = opts.maxRetryDelayMs ?? 30_000
  const retryStatuses = new Set(opts.retryStatuses ?? [408, 500, 502, 503, 504])
  const sleepFn = opts.sleep ?? sleep

  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(fetcher, url, init, opts.timeoutMs)
      if (response.ok) {
        return parseJsonResponse<T>(response)
      }

      const body = await response.text()
      const error = new HttpError(url, response.status, body, new Headers(response.headers))
      if (attempt < retries && retryStatuses.has(response.status)) {
        await sleepFn(retryDelayMsForAttempt(error.headers, attempt, retryDelayMs, maxRetryDelayMs))
        continue
      }

      throw error
    } catch (err) {
      lastError = err
      if (attempt < retries && isRetryableError(err)) {
        const headers = err instanceof HttpError ? err.headers : undefined
        await sleepFn(retryDelayMsForAttempt(headers, attempt, retryDelayMs, maxRetryDelayMs))
        continue
      }

      throw err
    }
  }

  throw lastError
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchWithTimeout(
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
  timeoutMs: number | undefined
): Promise<Response> {
  if (!timeoutMs) return fetcher(url, init)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetcher(url, {
      ...init,
      signal: controller.signal
    })
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`request timed out after ${timeoutMs}ms`)
    }

    throw err
  } finally {
    clearTimeout(timeout)
  }
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const body = await response.text()
  return body ? (JSON.parse(body) as T) : (null as T)
}

function isRetryableError(err: unknown): boolean {
  return !(err instanceof HttpError)
}

function retryDelayMsForAttempt(
  headers: Headers | undefined,
  attempt: number,
  retryDelayMs: number,
  maxRetryDelayMs: number
): number {
  const retryAfter = retryAfterDelayMs(headers?.get('retry-after') ?? null)
  if (retryAfter !== null) return Math.min(retryAfter, maxRetryDelayMs)

  return Math.min(retryDelayMs * 2 ** attempt, maxRetryDelayMs)
}

function retryAfterDelayMs(value: string | null): number | null {
  if (!value) return null

  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)

  const dateMs = Date.parse(value)
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now())

  return null
}
