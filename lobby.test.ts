import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActionContext, ActionTools } from 'deepspace/worker'
import type { Env } from './worker'
import { createRoom, joinRoom, exitRoom } from './src/actions/lobby'
import { lobbySeatsSchema, type LobbySeat } from './src/schemas/lobby-schema'

// Use a real SQLite UNIQUE index rather than a mock that always accepts writes.
// The Playwright tests exercise the same actions against the actual RecordRoom.
const databases: DatabaseSync[] = []
afterEach(() => { databases.splice(0).forEach((db) => db.close()); vi.restoreAllMocks() })

function store() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  db.exec("CREATE TABLE seats (recordId TEXT PRIMARY KEY, code TEXT, seat INTEGER, playerId TEXT, displayName TEXT, status TEXT DEFAULT 'open')")
  db.exec(`CREATE UNIQUE INDEX seat_unique ON seats (${lobbySeatsSchema.uniqueOn!.join(', ')})`)
  let id = 0
  const tools = {
    get: vi.fn(async (_collection: string, userId: string) => ({ success: true, data: { record: { data: { name: `Name ${userId}`, email: 'private@example.com' } } } })),
    query: vi.fn(async (_collection: string, options: { where: { code: string } }) => ({
      success: true,
      data: { records: db.prepare('SELECT * FROM seats WHERE code = ?').all(options.where.code).map(({ recordId, ...data }) => ({ recordId, data })) },
    })),
    create: vi.fn(async (_collection: string, data: LobbySeat) => {
      const recordId = String(++id)
      try {
        db.prepare('INSERT INTO seats (recordId, code, seat, playerId, displayName) VALUES (?, ?, ?, ?, ?)').run(recordId, data.code, data.seat, data.playerId, data.displayName)
        return { success: true, data: { recordId } }
      } catch {
        return { success: false, error: 'Duplicate: a record with code and seat already exists' }
      }
    }),
    update: vi.fn(async (_collection: string, recordId: string, data: Partial<LobbySeat>) => {
      db.prepare('UPDATE seats SET status = ? WHERE recordId = ?').run(data.status!, recordId)
      return { success: true, data: { recordId } }
    }),
  }
  const context = (userId: string, params: Record<string, unknown> = {}): ActionContext<Env> => ({
    userId, params, tools: tools as unknown as ActionTools, env: {} as Env, callerJwt: 'test-only',
  })
  return { db, tools, context }
}

async function create(database: ReturnType<typeof store>) {
  const result = await createRoom(database.context('alice'))
  expect(result.success).toBe(true)
  return (result.data as { code: string }).code
}

describe('lobby seat rules', () => {
  it.each(['alice', 'bob'])('closes the room when %s exits and refuses rejoining the old code', async (playerId) => {
    const s = store()
    const code = await create(s)
    await joinRoom(s.context('bob', { code }))
    expect(await exitRoom(s.context(playerId, { code }))).toEqual({ success: true, data: { code } })
    expect(s.db.prepare('SELECT status FROM seats WHERE code = ? AND seat = 1').get(code)).toEqual({ status: 'closed' })
    for (const id of ['alice', 'bob', 'charlie']) {
      expect(await joinRoom(s.context(id, { code }))).toMatchObject({ success: false, code: 'room_closed' })
    }
    expect((await createRoom(s.context(playerId))).success).toBe(true)
  })

  it('closes a room when its creator exits before a friend joins', async () => {
    const s = store()
    const code = await create(s)
    expect((await exitRoom(s.context('alice', { code }))).success).toBe(true)
    expect(await joinRoom(s.context('bob', { code }))).toMatchObject({ success: false, code: 'room_closed' })
  })

  it('creates a four-character code and uses verified identity, not submitted identity', async () => {
    const s = store()
    const result = await createRoom(s.context('alice', { playerId: 'mallory', seat: 2 }))
    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ code: expect.stringMatching(/^[A-HJ-NP-Z2-9]{4}$/), seat: 1 })
    expect(s.db.prepare('SELECT playerId, displayName FROM seats').get()).toEqual({ playerId: 'alice', displayName: 'Name alice' })
  })

  it('restores both existing seats, rejects a third player, and ignores forged seat parameters', async () => {
    const s = store()
    const code = await create(s)
    const second = await joinRoom(s.context('bob', { code: ` ${code.toLowerCase()} `, playerId: 'alice', seat: 1 }))
    expect(second).toEqual({ success: true, data: { code, seat: 2 } })
    expect(await joinRoom(s.context('alice', { code }))).toEqual({ success: true, data: { code, seat: 1 } })
    expect(await joinRoom(s.context('bob', { code }))).toEqual(second)
    expect(await joinRoom(s.context('charlie', { code }))).toMatchObject({ success: false, code: 'room_full' })
    expect(s.db.prepare('SELECT COUNT(*) AS count FROM seats').get()).toEqual({ count: 2 })
  })

  it('lets only one simultaneous caller claim the last seat', async () => {
    const s = store()
    const code = await create(s)
    const results = await Promise.all(['bob', 'charlie'].map((id) => joinRoom(s.context(id, { code }))))
    expect(results.filter((result) => result.success)).toHaveLength(1)
    expect(results.filter((result) => !result.success)).toEqual([expect.objectContaining({ code: 'room_full' })])
    expect(s.db.prepare('SELECT COUNT(*) AS count FROM seats').get()).toEqual({ count: 2 })
  })

  it('treats simultaneous joins by the same player as one seat', async () => {
    const s = store()
    const code = await create(s)
    const results = await Promise.all([joinRoom(s.context('bob', { code })), joinRoom(s.context('bob', { code }))])
    expect(results).toEqual(Array(2).fill({ success: true, data: { code, seat: 2 } }))
    expect(s.db.prepare('SELECT COUNT(*) AS count FROM seats').get()).toEqual({ count: 2 })
  })

  it('rejects invalid and missing room codes without creating a seat', async () => {
    const s = store()
    expect(await joinRoom(s.context('bob', { code: '!' }))).toMatchObject({ success: false, code: 'invalid_code' })
    expect(await joinRoom(s.context('bob', { code: 'ABCD' }))).toMatchObject({ success: false, code: 'room_not_found' })
    expect(s.tools.create).not.toHaveBeenCalled()
  })

  it('retries a generated code collision without replacing the original host', async () => {
    const s = store()
    vi.spyOn(crypto, 'getRandomValues')
      .mockReturnValueOnce(new Uint8Array([0, 0, 0, 0]))
      .mockReturnValueOnce(new Uint8Array([0, 0, 0, 0]))
      .mockReturnValueOnce(new Uint8Array([1, 1, 1, 1]))
    expect(await createRoom(s.context('alice'))).toMatchObject({ success: true, data: { code: 'AAAA' } })
    expect(await createRoom(s.context('bob'))).toMatchObject({ success: true, data: { code: 'BBBB' } })
    expect(s.db.prepare('SELECT playerId FROM seats WHERE code = ?').get('AAAA')).toEqual({ playerId: 'alice' })
  })
})
