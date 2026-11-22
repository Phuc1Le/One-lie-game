import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import { createRoom, joinRoom, exitRoom } from './lobby'
import { getDuelTiming, selectWord, startGame } from './selection'

export const actions: Record<string, ActionHandler<Env>> = { createRoom, joinRoom, exitRoom, selectWord, startGame, getDuelTiming }
