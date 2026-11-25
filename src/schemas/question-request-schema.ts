import type { CollectionSchema } from 'deepspace/schema'
export const QUESTION_REQUESTS = 'question_requests'
export type QuestionRequest = { code: string; turn: number; playerId: string; attempts: number; state: string; question: string; askEndsAt: number; error: string }
const denied = { read: false, create: false, update: false, delete: false } as const
const own = { ...denied, read: 'own' } as const
export const questionRequestsSchema: CollectionSchema = {
  name: QUESTION_REQUESTS, ownerField: 'playerId', uniqueOn: ['code', 'turn'],
  columns: [
    // Retain historical columns so removing the feature needs no data migration.
    ...['code', 'state', 'question', 'error', 'suggestionState', 'suggestion'].map((name) => ({ name, storage: 'text' as const, interpretation: 'plain' as const })),
    ...['turn', 'attempts', 'askEndsAt'].map((name) => ({ name, storage: 'number' as const, interpretation: 'plain' as const })),
    { name: 'playerId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true },
  ],
  permissions: { '*': denied, viewer: denied, member: own, admin: own },
}
