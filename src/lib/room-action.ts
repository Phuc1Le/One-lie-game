import { getAuthToken } from 'deepspace'

export async function requestRoomAction<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  return (await requestTimedRoomAction<T>(action, params)).data
}

export async function requestTimedRoomAction<T>(action: string, params: Record<string, unknown> = {}): Promise<{ data: T; sentAt: number; receivedAt: number }> {
  const token = await getAuthToken()
  if (!token) throw new Error('Please sign in again to continue.')
  // Token refresh may take time. Exclude it from the clock sample's RTT.
  const sentAt = performance.now()
  const response = await fetch(`/api/actions/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(params),
  })
  const result = await response.json() as { success?: boolean; data?: T; error?: string }
  const receivedAt = performance.now()
  if (!response.ok || !result.success || !result.data) {
    throw new Error(result.error ?? 'Could not connect to the room. Please try again.')
  }
  return { data: result.data, sentAt, receivedAt }
}
