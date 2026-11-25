/**
 * Collection Schemas
 *
 * All collections with columns and RBAC permissions.
 * Single source of truth — imported by both worker and frontend.
 *
 * Add schemas by creating a file in src/schemas/ and importing it here.
 */

import type { CollectionSchema } from 'deepspace/schema'
import { usersSchema } from './schemas/users-schema'
import { settingsSchema } from './schemas/admin-schema'
import { lobbySeatsSchema } from './schemas/lobby-schema'
import { wordSelectionsSchema } from './schemas/word-selection-schema'
import { questionTurnsSchema, privateAnswersSchema } from './schemas/question-schema'
import { questionRequestsSchema } from './schemas/question-request-schema'
import { guessRoundsSchema, privateGuessesSchema } from './schemas/guess-schema'

export const schemas: CollectionSchema[] = [
  usersSchema,
  settingsSchema,
  lobbySeatsSchema,
  wordSelectionsSchema,
  questionTurnsSchema,
  questionRequestsSchema,
  privateAnswersSchema,
  guessRoundsSchema,
  privateGuessesSchema,
]
