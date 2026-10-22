import { describe, expect, it } from 'vitest'
import { formatCount, formatDuration } from './format'

describe('formatDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(252_000)).toBe('4m 12s')
    expect(formatDuration(65_000)).toBe('1m 05s')
    expect(formatDuration(3_780_000)).toBe('1h 03m')
    expect(formatDuration(36_000_000)).toBe('10h 00m')
  })

  it('clamps negative values to zero', () => {
    expect(formatDuration(-5000)).toBe('0s')
  })

  it('drops seconds in compact mode', () => {
    expect(formatDuration(45_000, { compact: true })).toBe('45s')
    expect(formatDuration(724_000, { compact: true })).toBe('12m')
    expect(formatDuration(3_780_000, { compact: true })).toBe('1h 03m')
  })
})

describe('formatCount', () => {
  it('groups thousands', () => {
    expect(formatCount(182431)).toBe('182,431')
  })
})
