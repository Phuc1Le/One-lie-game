import { afterEach, describe, expect, it, vi } from 'vitest'
import { anchorServerClock, serverTimeAt } from './server-clock'

afterEach(() => vi.restoreAllMocks())

describe('server-aligned monotonic clock', () => {
  it.each([-30_000, 0, 30_000])('ignores a browser wall-clock offset of %i milliseconds', (offset) => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000 + offset)
    const anchor = anchorServerClock(1_000_000, 100, 300)
    expect(serverTimeAt(anchor, 300)).toBe(1_000_100)
    expect(serverTimeAt(anchor, 1300)).toBe(1_001_100)
  })

  it('continues correctly after the wall clock jumps forward or backward', () => {
    const wallClock = vi.spyOn(Date, 'now')
    const anchor = anchorServerClock(1_000_000, 100, 100)
    wallClock.mockReturnValue(1_060_000)
    expect(serverTimeAt(anchor, 1100)).toBe(1_001_000)
    wallClock.mockReturnValue(940_000)
    expect(serverTimeAt(anchor, 2100)).toBe(1_002_000)
  })

  it('reanchors on a fresh server sample instead of restarting the deadline', () => {
    const deadline = 1_020_000
    const first = anchorServerClock(1_000_000, 100, 100)
    const refreshed = anchorServerClock(1_008_000, 10, 10)
    expect(deadline - serverTimeAt(first, 8100)).toBe(12_000)
    expect(deadline - serverTimeAt(refreshed, 10)).toBe(12_000)
  })

  it('rejects an invalid clock sample', () => {
    expect(() => anchorServerClock(Number.NaN, 0, 20)).toThrow()
    expect(() => anchorServerClock(1000, 20, 0)).toThrow()
  })
})
