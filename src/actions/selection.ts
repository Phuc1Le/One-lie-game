import type { ActionHandler, ActionResult, ActionTools } from 'deepspace/worker'
import type { Env } from '../../worker'
import { CATEGORY_REVEAL_MS, WORD_SELECTION_MS, type DuelTiming } from '../game/timing'
import { LOBBY_SEATS, ROOM_CODE_PATTERN, type LobbySeat } from '../schemas/lobby-schema'
import { WORD_SELECTIONS, type WordSelection } from '../schemas/word-selection-schema'
import { CATEGORIES, matchWord } from '../game/categories'

export const SELECT_WORD_PATH = '/internal/one-lie/select-word'
export const START_GAME_PATH = '/internal/one-lie/start-game'
export const EXIT_ROOM_PATH = '/internal/one-lie/exit-room'
export const DUEL_TIMING_PATH = '/internal/one-lie/timing'
export type SelectionTools = Pick<ActionTools, 'query' | 'create' | 'update'>

// The public action receives identity from the existing JWT-verifying route.
// Forward to the RecordRoom so the entire save-and-ready operation is ordered
// there, rather than racing across independent Worker requests.
export function forwardGameAction(path: string): ActionHandler<Env> {
  return async ({ env, userId, params }) => {
    const room = env.RECORD_ROOMS.get(env.RECORD_ROOMS.idFromName(`app:${env.DEEPSPACE_APP_ID}`))
    const response = await room.fetch(new Request(`https://internal${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Action': 'true', 'X-User-Id': userId },
      body: JSON.stringify(params),
    }))
    return response.json() as Promise<ActionResult>
  }
}
export const selectWord = forwardGameAction(SELECT_WORD_PATH)
export const startGame = forwardGameAction(START_GAME_PATH)
export const exitRoom = forwardGameAction(EXIT_ROOM_PATH)
export const getDuelTiming = forwardGameAction(DUEL_TIMING_PATH)

export async function readDuelTiming(userId: string, params: Record<string, unknown>, tools: SelectionTools): Promise<ActionResult<DuelTiming>> {
  const code = typeof params.code === 'string' ? params.code.trim().toUpperCase() : ''
  if (!ROOM_CODE_PATTERN.test(code)) return { success: false, code: 'invalid_code', error: 'Enter a valid room code.' }
  const room = await tools.query<LobbySeat>(LOBBY_SEATS, { where: { code }, limit: 2 })
  if (!room.success) return { success: false, error: 'Could not read the game timer.' }
  if (!room.data.records.some((record) => record.data.playerId === userId)) return { success: false, code: 'not_seated', error: 'Only a seated player can read the game timer.' }
  const host = room.data.records.find((record) => record.data.seat === 1)?.data
  if (!host || host.status === 'closed') return { success: false, code: 'room_closed', error: 'This room has closed.' }
  if (!host.startedAt || !host.selectionEndsAt) return { success: false, code: 'not_started', error: 'The duel has not started.' }
  return { success: true, data: { serverNow: Date.now(), startedAt: host.startedAt, selectionEndsAt: host.selectionEndsAt } }
}

export async function beginDuel(userId: string, params: Record<string, unknown>, tools: SelectionTools): Promise<ActionResult<{ code: string; startedAt: number; selectionEndsAt: number }>> {
  const code = typeof params.code === 'string' ? params.code.trim().toUpperCase() : ''
  if (!ROOM_CODE_PATTERN.test(code)) return { success: false, error: 'Enter a valid room code.' }
  const room = await tools.query<LobbySeat>(LOBBY_SEATS, { where: { code }, limit: 2 })
  if (!room.success) return { success: false, error: 'Could not load the room.' }
  if (!room.data.records.some((record) => record.data.playerId === userId)) return { success: false, code: 'not_seated', error: 'Only a seated player can start.' }
  const host = room.data.records.find((record) => record.data.seat === 1)
  if (!host || host.data.status === 'closed') return { success: false, code: 'room_closed', error: 'This room has closed.' }
  if (host.data.playerId !== userId) return { success: false, code: 'host_only', error: 'Only the host can start the duel.' }
  if (room.data.records.length !== 2) return { success: false, code: 'waiting_for_player', error: 'Wait for your friend before starting.' }
  const startedAt = host.data.startedAt || Date.now()
  const selectionEndsAt = host.data.selectionEndsAt || startedAt + CATEGORY_REVEAL_MS + WORD_SELECTION_MS
  if (!host.data.startedAt) {
    const started = await tools.update<LobbySeat>(LOBBY_SEATS, host.recordId, { startedAt, selectionEndsAt })
    if (!started.success) return { success: false, error: 'Could not start the duel. Please try again.' }
  }
  return { success: true, data: { code, startedAt, selectionEndsAt } }
}

// Called only inside the RecordRoom's concurrency gate. It never accepts a
// target seat, record id, or owner id from params: the verified caller owns it.
export async function saveSelection(userId: string, params: Record<string, unknown>, tools: SelectionTools): Promise<ActionResult> {
  const code = typeof params.code === 'string' ? params.code.trim().toUpperCase() : ''
  if (!ROOM_CODE_PATTERN.test(code)) return { success: false, code: 'invalid_code', error: 'Enter a valid room code.' }
  const room = await tools.query<LobbySeat>(LOBBY_SEATS, { where: { code }, limit: 2 })
  if (!room.success) return { success: false, error: 'Could not load the room. Please try again.' }

  // OWNERSHIP CHECK: identify the caller's seat using verified identity.
  const ownSeat = room.data.records.find((record) => record.data.playerId === userId)
  if (!ownSeat) return { success: false, code: 'not_seated', error: 'Only a seated player can choose a word.' }
  const host = room.data.records.find((record) => record.data.seat === 1)
  if (!host || host.data.status === 'closed') return { success: false, code: 'room_closed', error: 'This room has closed.' }
  if (room.data.records.length !== 2) return { success: false, code: 'waiting_for_player', error: 'Wait for your friend to join before choosing a word.' }
  if (!host.data.startedAt || !host.data.selectionEndsAt) return { success: false, code: 'not_started', error: 'Start the duel before choosing a word.' }
  if (Date.now() < host.data.startedAt + CATEGORY_REVEAL_MS) return { success: false, code: 'category_spinning', error: 'Wait for the category to land.' }
  if (ownSeat.data.ready === 1) return { success: false, code: 'already_selected', error: 'Your word is already locked in.' }
  const expired = Date.now() >= host.data.selectionEndsAt
  let word = expired ? '' : typeof params.word === 'string' ? params.word.trim() : ''
  if (!expired && (!word || word.length > 40 || /[\u0000-\u001f]/.test(word))) return { success: false, code: 'invalid_word', error: 'Type a word of 1–40 characters.' }

  if (!expired && CATEGORIES.some((category) => category.id === host.data.categoryId)) {
    const match = matchWord(host.data.categoryId!, word)
    if (!match.canonical) return { success: false, code: 'invalid_category_word', error: match.suggestion ? `Did you mean ${match.suggestion}? Confirm that word before submitting.` : 'Choose a word from this category’s accepted vocabulary.' }
    word = match.canonical
  }
  return commitSelection(userId, code, ownSeat.recordId, word, tools)
}

async function commitSelection(userId: string, code: string, seatRecordId: string, word: string, tools: SelectionTools): Promise<ActionResult> {
  const previous = await tools.query<WordSelection>(WORD_SELECTIONS, { where: { code, playerId: userId }, limit: 1 })
  if (!previous.success) return { success: false, error: 'Could not confirm your selection.' }
  // Recover a failed Ready update without ever rewriting an existing word.
  if (!previous.data.records.length) {
    // The record key and owner are derived from the verified caller.
    const saved = await tools.create<WordSelection>(WORD_SELECTIONS, { code, playerId: userId, word }, `word:${code}:${userId}`)
    if (!saved.success) return { success: false, error: 'Could not save your word. Please try again.' }
  }
  // Public records contain readiness only, never the word or its list index.
  const ready = await tools.update<LobbySeat>(LOBBY_SEATS, seatRecordId, { ready: 1 })
  if (!ready.success) return { success: false, error: 'Your word was saved, but Ready could not be confirmed. Please save again.' }
  return { success: true, data: { ready: true } }
}

// The alarm uses stored player identities to finalize missing submissions,
// even with no browsers open. No caller supplies another player's owner id.
export async function expireSelections(code: string, toolsFor: (userId: string) => SelectionTools): Promise<void> {
  const room = await toolsFor('one-lie-timer').query<LobbySeat>(LOBBY_SEATS, { where: { code }, limit: 2 })
  if (!room.success) throw new Error('Could not load a timed-out duel.')
  const host = room.data.records.find((record) => record.data.seat === 1)
  if (!host || host.data.status === 'closed') return
  if (!host.data.selectionEndsAt || Date.now() < host.data.selectionEndsAt) return
  for (const seat of room.data.records) {
    if (seat.data.ready === 1) continue
    const result = await commitSelection(seat.data.playerId, code, seat.recordId, '', toolsFor(seat.data.playerId))
    if (!result.success) throw new Error('Could not finalize a timed-out selection.')
  }
}
