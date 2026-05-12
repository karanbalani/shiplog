import { expect, test } from 'bun:test'
import * as dates from '../../../lib/utils/dates.ts'

test('yesterdayUTC returns yesterday in YYYY-MM-DD form', () => {
  const fixed = new Date('2026-05-07T03:14:00Z')
  expect(dates.yesterdayUTC(fixed)).toBe('2026-05-06')
})

test('yesterdayUTC handles month boundary', () => {
  const fixed = new Date('2026-06-01T00:30:00Z')
  expect(dates.yesterdayUTC(fixed)).toBe('2026-05-31')
})

test('yearRange returns inclusive list of years', () => {
  expect(dates.yearRange(2017, 2020)).toEqual([2017, 2018, 2019, 2020])
})

test('yearRange returns single year when start equals end', () => {
  expect(dates.yearRange(2026, 2026)).toEqual([2026])
})

test('yearWindow returns ISO bounds for a given year', () => {
  expect(dates.yearWindow(2024)).toEqual({
    from: '2024-01-01T00:00:00Z',
    to: '2025-01-01T00:00:00Z'
  })
})

test('dayWindow returns ISO bounds for a YYYY-MM-DD date', () => {
  expect(dates.dayWindow('2024-03-14')).toEqual({
    from: '2024-03-14T00:00:00Z',
    to: '2024-03-15T00:00:00Z'
  })
})

test('contributionDayWindow returns inclusive same-day ISO bounds', () => {
  expect(dates.contributionDayWindow('2024-03-14')).toEqual({
    from: '2024-03-14T00:00:00Z',
    to: '2024-03-14T23:59:59Z'
  })
})
