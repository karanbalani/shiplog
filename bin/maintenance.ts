import * as collect from './collect.ts'
import * as config from '../lib/config.ts'
import * as db from '../lib/db.ts'
import type { Fetcher } from '../lib/http.ts'
import * as logger from '../lib/logger.ts'
import type { MaintenanceTaskRow, ShiplogConfig } from '../lib/types/index.ts'
import * as upserts from '../lib/upserts.ts'

const DEFAULT_MAINTENANCE_LIMIT = 10

export interface MaintenanceRunOptions {
  configPath?: string
  config?: ShiplogConfig
  fetch?: Fetcher
  now?: Date
  limit?: number
}

export async function run(options: MaintenanceRunOptions = {}): Promise<void> {
  const shiplogConfig = options.config ?? config.load(options.configPath)
  const now = options.now ?? new Date()
  const limit = options.limit ?? DEFAULT_MAINTENANCE_LIMIT
  const tasks = await upserts.dueMaintenanceTasks(now, limit)

  if (tasks.length === 0) {
    logger.info('[maintenance] no due tasks')
    return
  }

  const failures: string[] = []
  for (const task of tasks) {
    try {
      await runTask(task, shiplogConfig, options.fetch)
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
  fetch?: Fetcher
): Promise<void> {
  const runningTask = await upserts.markMaintenanceTaskRunning(task.id)

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
