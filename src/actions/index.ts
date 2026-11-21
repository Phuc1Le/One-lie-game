import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import { createRoom, joinRoom, exitRoom } from './lobby'

export const actions: Record<string, ActionHandler<Env>> = { createRoom, joinRoom, exitRoom }
