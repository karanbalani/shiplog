import * as collect from './collect.ts'
import * as db from '../lib/db.ts'
import type { Fetcher } from '../lib/http.ts'
import * as logger from '../lib/logger.ts'
import type { ShiplogConfig } from '../lib/types/index.ts'
import * as dates from '../lib/utils/dates.ts'

export interface RepairRunOptions {
  configPath?: string
  config?: ShiplogConfig
  date?: string
  fromDate?: string
  toDate?: string
  fetch?: Fetcher
  now?: Date
}

interface RepairDateRequest {
  date?: string
  from?: string
  to?: string
}

export async function run(options: RepairRunOptions = {}): Promise<void> {
  const request = repairDateRequest(options)
  const yesterday = dates.yesterdayUTC(options.now)
  assertRepairDateRequest(request, yesterday)

  const label = request.date ? request.date : `${request.from} to ${request.to}`
  logger.info(`[repair] repairing ${label}`)

  await collect.runDates({
    configPath: options.configPath,
    config: options.config,
    dates: repairDates(request),
    advanceCheckpoint: false,
    logPrefix: 'repair',
    fetch: options.fetch,
    now: options.now
  })
}

function repairDateRequest(options: RepairRunOptions): RepairDateRequest {
  return {
    date: optionalDate(options.date ?? process.env.REPAIR_DATE),
    from: optionalDate(options.fromDate ?? process.env.REPAIR_FROM),
    to: optionalDate(options.toDate ?? process.env.REPAIR_TO)
  }
}

function optionalDate(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function assertRepairDateRequest(request: RepairDateRequest, yesterday: string): void {
  if (!request.date && !request.from && !request.to) {
    throw new Error('REPAIR_DATE or REPAIR_FROM and REPAIR_TO must be set')
  }

  if (request.date) {
    if (request.from || request.to) {
      throw new Error('REPAIR_DATE cannot be combined with REPAIR_FROM or REPAIR_TO')
    }
    assertRepairDate(request.date, 'REPAIR_DATE')
    assertNotFutureRepairDate(request.date, yesterday, 'REPAIR_DATE')
    return
  }

  if (!request.from || !request.to) {
    throw new Error('REPAIR_FROM and REPAIR_TO must be set together')
  }

  assertRepairDate(request.from, 'REPAIR_FROM')
  assertRepairDate(request.to, 'REPAIR_TO')
  assertRepairDateRangeOrder(request.from, request.to)
  assertNotFutureRepairDate(request.to, yesterday, 'REPAIR_TO')
}

function assertRepairDate(repairDate: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(repairDate)) {
    throw new Error(`${label} must use YYYY-MM-DD format; got ${repairDate}`)
  }

  const parsed = new Date(`${repairDate}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== repairDate) {
    throw new Error(`${label} must be a valid calendar date; got ${repairDate}`)
  }
}

function assertRepairDateRangeOrder(from: string, to: string): void {
  if (from > to) {
    throw new Error(`REPAIR_FROM must be on or before REPAIR_TO; got ${from} to ${to}`)
  }
}

function assertNotFutureRepairDate(repairDate: string, yesterday: string, label: string): void {
  if (repairDate > yesterday) {
    throw new Error(`${label} must be ${yesterday} or earlier; got ${repairDate}`)
  }
}

function repairDates(request: RepairDateRequest): string[] {
  if (request.date) return [request.date]
  return dateRange(request.from!, request.to!)
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
