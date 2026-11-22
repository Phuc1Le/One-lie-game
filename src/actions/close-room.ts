import type { ActionResult, ActionTools } from 'deepspace/worker'
import { LOBBY_SEATS, ROOM_CODE_PATTERN, type LobbySeat } from '../schemas/lobby-schema'

export async function closeRoom(userId: string, params: Record<string, unknown>, tools: Pick<ActionTools, 'query' | 'update'>): Promise<ActionResult<{ code: string }>> {
  const code = typeof params.code === 'string' ? params.code.trim().toUpperCase() : ''
  if (!ROOM_CODE_PATTERN.test(code)) return { success: false, error: 'Enter a valid room code.', code: 'invalid_code' }
  const room = await tools.query<LobbySeat>(LOBBY_SEATS, { where: { code }, limit: 2 })
  if (!room.success) return { success: false, error: 'Could not load the room. Please try again.' }
  if (!room.data.records.some((record) => record.data.playerId === userId)) {
    return { success: false, error: 'You do not have a seat in this room.' }
  }
  const host = room.data.records.find((record) => record.data.seat === 1)
  if (!host) return { success: false, error: 'Room not found.', code: 'room_not_found' }
  // Either seated player can close the room at any phase of the duel.
  const closed = await tools.update<LobbySeat>(LOBBY_SEATS, host.recordId, { status: 'closed' })
  if (!closed.success) return { success: false, error: 'Could not exit the room. Please try again.' }
  return { success: true, data: { code } }
}
