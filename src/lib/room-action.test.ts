import { afterEach, expect, it, vi } from 'vitest'
import { getAuthToken } from 'deepspace'
import { requestTimedRoomAction } from './room-action'

vi.mock('deepspace', () => ({ getAuthToken: vi.fn() }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('excludes token-refresh latency from the timer synchronization round trip', async () => {
  let monotonic = 0
  vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
  vi.mocked(getAuthToken).mockImplementation(async () => {
    monotonic += 5000
    return 'unit-test-token'
  })
  vi.stubGlobal('fetch', vi.fn(async () => {
    monotonic += 80
    return { ok: true, json: async () => {
      monotonic += 20
      return { success: true, data: { serverNow: 1_000_000 } }
    } }
  }))
  const sample = await requestTimedRoomAction('getDuelTiming', { code: 'TEST' })
  expect(sample.sentAt).toBe(5000)
  expect(sample.receivedAt - sample.sentAt).toBe(100)
})
