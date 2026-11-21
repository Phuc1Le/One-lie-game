import type { CollectionSchema } from 'deepspace/schema'

export const LOBBY_SEATS = 'lobby_seats'
export const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}$/

export type LobbySeat = {
  code: string
  seat: number
  playerId: string
  displayName: string
  // The creator's seat carries the room's lifecycle. Older seats are open.
  status?: 'open' | 'closed'
}

// Only the actions assign seats. Authenticated players may read lobby rosters;
// future secret words must live in a separate, private collection.
const readOnly = { read: true, create: false, update: false, delete: false } as const
const noAccess = { read: false, create: false, update: false, delete: false } as const

export const lobbySeatsSchema: CollectionSchema = {
  name: LOBBY_SEATS,
  columns: [
    { name: 'code', storage: 'text', interpretation: 'plain', required: true, maxLength: 4 },
    { name: 'seat', storage: 'number', interpretation: 'plain', required: true },
    { name: 'playerId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'displayName', storage: 'text', interpretation: 'plain', required: true, maxLength: 60 },
    { name: 'status', storage: 'text', interpretation: 'plain', default: 'open' },
  ],
  // Storage, rather than a UI check, prevents two callers claiming seat 2.
  uniqueOn: ['code', 'seat'],
  permissions: { '*': noAccess, viewer: noAccess, member: readOnly, admin: readOnly },
}
