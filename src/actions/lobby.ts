import type { ActionContext, ActionHandler, ActionResult } from 'deepspace/worker'
import type { Env } from '../../worker'
import { LOBBY_SEATS, ROOM_CODE_PATTERN, type LobbySeat } from '../schemas/lobby-schema'
import { roomCategory } from '../game/categories'

type LobbyContext = ActionContext<Env>
type SeatResult = ActionResult<{ code: string; seat: number }>
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function generateCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => CODE_ALPHABET[byte % 32]).join('')
}

async function displayName({ tools, userId }: LobbyContext, seat: number): Promise<string> {
  // Read only the caller's profile, and copy only the public name, never email.
  const profile = await tools.get('users', userId)
  const name = profile.success ? profile.data.record.data.name : undefined
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 60) : `Player ${seat}`
}

export const createRoom: ActionHandler<Env> = async (ctx): Promise<SeatResult> => {
  const name = await displayName(ctx, 1)
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateCode()
    // Do not pass a recordId: SDK create with an existing id is an upsert.
    const created = await ctx.tools.create<LobbySeat>(LOBBY_SEATS, {
      code, seat: 1, playerId: ctx.userId, displayName: name,
      categoryId: roomCategory(code).id,
    })
    if (created.success) return { success: true, data: { code, seat: 1 } }
    if (!created.error.startsWith('Duplicate:')) {
      return { success: false, error: 'Could not create a room. Please try again.' }
    }
  }
  return { success: false, error: 'Could not find an unused room code. Please try again.' }
}

export const joinRoom: ActionHandler<Env> = async (ctx): Promise<SeatResult> => {
  const code = typeof ctx.params.code === 'string' ? ctx.params.code.trim().toUpperCase() : ''
  if (!ROOM_CODE_PATTERN.test(code)) {
    return { success: false, error: 'Enter a four-character room code (letters and numbers 2–9).', code: 'invalid_code' }
  }

  const room = await ctx.tools.query<LobbySeat>(LOBBY_SEATS, { where: { code }, limit: 2 })
  if (!room.success) return { success: false, error: 'Could not load the room. Please try again.' }
  if (!room.data.records.some((record) => record.data.seat === 1)) {
    return { success: false, error: 'Room not found. Check the code and try again.', code: 'room_not_found' }
  }
  if (room.data.records.some((record) => record.data.seat === 1 && record.data.status === 'closed')) {
    return { success: false, error: 'This room has closed. Create a new room to play again.', code: 'room_closed' }
  }
  // Joining again (including from another tab) restores the existing seat.
  const ownSeat = room.data.records.find((record) => record.data.playerId === ctx.userId)
  if (ownSeat) return { success: true, data: { code, seat: ownSeat.data.seat } }
  if (room.data.records.length === 2) return roomFull()

  const created = await ctx.tools.create<LobbySeat>(LOBBY_SEATS, {
    code, seat: 2, playerId: ctx.userId, displayName: await displayName(ctx, 2),
  })
  if (created.success) return { success: true, data: { code, seat: 2 } }
  if (!created.error.startsWith('Duplicate:')) {
    return { success: false, error: 'Could not join the room. Please try again.' }
  }

  // Another request won the seat between query and create. It may have been
  // this same player in a second tab, so distinguish a rejoin from a full room.
  const latest = await ctx.tools.query<LobbySeat>(LOBBY_SEATS, { where: { code }, limit: 2 })
  if (!latest.success) return { success: false, error: 'Could not confirm your seat. Please try again.' }
  const existing = latest.data.records.find((record) => record.data.playerId === ctx.userId)
  return existing ? { success: true, data: { code, seat: existing.data.seat } } : roomFull()
}

function roomFull(): SeatResult {
  return { success: false, error: 'Room full. Both seats are already taken.', code: 'room_full' }
}

export { exitRoom } from './selection'
