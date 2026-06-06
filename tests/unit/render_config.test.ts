import { expect, test } from 'bun:test'
import path from 'node:path'
import * as renderConfig from '../../lib/render_config.ts'

const ROOT = path.join(import.meta.dir, '..', '..')

test('load accepts the shipped fallback render config', () => {
  const c = renderConfig.load(path.join(ROOT, '.shiplog', 'render.json'))

  expect(c.version).toBe(1)
  expect(c.markdown.length).toBeGreaterThan(0)
  expect(c.queries?.profile_stats?.mode).toBe('many')
})

test('validate defaults missing queries to an empty object', () => {
  const c = renderConfig.validate({
    version: 1,
    markdown: [
      {
        type: 'heading',
        level: 1,
        text: 'Hello'
      }
    ]
  })

  expect(c.queries).toEqual({})
})

test('validate rejects empty markdown blocks', () => {
  expect(() =>
    renderConfig.validate({
      version: 1,
      markdown: []
    })
  ).toThrow(/at least one markdown block/i)
})
