import { useEffect, useRef, useState } from 'react'
import { anchorServerClock, serverTimeAt, type ServerClockAnchor } from '../game/server-clock'
import type { DuelTiming } from '../game/timing'
import { requestTimedRoomAction } from './room-action'

export function useServerClock(code: string, enabled: boolean) {
  const anchor = useRef<ServerClockAnchor | null>(null)
  const [now, setNow] = useState<number | null>(null)
  const [initialNow, setInitialNow] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let inFlight = false
    const tick = () => {
      if (anchor.current && !disposed) setNow(serverTimeAt(anchor.current, performance.now()))
    }
    const synchronize = async () => {
      if (inFlight || disposed) return
      inFlight = true
      try {
        const sample = await requestTimedRoomAction<DuelTiming>('getDuelTiming', { code })
        if (disposed) return
        anchor.current = anchorServerClock(sample.data.serverNow, sample.sentAt, sample.receivedAt)
        const alignedNow = serverTimeAt(anchor.current, performance.now())
        setNow(alignedNow)
        setInitialNow((first) => first ?? alignedNow)
        setError('')
      } catch {
        if (!disposed) setError('Could not synchronize the timer. Please retry.')
      } finally {
        inFlight = false
      }
    }
    const resume = () => {
      if (document.visibilityState !== 'visible') return
      tick()
      void synchronize()
    }
    void synchronize()
    const ticks = window.setInterval(tick, 100)
    const resync = window.setInterval(() => void synchronize(), 10_000)
    window.addEventListener('focus', resume)
    window.addEventListener('pageshow', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      disposed = true
      window.clearInterval(ticks)
      window.clearInterval(resync)
      window.removeEventListener('focus', resume)
      window.removeEventListener('pageshow', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [code, enabled, attempt])

  return { now, initialNow, error, retry: () => setAttempt((value) => value + 1) }
}
