export type ServerClockAnchor = { serverAtReceipt: number; receivedAt: number }

// sentAt/receivedAt come from performance.now(), never the browser wall clock.
// The server samples serverNow immediately before returning its response.
export function anchorServerClock(serverNow: number, sentAt: number, receivedAt: number): ServerClockAnchor {
  if (![serverNow, sentAt, receivedAt].every(Number.isFinite) || receivedAt < sentAt) {
    throw new Error('Could not synchronize the game timer.')
  }
  return { serverAtReceipt: serverNow + (receivedAt - sentAt) / 2, receivedAt }
}

export function serverTimeAt(anchor: ServerClockAnchor, monotonicNow: number): number {
  return anchor.serverAtReceipt + Math.max(0, monotonicNow - anchor.receivedAt)
}
