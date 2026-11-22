import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LOBBY_SEATS } from './src/schemas/lobby-schema'
import { WORD_SELECTIONS } from './src/schemas/word-selection-schema'
import { SELECT_WORD_PATH, START_GAME_PATH, EXIT_ROOM_PATH, DUEL_TIMING_PATH } from './src/actions/selection'
import { CATEGORY_REVEAL_MS, WORD_SELECTION_MS } from './src/game/timing'

// Exercise the actual SDK RecordRoom, SQLite, permission checks and WebSocket
// frames in local workerd. No platform account or external service is needed.
// miniflare/esbuild are already installed with this project's build tooling.
let runtime: Miniflare
const sockets: Array<{ close(): void }> = []

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

async function subscribe(userId: string, code: string) {
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
  for (const collection of [LOBBY_SEATS, WORD_SELECTIONS]) {
    ws.send(JSON.stringify({ type: 'core.subscribe', payload: {
      subscriptionId: collection, query: { collection, where: { code } },
    } }))
  }
  await expect.poll(() => frames.filter((frame) => frame.type === 'core.query_result').length).toBe(2)
  return frames
}

describe('private selection in the actual DeepSpace RecordRoom', () => {
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
