import * as db from '../lib/db.ts'

interface ProbeRow {
  now: Date | string
}

const attempts = envNumber('DB_WAIT_ATTEMPTS', 8)
const delayMs = envNumber('DB_WAIT_DELAY_MS', 2500)

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const result = await db.query<ProbeRow>('SELECT now() AS now')
    console.error(`[db] ready: ${String(result.rows[0]?.now ?? 'ok')}`)
    await db.close()
    process.exit(0)
  } catch (err) {
    await db.close()

    if (attempt === attempts) {
      console.error(`[db] not ready after ${attempts} attempts`)
      console.error(err)
      process.exit(1)
    }

    console.error(`[db] not ready, retrying (${attempt}/${attempts})`)
    await sleep(delayMs)
  }
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
