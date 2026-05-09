export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

export interface FetchJsonOptions {
  fetch?: Fetcher
  retries?: number
  retryDelayMs?: number
  timeoutMs?: number
}

export async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit = {},
  opts: FetchJsonOptions = {}
): Promise<T> {
  const fetcher = opts.fetch ?? globalThis.fetch
  const retries = opts.retries ?? 3
  const retryDelayMs = opts.retryDelayMs ?? 500

  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(fetcher, url, init, opts.timeoutMs)
      if (response.ok) {
        return parseJsonResponse<T>(response)
      }

      const body = await response.text()
      if (response.status >= 500 && attempt < retries) {
        await sleep(retryDelayMs * 2 ** attempt)
        continue
      }

      throw httpError(url, response.status, body)
    } catch (err) {
      lastError = err
      if (attempt < retries && isRetryableError(err)) {
        await sleep(retryDelayMs * 2 ** attempt)
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

function httpError(url: string, status: number, body: string): Error & { status?: number } {
  const error = new Error(`HTTP ${status} ${url}: ${body.slice(0, 200)}`) as Error & {
    status?: number
  }
  error.status = status
  return error
}

function isRetryableError(err: unknown): boolean {
  return !(err instanceof Error && 'status' in err)
}
