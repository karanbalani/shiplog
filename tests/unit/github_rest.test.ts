import { expect, test } from 'bun:test'
import { restClient } from '../../lib/providers/github/rest.ts'
import type { Fetcher } from '../../lib/http.ts'

test('restClient throttles GitHub search requests', async () => {
  const sleeps: number[] = []
  const fetch: Fetcher = async () => jsonResponse({ ok: true })
  const rest = restClient({
    token: 'test-token',
    fetch,
    searchRequestIntervalMs: 2500,
    now: () => 10_000,
    sleep: async (ms) => {
      sleeps.push(ms)
    }
  })

  await rest('/search/issues', { q: 'type:pr author:octocat' })
  await rest('/search/issues', { q: 'type:issue author:octocat' })

  expect(sleeps).toEqual([2500])
})

test('restClient retries GitHub rate limits using retry-after', async () => {
  let attempts = 0
  const sleeps: number[] = []
  const fetch: Fetcher = async () => {
    attempts += 1
    if (attempts === 1) {
      return new Response('{"message":"API rate limit exceeded"}', {
        status: 403,
        headers: { 'retry-after': '2' }
      })
    }

    return jsonResponse({ ok: true })
  }
  const rest = restClient({
    token: 'test-token',
    fetch,
    searchRequestIntervalMs: 0,
    sleep: async (ms) => {
      sleeps.push(ms)
    }
  })

  const result = await rest('/search/issues', { q: 'type:pr author:octocat' })

  expect(result).toEqual({ ok: true })
  expect(attempts).toBe(2)
  expect(sleeps).toEqual([2000])
})

test('restClient retries GitHub rate limits using x-ratelimit-reset', async () => {
  let attempts = 0
  const sleeps: number[] = []
  const fetch: Fetcher = async () => {
    attempts += 1
    if (attempts === 1) {
      return new Response('{"message":"API rate limit exceeded"}', {
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '103'
        }
      })
    }

    return jsonResponse({ ok: true })
  }
  const rest = restClient({
    token: 'test-token',
    fetch,
    searchRequestIntervalMs: 0,
    now: () => 100_000,
    sleep: async (ms) => {
      sleeps.push(ms)
    }
  })

  const result = await rest('/search/issues', { q: 'type:pr author:octocat' })

  expect(result).toEqual({ ok: true })
  expect(attempts).toBe(2)
  expect(sleeps).toEqual([4000])
})

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}
