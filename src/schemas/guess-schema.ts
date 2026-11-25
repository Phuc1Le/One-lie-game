import type { CollectionSchema } from 'deepspace/schema'

export const GUESS_ROUNDS = 'guess_rounds'
export const PRIVATE_GUESSES = 'private_guesses'
export type GuessRound = { code: string; round: number; endsAt: number; status: 'collecting' | 'judging' | 'missed' | 'finished'; revealEndsAt?: number; ready1: number; ready2: number; result?: 'winner' | 'tie' | 'no_winner' | 'judge_error'; winnerId?: string; word1?: string; word2?: string }
export type PrivateGuess = { code: string; round: number; playerId: string; guess: string; state: 'pending' | 'done' | 'error'; matches: number; judgeEndsAt: number }
const denied = { read: false, create: false, update: false, delete: false } as const
const shared = { ...denied, read: true } as const
const own = { ...denied, read: 'own' } as const
const text = (name: string): CollectionSchema['columns'][number] => ({ name, storage: 'text', interpretation: 'plain' })
const number = (name: string): CollectionSchema['columns'][number] => ({ name, storage: 'number', interpretation: 'plain' })
export const guessRoundsSchema: CollectionSchema = {
  name: GUESS_ROUNDS,
  columns: [text('code'), number('round'), number('endsAt'), text('status'), number('revealEndsAt'), number('ready1'), number('ready2'), text('result'), text('winnerId'), text('word1'), text('word2')],
  uniqueOn: ['code', 'round'], permissions: { '*': denied, viewer: denied, member: shared, admin: shared },
}
export const privateGuessesSchema: CollectionSchema = {
  name: PRIVATE_GUESSES,
  columns: [text('code'), number('round'), { ...text('playerId'), userBound: true, immutable: true },
    { ...text('guess'), immutable: true, maxLength: 80 }, text('state'), number('matches'), number('judgeEndsAt')],
  uniqueOn: ['code', 'round', 'playerId'], ownerField: 'playerId',
  permissions: { '*': denied, viewer: denied, member: own, admin: own },
}
