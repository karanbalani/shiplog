export interface IsoWindow {
  from: string
  to: string
}

export function yesterdayUTC(now: Date = new Date()): string {
  const d = new Date(now)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

export function yearRange(startYear: number, endYear: number): number[] {
  const years: number[] = []
  for (let year = startYear; year <= endYear; year += 1) {
    years.push(year)
  }
  return years
}

export function yearWindow(year: number): IsoWindow {
  return {
    from: `${year}-01-01T00:00:00Z`,
    to: `${year + 1}-01-01T00:00:00Z`
  }
}

export function dayWindow(yyyymmdd: string): IsoWindow {
  const [year, month, day] = parseDateOnly(yyyymmdd)
  const from = new Date(Date.UTC(year, month - 1, day)).toISOString()
  const to = new Date(Date.UTC(year, month - 1, day + 1)).toISOString()

  return {
    from: stripMilliseconds(from),
    to: stripMilliseconds(to)
  }
}

export function contributionDayWindow(yyyymmdd: string): IsoWindow {
  const [year, month, day] = parseDateOnly(yyyymmdd)
  const from = new Date(Date.UTC(year, month - 1, day)).toISOString()
  const to = new Date(Date.UTC(year, month - 1, day, 23, 59, 59)).toISOString()

  return {
    from: stripMilliseconds(from),
    to: stripMilliseconds(to)
  }
}

function parseDateOnly(yyyymmdd: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyymmdd)
  if (!match) {
    throw new Error(`expected YYYY-MM-DD date, received "${yyyymmdd}"`)
  }

  const [, year, month, day] = match
  return [Number(year), Number(month), Number(day)]
}

function stripMilliseconds(iso: string): string {
  return iso.replace('.000Z', 'Z')
}
