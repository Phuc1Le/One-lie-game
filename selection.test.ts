import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LOBBY_SEATS } from './src/schemas/lobby-schema'
import { WORD_SELECTIONS } from './src/schemas/word-selection-schema'
import { SELECT_WORD_PATH, START_GAME_PATH, EXIT_ROOM_PATH, DUEL_TIMING_PATH } from './src/actions/selection'
import { CATEGORY_REVEAL_MS, WORD_SELECTION_MS } from './src/game/timing'
import { ANSWER_PATH, DECLARE_PATH, QUESTION_PATH, SYNC_QA_PATH, questionAction } from './src/actions/questions'
import { PRIVATE_ANSWERS, QUESTION_TURNS } from './src/schemas/question-schema'
import { GUESS_RESERVE_PATH, GUESS_FINISH_PATH, GUESS_SYNC_PATH, submitGuess } from './src/actions/guesses'
import { GUESS_ROUNDS, PRIVATE_GUESSES } from './src/schemas/guess-schema'
import { askAIQuestion, AI_RESERVE, AI_FINISH } from './src/actions/ai-questions'
import { QUESTION_REQUESTS } from './src/schemas/question-request-schema'

function aiContext(code: string, userId: string, params: Record<string, unknown>, integration: (endpoint: string, body: any) => Promise<any>) {
  return { userId, params: { code, turn: 1, ...params },
    env: { DEEPSPACE_APP_ID: 'test', RECORD_ROOMS: { idFromName: () => 'test', get: () => ({ fetch: async (request: Request) => runtime.dispatchFetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() }) }) } },
    tools: { integration },
  } as any
}
const modelReply = (decision: unknown) => ({ success: true, data: { choices: [{ message: { content: JSON.stringify(decision) } }] } })

describe('server AI questions', { timeout: 20_000 }, () => {
  it('reserves once, hides the secret and AI truth from asker, and gives a full answering window', async () => {
    const code = 'AIAA'
    // Codes cannot contain I.
    const roomCode = code.replaceAll('I', 'J')
    await readyQA(roomCode)
    const askerFrames = await subscribe('alice', roomCode, [QUESTION_TURNS, PRIVATE_ANSWERS, QUESTION_REQUESTS])
    let calls = 0
    const context = aiContext(roomCode, 'alice', { question: 'Does it use a ball?', truth: 'No' }, async (_endpoint, body) => {
      calls++
      expect(body.model).toBe('gpt-5.4-nano')
      expect(body.messages[1].content).toContain('tennis')
      return modelReply({ valid: true, reason: 'ok', truth: 'Yes' })
    })
    const results = await Promise.all([askAIQuestion(context), askAIQuestion(context)])
    expect(calls).toBe(1)
    expect(results.filter((r) => r.success)).toEqual([{ success: true, data: { accepted: true } }])
    expect(JSON.stringify(results)).not.toContain('tennis')
    expect(JSON.stringify(results)).not.toContain('truth')
    const own = await tool('bob', 'records.query', { collection: PRIVATE_ANSWERS, where: { code: roomCode } })
    expect(own.data.records[0].data).toMatchObject({ playerId: 'bob', truth: 'Yes' })
    expect((await tool('alice', 'records.query', { collection: PRIVATE_ANSWERS, where: { code: roomCode } })).data.records).toHaveLength(0)
    expect(askerFrames.filter((f) => f.type === 'core.record_change' && f.payload.collection === PRIVATE_ANSWERS)).toHaveLength(0)
    const turn = (await tool('alice', 'records.query', { collection: QUESTION_TURNS, where: { code: roomCode, turn: 1 } })).data.records[0].data
    expect(turn.phaseEndsAt - Date.now()).toBeGreaterThan(13_000)
    expect((await qa('bob', ANSWER_PATH, roomCode, 1, { answer: 'No' })).success).toBe(true)
    expect((await tool('bob', 'records.query', { collection: PRIVATE_ANSWERS, where: { code: roomCode } })).data.records[0].data.spentLie).toBe(1)
  })

  it('allows more than three checks while time remains and never accepts client truth', async () => {
    const code = 'AJAB'
    await readyQA(code)
    let calls = 0
    const context = aiContext(code, 'alice', { question: 'Is it tennis?', truth: 'Yes', decision: { valid: true, truth: 'Yes' } }, async () => {
      calls++
      return modelReply({ valid: false, reason: 'direct_guess', truth: 'Depends' })
    })
    for (let i = 0; i < 5; i++) expect(await askAIQuestion(context)).toMatchObject({ success: false, code: 'question_rejected' })
    expect(calls).toBe(5)
    expect((await tool('bob', 'records.query', { collection: PRIVATE_ANSWERS, where: { code } })).data.records).toHaveLength(0)
    const request = (await tool('alice', 'records.query', { collection: QUESTION_REQUESTS, where: { code } })).data.records[0].data
    expect(request.error).toContain('Do not ask')
    expect((await tool('bob', 'records.query', { collection: QUESTION_REQUESTS, where: { code } })).data.records).toHaveLength(0)
    expect(await askAIQuestion({ ...context, userId: 'charlie' })).toMatchObject({ success: false, code: 'not_seated' })
    expect(await askAIQuestion({ ...context, userId: 'bob' })).toMatchObject({ success: false, code: 'wrong_role' })
    expect(calls).toBe(5)
  })

  it('allows exit while checking and refuses late AI results', async () => {
    const code = 'AJAD'
    await readyQA(code)
    const reserved = await qa('alice', AI_RESERVE, code, 1, { question: 'Does it use a ball?' })
    expect(reserved.success).toBe(true)
    expect((await qa('bob', EXIT_ROOM_PATH, code, 1)).success).toBe(true)
    expect(await qa('alice', AI_FINISH, code, 1, { attempt: 1, decision: { valid: true, reason: 'ok', truth: 'Yes' } })).toMatchObject({ success: false, code: 'room_closed' })
  })

  it('skips a lost AI request on its server deadline and refuses the late truth', async () => {
    const code = 'AJAE'
    await readyQA(code)
    await qa('alice', AI_RESERVE, code, 1, { question: 'Does it use a ball?' })
    await tool('alice', 'records.update', { collection: QUESTION_TURNS, recordId: `question:${code}:1`, data: { phaseEndsAt: Date.now() + 150 } }, true)
    await qa('alice', SYNC_QA_PATH, code, 1)
    await expect.poll(async () => (await tool('alice', 'records.query', { collection: QUESTION_TURNS, where: { code, turn: 1 } })).data.records[0].data.status).toBe('skipped')
    expect(await qa('alice', AI_FINISH, code, 1, { attempt: 1, decision: { valid: true, reason: 'ok', truth: 'Yes' } })).toMatchObject({ success: false, code: 'stale_turn' })
    expect((await tool('bob', 'records.query', { collection: PRIVATE_ANSWERS, where: { code } })).data.records).toHaveLength(0)
  })

  it('recovers provider failure without extending asking time, then auto-sends AI Depends on answer timeout', async () => {
    const code = 'AJAF'
    await readyQA(code)
    const deadline = (await tool('alice', 'records.query', { collection: QUESTION_TURNS, where: { code, turn: 1 } })).data.records[0].data.phaseEndsAt
    const context = aiContext(code, 'alice', { question: 'Is it played indoors?' }, async () => { throw new Error('Provider unavailable') })
    expect(await askAIQuestion(context)).toMatchObject({ success: false, code: 'question_rejected' })
    expect((await tool('alice', 'records.query', { collection: QUESTION_TURNS, where: { code, turn: 1 } })).data.records[0].data.phaseEndsAt).toBe(deadline)
    context.tools.integration = async () => modelReply({ valid: true, reason: 'ok', truth: 'Depends' })
    expect((await askAIQuestion(context)).success).toBe(true)
    await tool('alice', 'records.update', { collection: QUESTION_TURNS, recordId: `question:${code}:1`, data: { phaseEndsAt: Date.now() + 150 } }, true)
    await qa('alice', SYNC_QA_PATH, code, 1)
    await expect.poll(async () => (await tool('alice', 'records.query', { collection: QUESTION_TURNS, where: { code, turn: 1 } })).data.records[0].data.answer).toBe('Depends')
    expect((await tool('bob', 'records.query', { collection: PRIVATE_ANSWERS, where: { code } })).data.records[0].data.spentLie).toBe(0)
  })
})

async function readyGuesses(code: string) {
  await readyQA(code)
  for (let turn = 1; turn <= 6; turn++) {
    const asker = turn % 2 ? 'alice' : 'bob'
    const answerer = turn % 2 ? 'bob' : 'alice'
    expect((await qa(asker, QUESTION_PATH, code, turn, { question: 'Is it a sport?' })).success).toBe(true)
    await qa(answerer, DECLARE_PATH, code, turn, { truth: 'Yes' })
    expect((await qa(answerer, ANSWER_PATH, code, turn, { answer: 'Yes' })).success).toBe(true)
  }
}
const guessRows = async (code: string) => (await tool('alice', 'records.query', { collection: GUESS_ROUNDS, where: { code }, orderBy: 'round', orderDir: 'asc' })).data.records as any[]
const guess = (user: string, code: string, round: number, word: string) => qa(user, GUESS_RESERVE_PATH, code, 0, { round, guess: word })

describe('private guessing and match results', { timeout: 20_000 }, () => {
  it('keeps semantic judge work off the public response and bills only one call for duplicate submissions', async () => {
    const code = 'BELL'
    await readyGuesses(code)
    let calls = 0
    const context = {
      userId: 'alice', params: { code, round: 1, guess: 'tenniss', matches: true },
      env: { DEEPSPACE_APP_ID: 'test', RECORD_ROOMS: { idFromName: () => 'test', get: () => ({ fetch: async (request: Request) => runtime.dispatchFetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() }) }) } },
      tools: { integration: async (_endpoint: string, body: any) => {
        calls++
        expect(body.model).toBe('gpt-5.4-nano')
        expect(body.max_tokens).toBe(160)
        return { success: true, data: { choices: [{ message: { content: '{"relation":"alias","canonical":"tennis"}' } }] } }
      } },
    } as any
    const results = await Promise.all([submitGuess(context), submitGuess(context)])
    expect(calls).toBe(1)
    expect(results.filter((r) => r.success)).toEqual([{ success: true, data: { saved: true } }])
    expect(JSON.stringify(results)).not.toContain('tennis')
    await guess('bob', code, 1, 'football')
    expect((await guessRows(code))[0].data.result).toBe('tie')
  })

  it('continues with an explicit judge error on a lost provider response and permits exit during guessing', async () => {
    const validCode = 'FAEL'
    await readyGuesses(validCode)
    await guess('alice', validCode, 1, 'tenniss')
    await guess('bob', validCode, 1, 'football')
    await tool('alice', 'records.update', { collection: PRIVATE_GUESSES, recordId: `guess:${validCode}:1:alice`, data: { judgeEndsAt: Date.now() + 150 } }, true)
    await qa('alice', GUESS_SYNC_PATH, validCode, 0)
    await expect.poll(async () => (await guessRows(validCode))[0].data.result).toBe('judge_error')
    expect((await guessRows(validCode))[0].data.status).toBe('missed')
    expect((await guessRows(validCode))[0].data.word1).toBeFalsy()
    await readyGuesses('EXGS')
    expect((await qa('bob', EXIT_ROOM_PATH, 'EXGS', 0)).success).toBe(true)
    expect(await guess('alice', 'EXGS', 1, 'tennis')).toMatchObject({ success: false, code: 'room_closed' })
    const deadlines = await (await runtime.dispatchFetch('http://test/__test/deadlines')).json() as any
    expect(deadlines.keys).not.toContain('guess:EXGS')
  })
  it('starts after six answers, survives sync, hides guesses, rejects outsiders and duplicates, and resolves a tie', async () => {
    const code = 'GUES'
    await readyGuesses(code)
    const first = (await guessRows(code))[0].data
    expect(first).toMatchObject({ round: 1, status: 'collecting', ready1: 0, ready2: 0 })
    expect(first.endsAt - Date.now()).toBeGreaterThan(28_000)
    await qa('alice', GUESS_SYNC_PATH, code, 0)
    expect((await guessRows(code))[0].data.endsAt).toBe(first.endsAt)
    expect(await guess('charlie', code, 1, 'tennis')).toMatchObject({ success: false, code: 'not_seated' })
    const attempts = await Promise.all([guess('alice', code, 1, 'tennis'), guess('alice', code, 1, 'tennis')])
    expect(attempts.filter((r) => r.success)).toHaveLength(1)
    expect(attempts.find((r) => r.success).data).toEqual({ needsJudge: false, round: 1 })
    expect((await guessRows(code))[0].data).toMatchObject({ ready1: 1, ready2: 0 })
    expect((await guessRows(code))[0].data.word2).toBeFalsy()
    expect((await tool('bob', 'records.query', { collection: PRIVATE_GUESSES, where: { code } })).data.records).toHaveLength(0)
    expect((await tool('alice', 'records.update', { collection: PRIVATE_GUESSES, recordId: `guess:${code}:1:alice`, data: { matches: 1 } })).success).toBe(false)
    await guess('bob', code, 1, 'football')
    expect((await guessRows(code))[0].data).toMatchObject({ status: 'finished', result: 'tie', word1: 'football', word2: 'tennis' })
    expect(await guess('bob', code, 1, 'football')).toMatchObject({ success: false, code: 'stale_round' })
  })

  it('repeats Q&A after missed guesses, preserves tokens and ends on a later correct guess', async () => {
    const code = 'MESS'
    await readyGuesses(code)
    await tool('bob', 'records.update', { collection: PRIVATE_ANSWERS, recordId: 'truth:MESS:1', data: { spentLie: 1 } }, true)
    const row = (await guessRows(code))[0]
    await tool('alice', 'records.update', { collection: GUESS_ROUNDS, recordId: row.recordId, data: { endsAt: Date.now() + 150 } }, true)
    await qa('alice', GUESS_SYNC_PATH, code, 0)
    await expect.poll(async () => (await guessRows(code))[0].data.status).toBe('missed')
    expect((await guessRows(code))[0].data.word1).toBeFalsy()
    const history = await tool('alice', 'records.query', { collection: QUESTION_TURNS, where: { code } })
    expect(history.data.records.find((r: any) => r.data.turn === 1).data.disclosedLie).toBe(1)
    await tool('alice', 'records.update', { collection: GUESS_ROUNDS, recordId: row.recordId, data: { revealEndsAt: Date.now() + 150 } }, true)
    await qa('alice', GUESS_SYNC_PATH, code, 0)
    await expect.poll(async () => (await tool('alice', 'records.query', { collection: QUESTION_TURNS, where: { code, turn: 7 } })).data.records.length).toBe(1)
    expect(await guess('alice', code, 1, 'tennis')).toMatchObject({ success: false, code: 'stale_round' })
    for (let turn = 7; turn <= 12; turn++) {
      const asker = turn % 2 ? 'alice' : 'bob'
      const answerer = turn % 2 ? 'bob' : 'alice'
      expect((await qa(asker, QUESTION_PATH, code, turn, { question: 'Another question?' })).success).toBe(true)
      await qa(answerer, DECLARE_PATH, code, turn, { truth: 'Yes' })
      if (answerer === 'bob') expect(await qa(answerer, ANSWER_PATH, code, turn, { answer: 'No' })).toMatchObject({ success: false, code: 'lie_used' })
      expect((await qa(answerer, ANSWER_PATH, code, turn, { answer: 'Yes' })).success).toBe(true)
    }
    expect((await guessRows(code))[1].data.status).toBe('collecting')
    await guess('alice', code, 2, 'tennis')
    await guess('bob', code, 2, 'football')
    expect((await guessRows(code))[1].data).toMatchObject({ status: 'finished', result: 'tie' })
  })

  it('reserves one semantic check, accepts only its private result, and declares a winner', async () => {
    const code = 'JUDG'
    await readyGuesses(code)
    const reserved = await guess('alice', code, 1, 'tenniss')
    expect(reserved.data).toMatchObject({ needsJudge: true, secret: 'tennis' })
    expect(await guess('alice', code, 1, 'tenniss')).toMatchObject({ success: false, code: 'already_guessed' })
    await guess('bob', code, 1, 'tennis') // Legacy free-text rooms also judge non-exact guesses.
    await qa('bob', GUESS_FINISH_PATH, code, 0, { round: 1, matches: false })
    expect((await guessRows(code))[0].data.status).toBe('judging')
    expect(await qa('charlie', GUESS_FINISH_PATH, code, 0, { round: 1, matches: true })).toMatchObject({ success: false, code: 'not_seated' })
    await qa('alice', GUESS_FINISH_PATH, code, 0, { round: 1, matches: true })
    expect((await guessRows(code))[0].data).toMatchObject({ result: 'winner', winnerId: 'alice' })
  })
})

// Exercise the actual SDK RecordRoom, SQLite, permission checks and WebSocket
// frames in local workerd. No platform account or external service is needed.
// miniflare/esbuild are already installed with this project's build tooling.
let runtime: Miniflare
const sockets: Array<{ close(): void }> = []

async function qa(userId: string, path: string, code: string, turn: number, data = {}) {
  const response = await runtime.dispatchFetch(`http://test${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Action': 'true', 'X-User-Id': userId },
    body: JSON.stringify({ code, turn, ...data }),
  })
  return response.json() as Promise<any>
}

async function readyQA(code: string) {
  await seed(code)
  expect((await select('alice', code, 'football')).success).toBe(true)
  expect((await select('bob', code, 'tennis')).success).toBe(true)
}

describe('manual questions and private Lie tokens', { timeout: 20_000 }, () => {
  it('uses backend alarms for question expiry, truthful answer fallback, and undeclared answer skips', async () => {
    const code = 'TACK'
    await readyQA(code)
    const records = async () => (await tool('alice', 'records.query', { collection: QUESTION_TURNS, where: { code } })).data.records as any[]
    const expireSoon = async (turn: number) => {
      const row = (await records()).find((r) => r.data.turn === turn)
      expect((await tool('alice', 'records.update', { collection: QUESTION_TURNS, recordId: row.recordId, data: { phaseEndsAt: Date.now() + 200 } }, true)).success).toBe(true)
      expect((await qa('alice', SYNC_QA_PATH, code, turn)).success).toBe(true)
    }
    const first = (await records())[0]
    expect(first.data.status).toBe('asking')
    expect(first.data.phaseEndsAt - Date.now()).toBeGreaterThan(28_000)
    await expireSoon(1)
    await expect.poll(async () => (await records()).find((r) => r.data.turn === 1)?.data.status).toBe('skipped')
    expect(await qa('alice', QUESTION_PATH, code, 1, { question: 'Too late?' })).toMatchObject({ success: false, code: 'stale_turn' })
    expect((await qa('bob', QUESTION_PATH, code, 2, { question: 'Does it use a ball?' })).success).toBe(true)
    const answering = (await records()).find((r) => r.data.turn === 2).data
    expect(answering.phaseEndsAt - Date.now()).toBeGreaterThan(13_000)
    expect(answering.phaseEndsAt - Date.now()).toBeLessThanOrEqual(15_000)
    await qa('alice', DECLARE_PATH, code, 2, { truth: 'Depends' })
    const beforeRefresh = (await records()).find((r) => r.data.turn === 2).data.phaseEndsAt
    await qa('alice', SYNC_QA_PATH, code, 2)
    expect((await records()).find((r) => r.data.turn === 2).data.phaseEndsAt).toBe(beforeRefresh)
    await expireSoon(2)
    await expect.poll(async () => (await records()).find((r) => r.data.turn === 2)?.data.answer).toBe('Depends')
    const privateRows = await tool('alice', 'records.query', { collection: PRIVATE_ANSWERS, where: { code } })
    expect(privateRows.data.records[0].data).toMatchObject({ truth: 'Depends', sentAnswer: 'Depends', spentLie: 0 })
    expect((await qa('alice', QUESTION_PATH, code, 3, { question: 'Undeclared answer?' })).success).toBe(true)
    await expireSoon(3)
    await expect.poll(async () => (await records()).find((r) => r.data.turn === 3)?.data.status).toBe('skipped')
    const fourth = (await records()).find((r) => r.data.turn === 4).data
    expect(fourth.status).toBe('asking')
    expect(fourth.phaseEndsAt - Date.now()).toBeGreaterThan(28_000)
  })

  it('recovers a failed public answer write without changing the reserved answer or spending twice', async () => {
    const code = 'RETR'
    await readyQA(code)
    await qa('alice', QUESTION_PATH, code, 1, { question: 'Does it use a ball?' })
    await qa('bob', DECLARE_PATH, code, 1, { truth: 'Yes' })
    // Inject a publication failure after a real private SQLite write. No other
    // calls run concurrently in this fixture; production uses the DO gate.
    const result = await questionAction(ANSWER_PATH, 'bob', { code, turn: 1, answer: 'No' }, {
      query: (collection, options) => tool('bob', 'records.query', { collection, ...options }, true),
      create: (collection, data, recordId) => tool('bob', 'records.create', { collection, data, recordId }, true),
      update: (collection, recordId, data) => collection === QUESTION_TURNS
        ? Promise.resolve({ success: false, error: 'Injected write failure' })
        : tool('bob', 'records.update', { collection, recordId, data }, true),
    })
    expect(result).toMatchObject({ success: false, code: 'save_failed' })
    expect(await qa('bob', ANSWER_PATH, code, 1, { answer: 'Yes' })).toMatchObject({ success: false, code: 'already_answered' })
    expect((await qa('bob', ANSWER_PATH, code, 1, { answer: 'No' })).success).toBe(true)
    const own = await tool('bob', 'records.query', { collection: PRIVATE_ANSWERS, where: { code } })
    expect(own.data.records).toHaveLength(1)
    expect(own.data.records[0].data).toMatchObject({ truth: 'Yes', sentAnswer: 'No', spentLie: 1 })
    expect((await qa('bob', QUESTION_PATH, code, 2, { question: 'Next turn?' })).success).toBe(true)
  })

  it('alternates six turns exactly once, supports Depends, and enforces one lie per player', async () => {
    const code = 'TURN'
    await readyQA(code)
    const ask = (id: string, turn: number) => qa(id, QUESTION_PATH, code, turn, { question: `Question ${turn}?` })
    const declare = (id: string, turn: number, truth: string) => qa(id, DECLARE_PATH, code, turn, { truth })
    const answer = (id: string, turn: number, sent: string) => qa(id, ANSWER_PATH, code, turn, { answer: sent })
    expect(await ask('bob', 1)).toMatchObject({ success: false, code: 'wrong_role' })
    const duplicateQuestions = await Promise.all([ask('alice', 1), ask('alice', 1)])
    expect(duplicateQuestions.filter((r) => r.success)).toHaveLength(1)
    expect(await answer('bob', 1, 'Yes')).toMatchObject({ success: false, code: 'declare_first' })
    expect((await declare('bob', 1, 'Yes')).success).toBe(true)
    expect(await declare('bob', 1, 'No')).toMatchObject({ success: false, code: 'already_declared' })
    const duplicateAnswers = await Promise.all([answer('bob', 1, 'No'), answer('bob', 1, 'No')])
    expect(duplicateAnswers.filter((r) => r.success)).toHaveLength(1)
    const undisclosed = await tool('alice', 'records.query', { collection: QUESTION_TURNS, where: { code } })
    expect(undisclosed.data.records.find((r: any) => r.data.turn === 1).data.disclosedLie).toBeUndefined()
    expect(await ask('alice', 1)).toMatchObject({ success: false, code: 'stale_turn' })
    // Truthful Depends preserves Alice's token.
    expect((await ask('bob', 2)).success).toBe(true)
    expect((await declare('alice', 2, 'Depends')).success).toBe(true)
    expect((await answer('alice', 2, 'Depends')).success).toBe(true)
    const disclosed = await tool('alice', 'records.query', { collection: QUESTION_TURNS, where: { code }, orderBy: 'turn', orderDir: 'asc' })
    expect(disclosed.data.records.slice(0, 2).every((r: any) => r.data.disclosedLie == null)).toBe(true)
    expect((await ask('alice', 3)).success).toBe(true)
    expect((await declare('bob', 3, 'No')).success).toBe(true)
    expect(await answer('bob', 3, 'Yes')).toMatchObject({ success: false, code: 'lie_used' })
    expect((await answer('bob', 3, 'No')).success).toBe(true)
    expect((await ask('bob', 4)).success).toBe(true)
    expect((await declare('alice', 4, 'No')).success).toBe(true)
    expect((await answer('alice', 4, 'Depends')).success).toBe(true)
    expect((await ask('alice', 5)).success).toBe(true)
    expect((await declare('bob', 5, 'Depends')).success).toBe(true)
    expect((await answer('bob', 5, 'Depends')).success).toBe(true)
    expect((await ask('bob', 6)).success).toBe(true)
    expect((await declare('alice', 6, 'Yes')).success).toBe(true)
    expect(await answer('alice', 6, 'No')).toMatchObject({ success: false, code: 'lie_used' })
    expect((await answer('alice', 6, 'Yes')).success).toBe(true)
    expect(await ask('alice', 7)).toMatchObject({ success: false, code: 'awaiting_guesses' })
    const history = await tool('alice', 'records.query', { collection: QUESTION_TURNS, where: { code }, orderBy: 'turn', orderDir: 'asc' })
    expect(history.data.records.map((r: any) => r.data.answer)).toEqual(['No', 'Depends', 'No', 'Depends', 'Depends', 'Yes'])
    expect(history.data.records.filter((r: any) => r.data.askerId === 'alice')).toHaveLength(3)
    for (const user of ['alice', 'bob']) {
      const own = await tool(user, 'records.query', { collection: PRIVATE_ANSWERS, where: { code } })
      expect(own.data.records).toHaveLength(3)
      expect(own.data.records.filter((r: any) => r.data.spentLie === 1)).toHaveLength(1)
    }
  })

  it('persists pending questions and declarations, filters private reads and WebSocket frames even for admin', async () => {
    const code = 'HUSH'
    await readyQA(code)
    const aliceFrames = await subscribe('alice', code, [QUESTION_TURNS, PRIVATE_ANSWERS])
    const bobFrames = await subscribe('bob', code, [QUESTION_TURNS, PRIVATE_ANSWERS])
    expect((await qa('alice', QUESTION_PATH, code, 1, { question: 'Is it a team sport?' })).success).toBe(true)
    expect((await qa('bob', DECLARE_PATH, code, 1, { truth: 'Depends' })).success).toBe(true)
    // Fresh reads simulate reconnect: public pending phase + own declaration.
    const pending = await tool('alice', 'records.query', { collection: QUESTION_TURNS, where: { code } })
    expect(pending.data.records[0].data).toMatchObject({ turn: 1, question: 'Is it a team sport?' })
    expect(pending.data.records[0].data.answer).toBeFalsy()
    const own = await tool('bob', 'records.query', { collection: PRIVATE_ANSWERS, where: { code } })
    expect(own.data.records[0].data.truth).toBe('Depends')
    expect((await tool('alice', 'records.query', { collection: PRIVATE_ANSWERS, where: { code } })).data.records).toEqual([])
    const guessed = await tool('alice', 'records.get', { collection: PRIVATE_ANSWERS, recordId: `truth:${code}:1` })
    expect(guessed.success).toBe(false)
    expect((await qa('bob', ANSWER_PATH, code, 1, { answer: 'Yes' })).success).toBe(true)
    await expect.poll(() => aliceFrames.some((f) => f.type === 'core.record_change' && f.payload.collection === QUESTION_TURNS && f.payload.record.data.answer === 'Yes')).toBe(true)
    expect(aliceFrames.filter((f) => f.type === 'core.record_change' && f.payload.collection === PRIVATE_ANSWERS)).toHaveLength(0)
    await expect.poll(() => bobFrames.some((f) => f.type === 'core.record_change' && f.payload.collection === PRIVATE_ANSWERS && f.payload.record.data.spentLie === 1)).toBe(true)
    expect((await qa('bob', QUESTION_PATH, code, 2, { question: 'Does it use a ball?' })).success).toBe(true)
    expect((await qa('alice', DECLARE_PATH, code, 2, { truth: 'No' })).success).toBe(true)
    const bobOwn = await tool('bob', 'records.query', { collection: PRIVATE_ANSWERS, where: { code } })
    expect(bobOwn.data.records.map((r: any) => r.data.playerId)).toEqual(['bob'])
    expect(bobFrames.filter((f) => f.type === 'core.record_change' && f.payload.collection === PRIVATE_ANSWERS).every((f) => f.payload.record.data.playerId === 'bob')).toBe(true)
  })

  it('rejects third players, role spoofing, direct writes, invalid input and actions after exit', async () => {
    const code = 'SAFE'
    await seed(code)
    expect(await qa('alice', QUESTION_PATH, code, 1, { question: 'Hi?' })).toMatchObject({ success: false, code: 'not_ready' })
    await select('alice', code, 'first')
    await select('bob', code, 'second')
    for (const path of [QUESTION_PATH, DECLARE_PATH, ANSWER_PATH]) {
      expect(await qa('charlie', path, code, 1, { question: 'Hi?', truth: 'Yes', answer: 'No', playerId: 'bob' })).toMatchObject({ success: false, code: 'not_seated' })
    }
    expect(await qa('alice', QUESTION_PATH, code, 1, { question: '  ' })).toMatchObject({ success: false, code: 'invalid_question' })
    expect((await qa('alice', QUESTION_PATH, code, 1, { question: 'A valid question?' })).success).toBe(true)
    expect(await qa('alice', DECLARE_PATH, code, 1, { truth: 'Yes', playerId: 'bob' })).toMatchObject({ success: false, code: 'wrong_role' })
    expect(await qa('bob', DECLARE_PATH, code, 1, { truth: 'Maybe' })).toMatchObject({ success: false, code: 'invalid_answer' })
    for (const user of ['alice', 'bob', 'charlie']) {
      for (const collection of [QUESTION_TURNS, PRIVATE_ANSWERS]) {
        expect((await tool(user, 'records.create', { collection, data: { code, turn: 1, playerId: user, truth: 'Yes', question: 'Forged', askerId: user, answererId: user } })).success).toBe(false)
        expect((await tool(user, 'records.update', { collection, recordId: `question:${code}:1`, data: { answer: 'Yes' } })).success).toBe(false)
      }
    }
    await runtime.dispatchFetch(`http://test${EXIT_ROOM_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Action': 'true', 'X-User-Id': 'bob' }, body: JSON.stringify({ code }) })
    expect(await qa('bob', DECLARE_PATH, code, 1, { truth: 'Yes' })).toMatchObject({ success: false, code: 'room_closed' })
  })
})

beforeAll(async () => {
  const bundled = await build({
    stdin: {
      resolveDir: process.cwd(), sourcefile: 'selection-test-worker.ts',
      contents: `
        import { GameRecordRoom } from './src/server/game-record-room';
        import { schemas } from './src/schemas';
        export class TestRoom extends GameRecordRoom {
          constructor(state, env) { super(state, env, schemas, { ownerUserId: 'alice' }); }
          async fetch(request) {
            if (new URL(request.url).pathname === '/__test/deadlines') {
              return Response.json({ keys: [...(await this.state.storage.list({ prefix: 'duel:' })).keys()] });
            }
            return super.fetch(request);
          }
        }
        export default { fetch(request, env) {
          return env.ROOMS.get(env.ROOMS.idFromName('selection-tests')).fetch(request);
        }};
      `,
    },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    external: ['cloudflare:workers', 'node:*'],
  })
  runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-11-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOMS: { className: 'TestRoom', useSQLite: true } },
  }))
  await runtime.ready
  for (const id of ['alice', 'bob', 'charlie']) {
    expect((await tool(id, 'users.register', { name: id }, true)).success).toBe(true)
  }
}, 30_000)

afterAll(async () => {
  sockets.forEach((socket) => socket.close())
  await runtime?.dispose()
})

async function tool(userId: string, name: string, params: Record<string, unknown>, privileged = false) {
  const response = await runtime.dispatchFetch('http://test/api/tools/execute', {
    method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-User-Id': userId,
      ...(privileged ? { 'X-App-Action': 'true' } : {}),
    }, body: JSON.stringify({ tool: name, params }),
  })
  return response.json() as Promise<any>
}

async function seed(code: string, count = 2, started = true) {
  for (const [index, playerId] of ['alice', 'bob'].slice(0, count).entries()) {
    const result = await tool(playerId, 'records.create', {
      collection: LOBBY_SEATS, recordId: `${code}:${playerId}`,
      data: { code, seat: index + 1, playerId, displayName: playerId, categoryId: 'sports',
        ...(index === 0 && started ? { startedAt: Date.now() - CATEGORY_REVEAL_MS - 100, selectionEndsAt: Date.now() + WORD_SELECTION_MS } : {}) },
    }, true)
    expect(result.success).toBe(true)
  }
}

async function start(userId: string, code: string) {
  const response = await runtime.dispatchFetch(`http://test${START_GAME_PATH}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Action': 'true', 'X-User-Id': userId }, body: JSON.stringify({ code }),
  })
  return response.json() as Promise<any>
}

async function select(userId: string, code: string, word: string, extra = {}) {
  const response = await runtime.dispatchFetch(`http://test${SELECT_WORD_PATH}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Action': 'true', 'X-User-Id': userId },
    body: JSON.stringify({ code, word, ...extra }),
  })
  return response.json() as Promise<any>
}

async function ownSelections(userId: string, code: string) {
  return tool(userId, 'records.query', { collection: WORD_SELECTIONS, where: { code } })
}

async function subscribe(userId: string, code: string, collections = [LOBBY_SEATS, WORD_SELECTIONS]) {
  const response = await runtime.dispatchFetch('http://test/ws/selection-tests', {
    // Match authenticatedRoomRequest's internal WebSocket identity encoding.
    headers: { Upgrade: 'websocket', 'X-User-Id': Buffer.from(userId).toString('base64url'), 'X-User-Name': Buffer.from(userId).toString('base64url') },
  })
  const ws = response.webSocket!
  expect(ws).toBeTruthy()
  const frames: any[] = []
  ws.addEventListener('message', (event) => frames.push(JSON.parse(String(event.data))))
  ws.accept()
  sockets.push(ws)
  for (const collection of collections) {
    ws.send(JSON.stringify({ type: 'core.subscribe', payload: {
      subscriptionId: collection, query: { collection, where: { code } },
    } }))
  }
  await expect.poll(() => frames.filter((frame) => frame.type === 'core.query_result').length).toBe(collections.length)
  return frames
}

describe('private selection in the actual DeepSpace RecordRoom', () => {
  it('enforces curated category membership on the server and stores canonical aliases', async () => {
    const code = 'PACK'
    await seed(code)
    expect((await tool('alice', 'records.update', { collection: LOBBY_SEATS, recordId: `${code}:alice`, data: { categoryId: 'planets' } }, true)).success).toBe(true)
    expect(await select('alice', code, 'Banana')).toMatchObject({ success: false, code: 'invalid_category_word' })
    expect(await select('alice', code, 'Jupitr')).toMatchObject({ success: false, code: 'invalid_category_word' })
    expect((await select('alice', code, 'the Red Planet')).success).toBe(true)
    expect((await ownSelections('alice', code)).data.records[0].data.word).toBe('Mars')
  })

  it('gives both seated players server timing without changing the stored deadline', async () => {
    const code = 'SYNC'
    await seed(code)
    const timing = async (userId: string) => {
      const response = await runtime.dispatchFetch(`http://test${DUEL_TIMING_PATH}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Action': 'true', 'X-User-Id': userId }, body: JSON.stringify({ code }),
      })
      return response.json() as Promise<any>
    }
    const before = Date.now()
    const a = await timing('alice')
    const b = await timing('bob')
    expect(a.success && b.success).toBe(true)
    expect(a.data.serverNow).toBeGreaterThanOrEqual(before)
    expect(b.data.serverNow).toBeLessThanOrEqual(Date.now())
    expect(a.data.selectionEndsAt).toBe(b.data.selectionEndsAt)
    expect(a.data.startedAt).toBe(b.data.startedAt)
    expect(Object.keys(a.data).sort()).toEqual(['selectionEndsAt', 'serverNow', 'startedAt'])
    expect(await timing('charlie')).toMatchObject({ success: false, code: 'not_seated' })
  })

  it('broadcasts readiness but never the opponent’s selection; even an admin has own-only reads', async () => {
    const code = 'TEST'
    await seed(code)
    const bobFrames = await subscribe('bob', code)
    const aliceFrames = await subscribe('alice', code)
    expect(await select('alice', code, 'football')).toEqual({ success: true, data: { ready: true } })
    await expect.poll(() => bobFrames.some((frame) => frame.type === 'core.record_change' && frame.payload.collection === LOBBY_SEATS && frame.payload.record.data.ready === 1)).toBe(true)
    expect(bobFrames.filter((frame) => frame.type === 'core.record_change' && frame.payload.collection === WORD_SELECTIONS)).toHaveLength(0)
    expect(JSON.stringify(bobFrames)).not.toContain('football')
    expect((await ownSelections('bob', code)).data.records).toEqual([])

    expect((await select('bob', code, 'tennis')).success).toBe(true)
    const alice = await ownSelections('alice', code)
    expect(alice.data.records.map((record: any) => record.data.word)).toEqual(['football'])
    expect((await ownSelections('bob', code)).data.records.map((record: any) => record.data.word)).toEqual(['tennis'])
    expect(JSON.stringify(aliceFrames)).not.toContain('tennis')
    expect((await tool('alice', 'records.get', { collection: WORD_SELECTIONS, recordId: `word:${code}:bob` })).success).toBe(false)
    expect((await ownSelections('', code)).data.records).toEqual([])
  })

  it('restores the first submitted word and rejects changing it, even before the opponent submits', async () => {
    const code = 'WARD'
    await seed(code)
    expect((await select('alice', code, ' football ')).success).toBe(true)
    expect(await select('alice', code, 'badminton')).toMatchObject({ success: false, code: 'already_selected' })
    const returningFrames = await subscribe('alice', code)
    const snapshot = returningFrames.find((frame) => frame.type === 'core.query_result' && frame.payload.subscriptionId === WORD_SELECTIONS)
    expect(snapshot.payload.records.map((record: any) => record.data.word)).toEqual(['football'])
    expect((await select('bob', code, 'cricket')).success).toBe(true)
    expect(await select('alice', code, 'swimming')).toMatchObject({ success: false, code: 'already_selected' })
    expect(await select('bob', code, 'tennis')).toMatchObject({ success: false, code: 'already_selected' })
    expect((await ownSelections('alice', code)).data.records[0].data.word).toBe('football')
  })

  it('orders simultaneous saves before locking both selections', async () => {
    const code = 'ABCD'
    await seed(code)
    const results = await Promise.all([select('alice', code, 'football'), select('bob', code, 'tennis')])
    expect(results.every((result) => result.success)).toBe(true)
    const edits = await Promise.all([select('alice', code, 'swimming'), select('bob', code, 'cricket')])
    expect(edits.every((result) => result.code === 'already_selected')).toBe(true)
  })

  it('trusts free text but rejects invalid length, unseated callers and direct record writes', async () => {
    const code = 'ABCE'
    await seed(code)
    expect(await select('charlie', code, 'football', { playerId: 'alice', seat: 1 })).toMatchObject({ success: false, code: 'not_seated' })
    expect(await select('alice', code, ' ')).toMatchObject({ success: false, code: 'invalid_word' })
    expect(await select('alice', code, 'x'.repeat(41))).toMatchObject({ success: false, code: 'invalid_word' })
    expect((await select('alice', code, 'my own free text', { playerId: 'bob', seat: 2, recordId: `word:${code}:bob` })).success).toBe(true)
    expect((await ownSelections('bob', code)).data.records).toEqual([])
    expect((await tool('alice', 'records.update', { collection: WORD_SELECTIONS, recordId: `word:${code}:alice`, data: { word: 'cricket' } })).success).toBe(false)
    expect((await tool('bob', 'records.create', { collection: WORD_SELECTIONS, data: { code, playerId: 'bob', word: 'cricket' } })).success).toBe(false)
    expect((await tool('alice', 'records.update', { collection: LOBBY_SEATS, recordId: `${code}:alice`, data: { ready: 1 } })).success).toBe(false)
  })

  it('requires two occupied seats and an open room', async () => {
    const code = 'ABCF'
    await seed(code, 1)
    expect(await select('alice', code, 'football')).toMatchObject({ success: false, code: 'waiting_for_player' })
    await seed('ABCG')
    await tool('alice', 'records.update', { collection: LOBBY_SEATS, recordId: 'ABCG:alice', data: { status: 'closed' } }, true)
    expect(await select('alice', 'ABCG', 'football')).toMatchObject({ success: false, code: 'room_closed' })
  })

  it('starts both players once, enforces the reveal, and never resets the deadline', async () => {
    const code = 'PLAY'
    await seed(code, 2, false)
    expect(await select('alice', code, 'football')).toMatchObject({ success: false, code: 'not_started' })
    expect(await start('charlie', code)).toMatchObject({ success: false, code: 'not_seated' })
    expect(await start('bob', code)).toMatchObject({ success: false, code: 'host_only' })
    const result = await start('alice', code)
    expect(result.success).toBe(true)
    expect(result.data.selectionEndsAt - result.data.startedAt).toBe(CATEGORY_REVEAL_MS + WORD_SELECTION_MS)
    expect(await start('alice', code)).toEqual(result)
    expect(await select('alice', code, 'football')).toMatchObject({ success: false, code: 'category_spinning' })
  })

  it('automatically submits an empty word at the backend deadline without a browser request', async () => {
    const code = 'LATE'
    await seed(code)
    await select('alice', code, 'keep my word')
    await tool('alice', 'records.update', { collection: LOBBY_SEATS, recordId: `${code}:alice`, data: { selectionEndsAt: Date.now() + 150 } }, true)
    await start('alice', code) // Re-arms the real alarm at the stored deadline.
    await expect.poll(async () => (await ownSelections('bob', code)).data.records.map((record: any) => record.data.word), { timeout: 5000 }).toEqual([''])
    expect((await ownSelections('alice', code)).data.records[0].data.word).toBe('keep my word')
    expect(await select('bob', code, 'too late')).toMatchObject({ success: false, code: 'already_selected' })
  })

  it('turns a late request into an empty submission instead of accepting the typed word', async () => {
    const code = 'SLAW'
    await seed(code)
    await tool('alice', 'records.update', { collection: LOBBY_SEATS, recordId: `${code}:alice`, data: { selectionEndsAt: Date.now() - 100 } }, true)
    expect((await select('bob', code, 'should not be saved')).success).toBe(true)
    expect((await ownSelections('bob', code)).data.records[0].data.word).toBe('')
  })

  it.each(['alice', 'bob'])('lets %s exit mid-duel and cancels that room’s pending alarm', async (userId) => {
    const code = userId === 'alice' ? 'EXAT' : 'EXBT'
    await seed(code)
    await start('alice', code)
    const before = await (await runtime.dispatchFetch('http://test/__test/deadlines')).json() as any
    expect(before.keys).toContain(`duel:${code}`)
    const response = await runtime.dispatchFetch(`http://test${EXIT_ROOM_PATH}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Action': 'true', 'X-User-Id': userId }, body: JSON.stringify({ code }),
    })
    expect(await response.json()).toEqual({ success: true, data: { code } })
    const after = await (await runtime.dispatchFetch('http://test/__test/deadlines')).json() as any
    expect(after.keys).not.toContain(`duel:${code}`)
    expect(await select('alice', code, 'too late')).toMatchObject({ success: false, code: 'room_closed' })
  })

  it('cancels the backend deadline once both players have submitted', async () => {
    const code = 'SEAL'
    await seed(code)
    await start('alice', code)
    await select('alice', code, 'first')
    const before = await (await runtime.dispatchFetch('http://test/__test/deadlines')).json() as any
    expect(before.keys).toContain(`duel:${code}`)
    await select('bob', code, 'second')
    const after = await (await runtime.dispatchFetch('http://test/__test/deadlines')).json() as any
    expect(after.keys).not.toContain(`duel:${code}`)
  })
})
