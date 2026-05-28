import * as collect from './collect.ts'
import * as config from '../lib/config.ts'
import * as db from '../lib/db.ts'
import type { Fetcher } from '../lib/http.ts'
import * as logger from '../lib/logger.ts'
import type { MaintenanceTaskRow, ShiplogConfig } from '../lib/types/index.ts'
import * as upserts from '../lib/upserts.ts'

const DEFAULT_MAINTENANCE_LIMIT = 10
const DEFAULT_STALE_LOCK_MINUTES = 120

export interface MaintenanceRunOptions {
  configPath?: string
  config?: ShiplogConfig
  fetch?: Fetcher
  now?: Date
  limit?: number
  staleLockMinutes?: number
}

export async function run(options: MaintenanceRunOptions = {}): Promise<void> {
  const shiplogConfig = options.config ?? config.load(options.configPath)
  const now = options.now ?? new Date()
  const limit = options.limit ?? DEFAULT_MAINTENANCE_LIMIT
  const staleLockMinutes = maintenanceStaleLockMinutes(options)
  if (staleLockMinutes > 0) {
    const recovered = await upserts.recoverStaleMaintenanceTasks(
      new Date(now.getTime() - staleLockMinutes * 60 * 1000),
      now,
      `maintenance task lock exceeded ${staleLockMinutes} minute(s)`
    )
    if (recovered.length > 0) {
      logger.warn(`[maintenance] recovered ${recovered.length} stale task lock(s)`)
    }
  }

  const tasks = await upserts.dueMaintenanceTasks(now, limit)

  if (tasks.length === 0) {
    logger.info('[maintenance] no due tasks')
    return
  }

  const failures: string[] = []
  for (const task of tasks) {
    try {
      await runTask(task, shiplogConfig, now, options.fetch)
    } catch (err) {
      const message = errorMessage(err)
      failures.push(`task ${task.id}: ${message}`)
      await upserts.markMaintenanceTaskFailed(task.id, message, nextRetryAt(now))
      logger.error(`[maintenance] task ${task.id} failed: ${message}`)
    }
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length} maintenance task(s) failed`)
  }
}

async function runTask(
  task: MaintenanceTaskRow,
  shiplogConfig: ShiplogConfig,
  now: Date,
  fetch?: Fetcher
): Promise<void> {
  const runningTask = await upserts.markMaintenanceTaskRunning(task.id, now)
  if (!runningTask) {
    logger.info(`[maintenance] task ${task.id}: already claimed or no longer due`)
    return
  }

  if (runningTask.task_type !== 'repair_range') {
    throw new Error(`unsupported maintenance task type: ${runningTask.task_type}`)
  }

  const repairDates = dateRange(
    dateOnly(runningTask.target_from_on),
    dateOnly(runningTask.target_to_on)
  )
  logger.info(
    `[maintenance] task ${runningTask.id}: repair ${repairDates[0]} to ${repairDates.at(-1)}`
  )

  const processedAccounts = await collect.runDates({
    config: shiplogConfig,
    dates: repairDates,
    accountIds: [runningTask.account_id],
    advanceCheckpoint: false,
    logPrefix: 'maintenance',
    fetch
  })

  if (processedAccounts === 0) {
    throw new Error(`account ${runningTask.account_id} is not configured for maintenance`)
  }

  await upserts.markMaintenanceTaskSucceeded(runningTask.id)
}

function nextRetryAt(now: Date): Date {
  return new Date(now.getTime() + 60 * 60 * 1000)
}

function maintenanceStaleLockMinutes(options: MaintenanceRunOptions): number {
  if (options.staleLockMinutes !== undefined) {
    return assertNonNegativeInteger(options.staleLockMinutes, 'staleLockMinutes')
  }

  const envValue = process.env.MAINTENANCE_STALE_LOCK_MINUTES?.trim()
  if (!envValue) return DEFAULT_STALE_LOCK_MINUTES

  return assertNonNegativeInteger(Number(envValue), 'MAINTENANCE_STALE_LOCK_MINUTES')
}

function assertNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer; got ${value}`)
  }

  return value
}

function dateRange(start: string, end: string): string[] {
  const out: string[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) {
    out.push(d)
  }
  return out
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function dateOnly(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10)
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message
  return String(err)
}

if (import.meta.main) {
  run()
    .catch((err: unknown) => {
      logger.error(err)
      process.exitCode = 1
    })
    .finally(async () => {
      await db.close()
    })
}
