import { expect, test } from 'bun:test'
import { createLogger } from '../../lib/logger.ts'

const fixedNow = () => new Date('2026-05-10T12:34:56.789Z')

test('logger writes timestamped levelled lines', () => {
  const lines: string[] = []
  const logger = createLogger({
    level: 'debug',
    colors: false,
    now: fixedNow,
    write: (line) => lines.push(line)
  })

  logger.info('[init] backfill complete')

  expect(lines).toEqual(['2026-05-10T12:34:56.789Z INFO  [init] backfill complete'])
})

test('logger filters below configured level', () => {
  const lines: string[] = []
  const logger = createLogger({
    level: 'warn',
    colors: false,
    now: fixedNow,
    write: (line) => lines.push(line)
  })

  logger.debug('debug')
  logger.info('info')
  logger.warn('warn')
  logger.error('error')

  expect(lines).toEqual([
    '2026-05-10T12:34:56.789Z WARN  warn',
    '2026-05-10T12:34:56.789Z ERROR error'
  ])
})

test('logger can color timestamps and levels', () => {
  const lines: string[] = []
  const logger = createLogger({
    level: 'error',
    colors: true,
    now: fixedNow,
    write: (line) => lines.push(line)
  })

  logger.error('boom')

  expect(lines[0]).toContain('\x1b[2m2026-05-10T12:34:56.789Z\x1b[0m')
  expect(lines[0]).toContain('\x1b[31mERROR\x1b[0m')
  expect(lines[0]).toEndWith(' boom')
})

test('logger formats errors with stack or message', () => {
  const lines: string[] = []
  const logger = createLogger({
    level: 'error',
    colors: false,
    now: fixedNow,
    write: (line) => lines.push(line)
  })

  logger.error(new Error('boom'))

  expect(lines[0]).toContain('ERROR')
  expect(lines[0]).toContain('boom')
})
