import type { ActionResult } from 'deepspace/worker'
import { forwardGameAction, type SelectionTools } from './selection'
import { LOBBY_SEATS, ROOM_CODE_PATTERN, type LobbySeat } from '../schemas/lobby-schema'
import { ANSWERS, PRIVATE_ANSWERS, QUESTION_TURNS, turnComplete, type Answer, type PrivateAnswer, type QuestionTurn } from '../schemas/question-schema'
import { ANSWER_MS, QUESTION_MS } from '../game/timing'

export const QUESTION_PATH = '/internal/one-lie/question'
export const DECLARE_PATH = '/internal/one-lie/declare'
export const ANSWER_PATH = '/internal/one-lie/answer'
export const SYNC_QA_PATH = '/internal/one-lie/sync-questions'
export const askQuestion = forwardGameAction(QUESTION_PATH)
export const declareTruth = forwardGameAction(DECLARE_PATH)
export const submitAnswer = forwardGameAction(ANSWER_PATH)
export const syncQuestions = forwardGameAction(SYNC_QA_PATH)

const refused = (code: string, error: string): ActionResult => ({ success: false, code, error })
const isAnswer = (value: unknown): value is Answer => ANSWERS.includes(value as Answer)

// A saved empty question opens the asking clock. Completion and expiry are
// server decisions; clients never supply a deadline. Also restores older games.
export async function advanceQuestions(code: string, toolsFor: (userId: string) => SelectionTools, now = Date.now()): Promise<number | null> {
  const tools = toolsFor('one-lie-timer')
  const room = await tools.query<LobbySeat>(LOBBY_SEATS, { where: { code }, limit: 2 })
  if (!room.success) throw new Error('Could not load question timer room.')
  const seats = room.data.records.map((r) => r.data).sort((a, b) => a.seat - b.seat)
  if (seats.length !== 2 || seats[0].status === 'closed' || !seats[0].startedAt || !seats.every((s) => s.ready === 1)) return null
  const history = await tools.query<QuestionTurn>(QUESTION_TURNS, { where: { code }, orderBy: 'turn', orderDir: 'asc', limit: 6 })
  if (!history.success) throw new Error('Could not load question timer state.')
  const turn = history.data.records.filter((r) => turnComplete(r.data)).length + 1
  if (turn > 6) return null
  const current = history.data.records.find((r) => r.data.turn === turn)
  if (!current) {
    const deadline = now + QUESTION_MS
    const created = await tools.create<QuestionTurn>(QUESTION_TURNS, { code, turn, askerId: seats[(turn - 1) % 2].playerId, answererId: seats[turn % 2].playerId, question: '', status: 'asking', phaseEndsAt: deadline }, `question:${code}:${turn}`)
    if (!created.success) throw new Error('Could not start question timer.')
    return deadline
  }
  if (!current.data.phaseEndsAt) {
    const deadline = now + (current.data.question ? ANSWER_MS : QUESTION_MS)
    const restored = await tools.update<QuestionTurn>(QUESTION_TURNS, current.recordId, { phaseEndsAt: deadline, status: current.data.question ? 'answering' : 'asking' })
    if (!restored.success) throw new Error('Could not restore question timer.')
    return deadline
  }
  if (current.data.phaseEndsAt > now) return current.data.phaseEndsAt
  if (current.data.question) {
    // No guessed truth: only an existing private declaration may be sent.
    const ownTools = toolsFor(current.data.answererId)
    const rows = await ownTools.query<PrivateAnswer>(PRIVATE_ANSWERS, { where: { code, playerId: current.data.answererId }, limit: 3 })
    if (!rows.success) throw new Error('Could not load timeout declaration.')
    const declaration = rows.data.records.find((r) => r.data.turn === turn)
    if (declaration) {
      // Recover a previously reserved answer if its public write failed.
      const answer = declaration.data.sentAnswer || declaration.data.truth
      if (!declaration.data.sentAnswer) {
        const saved = await ownTools.update<PrivateAnswer>(PRIVATE_ANSWERS, declaration.recordId, { sentAnswer: answer, spentLie: 0 })
        if (!saved.success) throw new Error('Could not save timed-out answer.')
      }
      const published = await tools.update<QuestionTurn>(QUESTION_TURNS, current.recordId, { answer, status: 'answered' })
      if (!published.success) throw new Error('Could not publish timed-out answer.')
    } else {
      const skipped = await tools.update<QuestionTurn>(QUESTION_TURNS, current.recordId, { status: 'skipped' })
      if (!skipped.success) throw new Error('Could not skip timed-out answer.')
    }
  } else {
    const skipped = await tools.update<QuestionTurn>(QUESTION_TURNS, current.recordId, { status: 'skipped' })
    if (!skipped.success) throw new Error('Could not skip timed-out question.')
  }
  // Start the next turn from actual server time, giving it its full allowance
  // even if Cloudflare delivered the alarm late.
  return advanceQuestions(code, toolsFor, now)
}

// Called ONLY inside GameRecordRoom's concurrency gate. All identities and
// record IDs are derived here; client-supplied player/seat IDs are never used.
export async function questionAction(path: string, userId: string, params: Record<string, unknown>, tools: SelectionTools): Promise<ActionResult> {
  const code = typeof params.code === 'string' ? params.code.trim().toUpperCase() : ''
  if (!ROOM_CODE_PATTERN.test(code)) return refused('invalid_code', 'Enter a valid room code.')
  const room = await tools.query<LobbySeat>(LOBBY_SEATS, { where: { code }, limit: 2 })
  if (!room.success) return refused('read_failed', 'Could not load the room.')
  const seats = room.data.records.map((r) => r.data).sort((a, b) => a.seat - b.seat)
  // OWNERSHIP: verified JWT identity must own a seat, then the active role.
  if (!seats.some((s) => s.playerId === userId)) return refused('not_seated', 'Only seated players can play.')
  if (seats[0]?.status === 'closed') return refused('room_closed', 'This room has closed.')
  if (seats.length !== 2 || !seats[0].startedAt || !seats.every((s) => s.ready === 1)) return refused('not_ready', 'Both words must be locked in first.')
  const queried = await tools.query<QuestionTurn>(QUESTION_TURNS, { where: { code }, orderBy: 'turn', orderDir: 'asc', limit: 6 })
  if (!queried.success) return refused('read_failed', 'Could not load the conversation.')
  const turns = queried.data.records
  const turn = turns.filter((r) => turnComplete(r.data)).length + 1
  if (path === SYNC_QA_PATH) return { success: true, data: { synced: true } }
  if (turn > 6) return refused('awaiting_guesses', 'Awaiting guesses.')
  if (params.turn !== turn) return refused('stale_turn', 'This turn has already moved on. Your screen will update.')
  const askerId = seats[(turn - 1) % 2].playerId
  const answererId = seats[turn % 2].playerId
  const current = turns.find((r) => r.data.turn === turn)
  if (current?.data.phaseEndsAt && current.data.phaseEndsAt <= Date.now()) return refused('time_up', 'Time is up. The next turn will appear.')
  if (path === QUESTION_PATH) {
    if (userId !== askerId) return refused('wrong_role', 'It is your opponent’s turn to ask.')
    if (current?.data.question) return refused('already_asked', 'The question is already submitted.')
    const question = typeof params.question === 'string' ? params.question.trim() : ''
    if (!question || question.length > 500 || /[\u0000-\u001f]/.test(question)) return refused('invalid_question', 'Enter a question of 1–500 characters.')
    const data = { question, status: 'answering' as const, phaseEndsAt: Date.now() + ANSWER_MS }
    const saved = current ? await tools.update<QuestionTurn>(QUESTION_TURNS, current.recordId, data)
      : await tools.create<QuestionTurn>(QUESTION_TURNS, { code, turn, askerId, answererId, ...data }, `question:${code}:${turn}`)
    return saved.success ? { success: true, data: { turn } } : refused('save_failed', 'Could not save the question. Please retry.')
  }
  if (userId !== answererId) return refused('wrong_role', 'Only the answering player can answer.')
  if (!current?.data.question) return refused('no_question', 'Wait for a question first.')
  const privateRows = await tools.query<PrivateAnswer>(PRIVATE_ANSWERS, { where: { code, playerId: userId }, limit: 3 })
  if (!privateRows.success) return refused('read_failed', 'Could not load your private answer state.')
  const declaration = privateRows.data.records.find((r) => r.data.turn === turn)
  if (path === DECLARE_PATH) {
    if (!isAnswer(params.truth)) return refused('invalid_answer', 'Choose Yes, Depends, or No.')
    if (declaration) return refused('already_declared', 'Your truthful declaration is already saved.')
    const saved = await tools.create<PrivateAnswer>(PRIVATE_ANSWERS, { code, turn, playerId: userId, truth: params.truth }, `truth:${code}:${turn}`)
    return saved.success ? { success: true, data: { declared: true } } : refused('save_failed', 'Could not save your declaration. Please retry.')
  }
  if (!declaration) return refused('declare_first', 'Declare the truthful answer first.')
  if (!isAnswer(params.answer)) return refused('invalid_answer', 'Choose Yes, Depends, or No.')
  // Save the private decision before publishing. If publication fails, retries
  // may publish ONLY that same decision; they cannot reset or spend twice.
  if (declaration.data.sentAnswer && declaration.data.sentAnswer !== params.answer) return refused('already_answered', 'Your submitted answer cannot change.')
  const spentLie = params.answer !== declaration.data.truth ? 1 : 0
  if (spentLie && privateRows.data.records.some((r) => r.data.turn !== turn && r.data.spentLie === 1)) return refused('lie_used', 'Your Lie token has already been used. Send your declared truth.')
  if (!declaration.data.sentAnswer) {
    const reserved = await tools.update<PrivateAnswer>(PRIVATE_ANSWERS, declaration.recordId, { sentAnswer: params.answer, spentLie })
    if (!reserved.success) return refused('save_failed', 'Could not save your answer. Please retry.')
  }
  // This one public write completes the question AND advances the derived turn.
  // No separate turn counter can be incremented twice or become out of sync.
  const published = await tools.update<QuestionTurn>(QUESTION_TURNS, current.recordId, { answer: params.answer, status: 'answered' })
  return published.success ? { success: true, data: { answered: true } } : refused('save_failed', 'Could not publish your answer. Please retry the same answer.')
}
