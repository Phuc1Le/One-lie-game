import type { CollectionSchema } from 'deepspace/schema'

export const QUESTION_TURNS = 'question_turns'
export const PRIVATE_ANSWERS = 'private_answers'
export const ANSWERS = ['Yes', 'Depends', 'No'] as const
export type Answer = typeof ANSWERS[number]
export type QuestionTurn = { code: string; turn: number; askerId: string; answererId: string; question: string; answer?: Answer; status?: 'asking' | 'checking' | 'answering' | 'answered' | 'skipped'; phaseEndsAt?: number; disclosedLie?: number }
export const turnComplete = (turn: QuestionTurn) => !!turn.answer || turn.status === 'skipped'
export type PrivateAnswer = { code: string; turn: number; playerId: string; truth: Answer; sentAnswer?: Answer; spentLie?: number }

const denied = { read: false, create: false, update: false, delete: false } as const
const shared = { ...denied, read: true } as const
const own = { ...denied, read: 'own' } as const
const keyColumns = [
  { name: 'code', storage: 'text', interpretation: 'plain', required: true, immutable: true, maxLength: 4 },
  { name: 'turn', storage: 'number', interpretation: 'plain', required: true, immutable: true },
] satisfies CollectionSchema['columns']

export const questionTurnsSchema: CollectionSchema = {
  name: QUESTION_TURNS,
  columns: [...keyColumns,
    { name: 'askerId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'answererId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'question', storage: 'text', interpretation: 'plain', maxLength: 500 },
    { name: 'answer', storage: 'text', interpretation: 'plain' },
    { name: 'status', storage: 'text', interpretation: 'plain' },
    { name: 'phaseEndsAt', storage: 'number', interpretation: 'plain' },
    { name: 'disclosedLie', storage: 'number', interpretation: 'plain' },
  ],
  uniqueOn: ['code', 'turn'],
  permissions: { '*': denied, viewer: denied, member: shared, admin: shared },
}

export const privateAnswersSchema: CollectionSchema = {
  name: PRIVATE_ANSWERS,
  columns: [...keyColumns,
    { name: 'playerId', storage: 'text', interpretation: 'plain', required: true, immutable: true, userBound: true },
    { name: 'truth', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'sentAnswer', storage: 'text', interpretation: 'plain' },
    { name: 'spentLie', storage: 'number', interpretation: 'plain', default: 0 },
  ],
  ownerField: 'playerId', uniqueOn: ['code', 'turn'],
  permissions: { '*': denied, viewer: denied, member: own, admin: own },
}
