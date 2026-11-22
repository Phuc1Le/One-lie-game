import { RecordRoom } from 'deepspace/worker'
import type { ActionResult } from 'deepspace/worker'
import type { Env } from '../../worker'
import { beginDuel, expireSelections, readDuelTiming, saveSelection, DUEL_TIMING_PATH, EXIT_ROOM_PATH, SELECT_WORD_PATH, START_GAME_PATH, type SelectionTools } from '../actions/selection'
import { closeRoom } from '../actions/close-room'
import { LOBBY_SEATS, type LobbySeat } from '../schemas/lobby-schema'

// Keep the SDK's records, SQLite persistence and permission-filtered broadcasts.
// The only addition is ordering the multi-record save + Ready operation.
export class GameRecordRoom extends RecordRoom<Env> {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (![SELECT_WORD_PATH, START_GAME_PATH, EXIT_ROOM_PATH, DUEL_TIMING_PATH].includes(path)) return super.fetch(request)
    const userId = request.headers.get('X-User-Id')
    // This endpoint is reached by a server-side DO stub, not a public route.
    if (request.method !== 'POST' || request.headers.get('X-App-Action') !== 'true' || !userId) {
      return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }
    const params = await request.json<Record<string, unknown>>()
    return this.state.blockConcurrencyWhile(async () => {
      const tools = this.toolsFor(userId)
      if (path === DUEL_TIMING_PATH) return Response.json(await readDuelTiming(userId, params, tools))
      if (path === EXIT_ROOM_PATH) {
        const result = await closeRoom(userId, params, tools)
        if (result.success) await this.clearDeadline(result.data.code)
        return Response.json(result)
      }
      if (path === START_GAME_PATH) {
        const result = await beginDuel(userId, params, tools)
        if (result.success) {
          await this.state.storage.put(`duel:${result.data.code}`, result.data.selectionEndsAt)
          await this.scheduleNextDeadline()
        }
        return Response.json(result)
      }
      const result = await saveSelection(userId, params, tools)
      if (result.success) {
        const code = String(params.code).trim().toUpperCase()
        const room = await tools.query<LobbySeat>(LOBBY_SEATS, { where: { code }, limit: 2 })
        if (room.success && room.data.records.length === 2 && room.data.records.every((record) => record.data.ready === 1)) {
          await this.clearDeadline(code)
        }
      }
      return Response.json(result)
    })
  }

  protected async onAlarm(): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      const deadlines = await this.state.storage.list<number>({ prefix: 'duel:' })
      for (const [key, deadline] of deadlines) {
        if (deadline > Date.now()) continue
        await expireSelections(key.slice('duel:'.length), (userId) => this.toolsFor(userId))
        await this.state.storage.delete(key)
      }
      await this.scheduleNextDeadline()
    })
  }

  private async scheduleNextDeadline() {
    const deadlines = await this.state.storage.list<number>({ prefix: 'duel:' })
    if (deadlines.size) await this.state.storage.setAlarm(Math.min(...deadlines.values()))
    else await this.state.storage.deleteAlarm()
  }

  private async clearDeadline(code: string) {
    await this.state.storage.delete(`duel:${code}`)
    await this.scheduleNextDeadline()
  }

  private toolsFor(userId: string): SelectionTools {
    const execute = async <T>(tool: string, params: Record<string, unknown>): Promise<ActionResult<T>> => {
      const response = await super.fetch(new Request('https://internal/api/tools/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': userId, 'X-App-Action': 'true' },
        body: JSON.stringify({ tool, params }),
      }))
      return response.json() as Promise<ActionResult<T>>
    }
    return {
      query: (collection, options) => execute('records.query', { collection, ...options }),
      create: (collection, data, recordId) => execute('records.create', { collection, data, recordId }),
      update: (collection, recordId, data) => execute('records.update', { collection, recordId, data }),
    }
  }
}
