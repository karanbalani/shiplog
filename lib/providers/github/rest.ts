import { fetchJson, type Fetcher } from '../../http.ts'

const BASE_URL = 'https://api.github.com'

export interface RestClientOptions {
  token: string
  fetch?: Fetcher
}

export type RestClient = <T = unknown>(
  path: string,
  params?: Record<string, string | number | undefined>
) => Promise<T>

export function restClient({ token, fetch }: RestClientOptions): RestClient {
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

    return fetchJson<T>(
      url.toString(),
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'shiplog'
        }
      },
      fetch ? { fetch } : {}
    )
  }
}
