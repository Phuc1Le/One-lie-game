import type { ActionHandler, ActionResult } from 'deepspace/worker'
import type { Env } from '../../worker'
import { forwardGameAction, type SelectionTools } from './selection'
import { questionCycle, questionAction, QUESTION_PATH } from './questions'
import { judgeQuestion } from '../ai/game-judge'
import { LOBBY_SEATS, ROOM_CODE_PATTERN, type LobbySeat } from '../schemas/lobby-schema'
import { QUESTION_TURNS, PRIVATE_ANSWERS, ANSWERS, type QuestionTurn, type PrivateAnswer } from '../schemas/question-schema'
import { QUESTION_REQUESTS, type QuestionRequest } from '../schemas/question-request-schema'
import { WORD_SELECTIONS, type WordSelection } from '../schemas/word-selection-schema'
import { roomCategory } from '../game/categories'

export const AI_RESERVE = '/internal/one-lie/ai-question-reserve'
export const AI_FINISH = '/internal/one-lie/ai-question-finish'
export const AI_PATHS = [AI_RESERVE, AI_FINISH]
type Work = { category: string; secret: string; question: string; attempt: number }
const fail = (code: string, error: string): ActionResult => ({ success: false, code, error })

export const askAIQuestion: ActionHandler<Env> = async (context) => {
  const reserved = await forwardGameAction(AI_RESERVE)(context) as ActionResult<Work>
  if (!reserved.success) return reserved
  // Provider calls happen outside the DO gate. Never return reserved work:
  // validation work contains the opponent's secret.
  let decision: unknown = null
  try { decision = await judgeQuestion(context.tools, { category: reserved.data.category, secret: reserved.data.secret, question: reserved.data.question }) }
  catch { /* The persisted error below is safe to show to the asker. */ }
  return forwardGameAction(AI_FINISH)({ ...context, params: { code: context.params.code, turn: context.params.turn, attempt: reserved.data.attempt, decision } })
}

// Called only by the internal DO endpoint under its concurrency gate.
export async function aiQuestionAction(path: string, userId: string, params: Record<string, unknown>, tools: SelectionTools, toolsFor: (id: string) => SelectionTools): Promise<ActionResult> {
  const code = typeof params.code === 'string' ? params.code.trim().toUpperCase() : ''
  if (!ROOM_CODE_PATTERN.test(code) || !Number.isInteger(params.turn)) return fail('invalid_turn', 'Invalid room or turn.')
  const room = await tools.query<LobbySeat>(LOBBY_SEATS, { where: { code }, limit: 2 })
  if (!room.success) return fail('read_failed', 'Could not load room.')
  const seats = room.data.records.map((r) => r.data).sort((a, b) => a.seat - b.seat)
  if (!seats.some((s) => s.playerId === userId)) return fail('not_seated', 'Only seated players can play.')
  if (seats[0]?.status === 'closed') return fail('room_closed', 'This room has closed.')
  if (seats.length !== 2 || !seats.every((s) => s.ready === 1)) return fail('not_ready', 'Both words must be locked in.')
  const cycle = await questionCycle(code, tools)
  const queried = await tools.query<QuestionTurn>(QUESTION_TURNS, { where: { code, turn: params.turn }, limit: 1 })
  if (!queried.success) return fail('read_failed', 'Could not load turn.')
  const current = queried.data.records[0]
  if (cycle.blocked || !current || current.data.turn <= cycle.offset || current.data.answer || current.data.status === 'skipped' || current.data.question) return fail('stale_turn', 'This turn has moved on.')
  if (current.data.askerId !== userId) return fail('wrong_role', 'Only the asker can request AI help.')
  if ((current.data.phaseEndsAt ?? 0) <= Date.now()) return fail('time_up', 'Time is up for this turn.')
  const rows = await tools.query<QuestionRequest>(QUESTION_REQUESTS, { where: { code, turn: params.turn }, limit: 1 })
  if (!rows.success) return fail('read_failed', 'Could not load AI request.')
  const recordId = `question-request:${code}:${params.turn}`
  let request = rows.data.records[0]?.data
  if (!request) {
    request = { code, turn: current.data.turn, playerId: userId, attempts: 0, state: 'idle', question: '', askEndsAt: current.data.phaseEndsAt!, error: '' }
    if (!(await tools.create(QUESTION_REQUESTS, request, recordId)).success) return fail('save_failed', 'Could not reserve AI request.')
  }
  const save = async (data: Partial<QuestionRequest>) => {
    if (!(await tools.update(QUESTION_REQUESTS, recordId, data)).success) throw new Error('Could not save AI request.')
  }
  if (path === AI_FINISH) {
    if (request.state !== 'pending' || params.attempt !== request.attempts) return fail('already_processed', 'Question already processed.')
    const decision = params.decision as { valid?: unknown; truth?: unknown; reason?: unknown } | null
    if (!decision || decision.valid !== true || decision.reason !== 'ok' || !ANSWERS.includes(decision.truth as never)) {
      const error = !decision ? 'The judge is unavailable. Try again while time remains.' : decision.reason === 'direct_guess' ? 'Do not ask the secret word directly. Ask about a property.' : decision.reason === 'gibberish' ? 'Please write a meaningful question.' : 'Ask one clear Yes / Depends / No question.'
      await save({ state: 'rejected', error })
      await tools.update(QUESTION_TURNS, current.recordId, { status: 'asking', phaseEndsAt: request.askEndsAt })
      return fail('question_rejected', error)
    }
    // Stamp ownership as the ANSWERER, not the asker who triggered the AI.
    const answerTools = toolsFor(current.data.answererId)
    const existing = await answerTools.query<PrivateAnswer>(PRIVATE_ANSWERS, { where: { code, turn: params.turn }, limit: 1 })
    if (!existing.success) return fail('read_failed', 'Could not save private truth.')
    if (!existing.data.records.length && !(await answerTools.create(PRIVATE_ANSWERS, { code, turn: current.data.turn, playerId: current.data.answererId, truth: decision.truth }, `truth:${code}:${params.turn}`)).success) return fail('save_failed', 'Could not save private truth.')
    const published = await questionAction(QUESTION_PATH, userId, { code, turn: params.turn, question: request.question }, tools)
    if (!published.success) return published
    await save({ state: 'accepted', error: '' })
    return { success: true, data: { accepted: true } }
  }
  if (request.state === 'pending') return fail('checking', 'Your question is being checked.')
  const category = roomCategory(code, seats[0].categoryId).label
  const question = typeof params.question === 'string' ? params.question.trim() : ''
  if (!question || question.length > 500 || /[\u0000-\u001f]/.test(question)) return fail('invalid_question', 'Enter a question of 1–500 characters.')
  const words = await tools.query<WordSelection>(WORD_SELECTIONS, { where: { code, playerId: current.data.answererId }, limit: 1 })
  if (!words.success || !words.data.records.length) return fail('missing_word', 'Could not load the secret word.')
  await save({ attempts: request.attempts + 1, state: 'pending', question, error: '' })
  if (!(await tools.update(QUESTION_TURNS, current.recordId, { status: 'checking', phaseEndsAt: Date.now() + 20_000 })).success) return fail('save_failed', 'Could not start the question check.')
  return { success: true, data: { category, secret: words.data.records[0].data.word, question, attempt: request.attempts + 1 } }
}
