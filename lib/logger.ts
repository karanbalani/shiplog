export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LoggerLevel = LogLevel | 'silent'

export interface LoggerOptions {
  level?: LoggerLevel
  colors?: boolean
  now?: () => Date
  write?: (line: string) => void
}

export interface Logger {
  debug(message: unknown): void
  info(message: unknown): void
  warn(message: unknown): void
  error(message: unknown): void
}

const LEVEL_WEIGHT: Record<LoggerLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: Number.POSITIVE_INFINITY
}

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m'
}

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

let defaultLogger = createLogger()

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = normalizeLevel(
    options.level ?? process.env.SHIPLOG_LOG_LEVEL ?? process.env.LOG_LEVEL
  )
  const colors = options.colors ?? shouldUseColors()
  const now = options.now ?? (() => new Date())
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`))

  return {
    debug: (message: unknown) => writeLog('debug', message, level, colors, now, write),
    info: (message: unknown) => writeLog('info', message, level, colors, now, write),
    warn: (message: unknown) => writeLog('warn', message, level, colors, now, write),
    error: (message: unknown) => writeLog('error', message, level, colors, now, write)
  }
}

export function configureLogger(options: LoggerOptions): void {
  defaultLogger = createLogger(options)
}

export function resetLogger(): void {
  defaultLogger = createLogger()
}

export function debug(message: unknown): void {
  defaultLogger.debug(message)
}

export function info(message: unknown): void {
  defaultLogger.info(message)
}

export function warn(message: unknown): void {
  defaultLogger.warn(message)
}

export function error(message: unknown): void {
  defaultLogger.error(message)
}

function writeLog(
  level: LogLevel,
  message: unknown,
  configuredLevel: LoggerLevel,
  colors: boolean,
  now: () => Date,
  write: (line: string) => void
): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[configuredLevel]) return

  const timestamp = now().toISOString()
  const levelLabel = level.toUpperCase().padEnd(5, ' ')
  const line = `${colorize(timestamp, DIM, colors)} ${colorize(
    levelLabel,
    LEVEL_COLOR[level],
    colors
  )} ${formatMessage(message)}`

  write(line)
}

function normalizeLevel(value: string | undefined): LoggerLevel {
  if (
    value === 'debug' ||
    value === 'info' ||
    value === 'warn' ||
    value === 'error' ||
    value === 'silent'
  ) {
    return value
  }

  return 'info'
}

function shouldUseColors(): boolean {
  if (process.env.NO_COLOR !== undefined) return false
  return process.env.TERM !== 'dumb'
}

function colorize(value: string, color: string, enabled: boolean): string {
  return enabled ? `${color}${value}${RESET}` : value
}

function formatMessage(message: unknown): string {
  if (message instanceof Error) return message.stack ?? message.message
  if (typeof message === 'string') return message

  try {
    return JSON.stringify(message)
  } catch {
    return String(message)
  }
}
