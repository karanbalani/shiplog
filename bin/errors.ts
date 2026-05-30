import * as db from '../lib/db.ts'
import * as logger from '../lib/logger.ts'
import * as upserts from '../lib/upserts.ts'

const DEFAULT_RETENTION_DAYS = 30
const MS_PER_DAY = 24 * 60 * 60 * 1000

export interface PruneErrorEventsOptions {
  now?: Date
  retentionDays?: number
}

export async function prune(options: PruneErrorEventsOptions = {}): Promise<number> {
  const now = options.now ?? new Date()
  const retentionDays = errorEventRetentionDays(options)
  const cutoff = new Date(now.getTime() - retentionDays * MS_PER_DAY)
  const deleted = await upserts.pruneErrorEventsBefore(cutoff)

  logger.info(`[errors] pruned ${deleted} error event(s) older than ${retentionDays} day(s)`)
  return deleted
}

function errorEventRetentionDays(options: PruneErrorEventsOptions): number {
  if (options.retentionDays !== undefined) {
    return assertPositiveInteger(options.retentionDays, 'retentionDays')
  }

  const envValue = process.env.ERROR_EVENT_RETENTION_DAYS?.trim()
  if (!envValue) return DEFAULT_RETENTION_DAYS

  return assertPositiveInteger(Number(envValue), 'ERROR_EVENT_RETENTION_DAYS')
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer; got ${value}`)
  }

  return value
}

if (import.meta.main) {
  const command = Bun.argv[2] ?? 'prune'
  try {
    if (command !== 'prune') throw new Error(`unsupported errors command: ${command}`)
    await prune()
  } finally {
    await db.close()
  }
}
