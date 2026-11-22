import type { CollectionSchema } from 'deepspace/schema'

export const WORD_SELECTIONS = 'word_selections'
export type WordSelection = { code: string; playerId: string; word: string }

const noAccess = { read: false, create: false, update: false, delete: false } as const
const ownReadOnly = { read: 'own', create: false, update: false, delete: false } as const

export const wordSelectionsSchema: CollectionSchema = {
  name: WORD_SELECTIONS,
  columns: [
    { name: 'code', storage: 'text', interpretation: 'plain', required: true, immutable: true, maxLength: 4 },
    { name: 'playerId', storage: 'text', interpretation: 'plain', required: true, userBound: true, immutable: true },
    // Empty is a valid timed-out submission. Once written, words cannot change.
    { name: 'word', storage: 'text', interpretation: 'plain', immutable: true, maxLength: 40 },
  ],
  uniqueOn: ['code', 'playerId'],
  ownerField: 'playerId',
  // Even the app owner, playing as admin, must not receive an opponent's word.
  // All writes go through selectWord, which enforces room membership and lock.
  permissions: { '*': noAccess, viewer: noAccess, member: ownReadOnly, admin: ownReadOnly },
}
