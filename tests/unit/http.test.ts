import { expect, test } from 'bun:test'
import * as http from '../../lib/http.ts'
import type { Fetcher } from '../../lib/http.ts'

test('fetchJson returns parsed JSON on 2xx', async () => {
  const calls: string[] = []
  const mockFetch: Fetcher = async (url) => {
    calls.push(String(url))
    return new Response('{"hello":"world"}', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }

  const result = await http.fetchJson('https://example.com', {}, { fetch: mockFetch })

  expect(result).toEqual({ hello: 'world' })
  expect(calls).toEqual(['https://example.com'])
})

test('fetchJson returns null on empty 2xx body', async () => {
  const mockFetch: Fetcher = async () => new Response('', { status: 204 })

  const result = await http.fetchJson('https://example.com', {}, { fetch: mockFetch })

  expect(result).toBeNull()
})

test('fetchJson retries on 5xx and succeeds', async () => {
  let attempts = 0
  const mockFetch: Fetcher = async () => {
    attempts += 1
    if (attempts < 3) return new Response('bad gateway', { status: 502 })
    return new Response('{"ok":true}', { status: 200 })
  }

  const result = await http.fetchJson(
    'https://example.com',
    {},
    {
      fetch: mockFetch,
      retries: 3,
      retryDelayMs: 1
    }
  )

  expect(result).toEqual({ ok: true })
  expect(attempts).toBe(3)
})

test('fetchJson honors retry-after on retryable HTTP errors', async () => {
  let attempts = 0
  const sleeps: number[] = []
  const mockFetch: Fetcher = async () => {
    attempts += 1
    if (attempts === 1) {
      return new Response('service unavailable', {
        status: 503,
        headers: { 'retry-after': '2' }
      })
    }
    return new Response('{"ok":true}', { status: 200 })
  }

  const result = await http.fetchJson(
    'https://example.com',
    {},
    {
      fetch: mockFetch,
      retries: 2,
      retryDelayMs: 1,
      sleep: async (ms) => {
        sleeps.push(ms)
      }
    }
  )

  expect(result).toEqual({ ok: true })
  expect(sleeps).toEqual([2000])
})

test('fetchJson retries network errors and succeeds', async () => {
  let attempts = 0
  const mockFetch: Fetcher = async () => {
    attempts += 1
    if (attempts < 2) throw new Error('socket hang up')
    return new Response('{"ok":true}', { status: 200 })
  }

  const result = await http.fetchJson(
    'https://example.com',
    {},
    {
      fetch: mockFetch,
      retries: 2,
      retryDelayMs: 1
    }
  )

  expect(result).toEqual({ ok: true })
  expect(attempts).toBe(2)
})

test('fetchJson throws on 4xx without retrying', async () => {
  let attempts = 0
  const mockFetch: Fetcher = async () => {
    attempts += 1
    return new Response('unauthorized', { status: 401 })
  }

  await expect(
    http.fetchJson('https://example.com', {}, { fetch: mockFetch, retries: 3, retryDelayMs: 1 })
  ).rejects.toThrow(/401/)
  expect(attempts).toBe(1)
})

test('fetchJson exposes generic HTTP error metadata', async () => {
  const mockFetch: Fetcher = async () =>
    new Response('too many requests', {
      status: 429,
      headers: { 'retry-after': '2' }
    })

  try {
    await http.fetchJson('https://example.com', {}, { fetch: mockFetch, retries: 0 })
    throw new Error('expected request to fail')
  } catch (err) {
    expect(err).toBeInstanceOf(http.HttpError)
    const httpErr = err as http.HttpError
    expect(httpErr.status).toBe(429)
    expect(httpErr.body).toBe('too many requests')
    expect(httpErr.headers.get('retry-after')).toBe('2')
  }
})

test('fetchJson times out requests', async () => {
  const mockFetch: Fetcher = async (_url, init) => {
    await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })
    return new Response('never')
  }

  await expect(
    http.fetchJson(
      'https://example.com',
      {},
      {
        fetch: mockFetch,
        retries: 0,
        timeoutMs: 1
      }
    )
  ).rejects.toThrow(/aborted|timed out/i)
})
