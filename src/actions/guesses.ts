import type { ActionHandler, ActionResult } from 'deepspace/worker'
import type { Env } from '../../worker'
import { forwardGameAction, type SelectionTools } from './selection'
import { LOBBY_SEATS, ROOM_CODE_PATTERN, type LobbySeat } from '../schemas/lobby-schema'
import { PRIVATE_ANSWERS, QUESTION_TURNS, turnComplete, type PrivateAnswer, type QuestionTurn } from '../schemas/question-schema'
import { GUESS_ROUNDS, PRIVATE_GUESSES, type GuessRound, type PrivateGuess } from '../schemas/guess-schema'
import { WORD_SELECTIONS, type WordSelection } from '../schemas/word-selection-schema'
import { matchWord, normalizeWord, roomCategory } from '../game/categories'
import { judgeGuess } from '../ai/game-judge'

export const GUESS_MS = 30_000
export const GUESS_SYNC_PATH = '/internal/one-lie/guess-sync'
export const GUESS_RESERVE_PATH = '/internal/one-lie/guess-reserve'
export const GUESS_FINISH_PATH = '/internal/one-lie/guess-finish'
export const syncGuesses = forwardGameAction(GUESS_SYNC_PATH)
type JudgeWork = { needsJudge: boolean; round: number; guess?: string; secret?: string; category?: string }
const fail = (code: string, error: string): ActionResult => ({ success: false, code, error })

// AI runs OUTSIDE the DO concurrency gate, so slow providers cannot block exit
// or the other player. Reserve is private server-to-server data; never return
// its secret to the browser. The public action only returns saved:true.
export const submitGuess: ActionHandler<Env> = async (context) => {
  const reserved = await forwardGameAction(GUESS_RESERVE_PATH)(context) as ActionResult<JudgeWork>
  if (!reserved.success) return reserved
  if (reserved.data.needsJudge) {
    let matches: boolean | null = null
    try {
      const result = await judgeGuess(context.tools, { category: reserved.data.category!, secret: reserved.data.secret!, guess: reserved.data.guess! })
      matches = result.matches
    } catch { /* Explicit judge-error ending, never count an outage as wrong. */ }
    const finished = await forwardGameAction(GUESS_FINISH_PATH)({ ...context, params: { code: context.params.code, round: reserved.data.round, matches } })
    if (!finished.success) return finished
  }
  return { success: true, data: { saved: true } }
}

async function read<T extends Record<string, unknown>>(tools: SelectionTools, collection: string, code: string, limit: number) {
  const result = await tools.query<T>(collection, { where: { code }, orderBy: collection === GUESS_ROUNDS || collection === PRIVATE_GUESSES ? 'round' : collection === QUESTION_TURNS || collection === PRIVATE_ANSWERS ? 'turn' : 'code', orderDir: 'desc', limit })
  if (!result.success) throw new Error('Could not load game state.')
  return result.data.records
}
async function must(result: Promise<ActionResult<unknown>>) {
  if (!(await result).success) throw new Error('Could not save game state. Please retry.')
}

// Called under the same concurrency gate as answers, submissions and alarms.
export async function advanceGuesses(code: string, toolsFor: (userId: string) => SelectionTools, now = Date.now()): Promise<number | null> {
  const tools = toolsFor('one-lie-timer')
  const seats = (await read<LobbySeat>(tools, LOBBY_SEATS, code, 2)).map((r) => r.data).sort((a, b) => a.seat - b.seat)
  if (seats.length !== 2 || seats[0].status === 'closed') return null
  const turns = await read<QuestionTurn>(tools, QUESTION_TURNS, code, 6)
  const truths = await read<PrivateAnswer>(tools, PRIVATE_ANSWERS, code, 6)
  const rounds = await read<GuessRound>(tools, GUESS_ROUNDS, code, 1)
  if (rounds.some((r) => r.data.status === 'finished')) return null
  const latest = rounds[0]
  if (latest?.data.status === 'missed' && (latest.data.revealEndsAt ?? 0) > now) return latest.data.revealEndsAt!
  const roundNumber = latest ? latest.data.round + (latest.data.status === 'missed' ? 1 : 0) : 1
  if (turns.filter((r) => r.data.turn > (roundNumber - 1) * 6 && turnComplete(r.data)).length !== 6) return null
  const round = latest?.data.round === roundNumber ? latest : undefined
  if (!round) {
    const created = await tools.create<GuessRound>(GUESS_ROUNDS, { code, round: roundNumber, endsAt: now + GUESS_MS, status: 'collecting', ready1: 0, ready2: 0 }, `guesses:${code}:${roundNumber}`)
    if (!created.success) throw new Error('Could not start guessing.')
    return now + GUESS_MS
  }
  const guesses = (await read<PrivateGuess>(tools, PRIVATE_GUESSES, code, 6)).filter((r) => r.data.round === roundNumber)
  if (now >= round.data.endsAt) {
    for (const seat of seats) if (!guesses.some((r) => r.data.playerId === seat.playerId)) {
      const created = await toolsFor(seat.playerId).create<PrivateGuess>(PRIVATE_GUESSES, { code, round: roundNumber, playerId: seat.playerId, guess: '', matches: 0, state: 'done', judgeEndsAt: 0 }, `guess:${code}:${roundNumber}:${seat.playerId}`)
      if (!created.success) throw new Error('Could not save missed guess.')
      return advanceGuesses(code, toolsFor, now)
    }
  }
  for (const row of guesses) if (row.data.state === 'pending' && row.data.judgeEndsAt <= now) {
    await must(tools.update(PRIVATE_GUESSES, row.recordId, { state: 'error' }))
    return advanceGuesses(code, toolsFor, now)
  }
  const ready1 = guesses.some((r) => r.data.playerId === seats[0].playerId) ? 1 : 0
  const ready2 = guesses.some((r) => r.data.playerId === seats[1].playerId) ? 1 : 0
  const pending = guesses.filter((r) => r.data.state === 'pending')
  const status = ready1 && ready2 ? 'judging' : 'collecting'
  if (round.data.ready1 !== ready1 || round.data.ready2 !== ready2 || round.data.status !== status) await must(tools.update(GUESS_ROUNDS, round.recordId, { ready1, ready2, status }))
  if (ready1 && ready2 && !pending.length) {
    const winners = guesses.filter((r) => r.data.matches === 1)
    const judgeError = guesses.some((r) => r.data.state === 'error')
    if (!judgeError && winners.length) {
      const words = await read<WordSelection>(tools, WORD_SELECTIONS, code, 2)
      await must(tools.update(GUESS_ROUNDS, round.recordId, { status: 'finished', result: judgeError ? 'judge_error' : winners.length === 2 ? 'tie' : winners.length === 1 ? 'winner' : 'no_winner',
        winnerId: !judgeError && winners.length === 1 ? winners[0].data.playerId : '',
        word1: words.find((r) => r.data.playerId === seats[0].playerId)?.data.word ?? '', word2: words.find((r) => r.data.playerId === seats[1].playerId)?.data.word ?? '' }))
      return null
    }
    if (!judgeError) await discloseLieUsage(seats, turns, truths, tools)
    const revealEndsAt = now + 6500
    await must(tools.update(GUESS_ROUNDS, round.recordId, { status: 'missed', result: judgeError ? 'judge_error' : 'no_winner', revealEndsAt }))
    return revealEndsAt
  }
  return Math.min(...[...(ready1 && ready2 ? [] : [round.data.endsAt]), ...pending.map((r) => r.data.judgeEndsAt)])
}

async function discloseLieUsage(seats: LobbySeat[], turns: Awaited<ReturnType<typeof read<QuestionTurn>>>, truths: Awaited<ReturnType<typeof read<PrivateAnswer>>>, tools: SelectionTools) {
  for (const seat of seats) {
    const answerTurns = turns.filter((row) => row.data.answererId === seat.playerId)
    const spent = answerTurns.some((row) => truths.some((truth) => truth.data.turn === row.data.turn && truth.data.spentLie === 1)) ? 1 : 0
    for (const row of answerTurns) if (row.data.disclosedLie == null) await must(tools.update(QUESTION_TURNS, row.recordId, { disclosedLie: spent }))
  }
}

export async function guessAction(path: string, userId: string, params: Record<string, unknown>, tools: SelectionTools): Promise<ActionResult> {
  const code = typeof params.code === 'string' ? params.code.trim().toUpperCase() : ''
  if (!ROOM_CODE_PATTERN.test(code)) return fail('invalid_code', 'Enter a valid room code.')
  const seats = await read<LobbySeat>(tools, LOBBY_SEATS, code, 2)
  if (!seats.some((r) => r.data.playerId === userId)) return fail('not_seated', 'Only seated players can guess.')
  const host = seats.find((r) => r.data.seat === 1)?.data
  if (!host || host.status === 'closed') return fail('room_closed', 'This room has closed.')
  if (path === GUESS_SYNC_PATH) return { success: true, data: { synced: true } }
  const rounds = await read<GuessRound>(tools, GUESS_ROUNDS, code, 1)
  const round = rounds.find((r) => r.data.round === params.round)
  if (!round || rounds.some((r) => r.data.status === 'finished') || round.data.status === 'missed') return fail('stale_round', 'This guessing round has ended.')
  const own = (await read<PrivateGuess>(tools, PRIVATE_GUESSES, code, 6)).find((r) => r.data.round === params.round && r.data.playerId === userId)
  if (path === GUESS_FINISH_PATH) {
    if (!own || own.data.state !== 'pending') return fail('already_judged', 'Your guess has already been processed.')
    if (params.matches !== null && typeof params.matches !== 'boolean') return fail('invalid_result', 'Invalid judge response.')
    await must(tools.update(PRIVATE_GUESSES, own.recordId, { state: params.matches === null ? 'error' : 'done', matches: params.matches === true ? 1 : 0 }))
    return { success: true, data: { saved: true } }
  }
  if (own) return fail('already_guessed', 'Your guess is already locked in.')
  if (Date.now() >= round.data.endsAt) return fail('time_up', 'Time is up for this guess.')
  const guess = typeof params.guess === 'string' ? params.guess.trim() : ''
  if (!guess || guess.length > 80 || /[\u0000-\u001f]/.test(guess)) return fail('invalid_guess', 'Enter a guess of 1–80 characters.')
  const opponent = seats.find((r) => r.data.playerId !== userId)!.data
  const words = await read<WordSelection>(tools, WORD_SELECTIONS, code, 2)
  const secret = words.find((r) => r.data.playerId === opponent.playerId)?.data.word
  if (secret === undefined) return fail('missing_word', 'Could not find the opponent’s word.')
  const category = roomCategory(code, host.categoryId)
  const matched = matchWord(category.id, guess)
  const canonical = matched.canonical
  const exact = !!secret && normalizeWord(canonical ?? guess) === normalizeWord(secret)
  // A spelling suggestion is not a winning guess. Reject obvious alternatives
  // before AI; the model can only recognize an unlisted, exact-identity alias.
  const alternatives = /[,;/|\n]|\b(?:or|and)\b/i.test(guess)
  const needsJudge = !!secret && !exact && !canonical && !matched.suggestion && !alternatives
  await must(tools.create<PrivateGuess>(PRIVATE_GUESSES, { code, round: round.data.round, playerId: userId, guess, matches: exact ? 1 : 0, state: needsJudge ? 'pending' : 'done', judgeEndsAt: needsJudge ? Date.now() + 20_000 : 0 }, `guess:${code}:${round.data.round}:${userId}`))
  return { success: true, data: { needsJudge, round: round.data.round, ...(needsJudge ? { guess, secret, category: category.label } : {}) } }
}
