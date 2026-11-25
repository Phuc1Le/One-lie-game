import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import { createRoom, joinRoom, exitRoom } from './lobby'
import { getDuelTiming, selectWord, startGame } from './selection'
import { submitAnswer, syncQuestions } from './questions'
import { askAIQuestion as askQuestion } from './ai-questions'
import { submitGuess, syncGuesses } from './guesses'

export const actions: Record<string, ActionHandler<Env>> = { createRoom, joinRoom, exitRoom, selectWord, startGame, getDuelTiming, askQuestion, submitAnswer, syncQuestions, submitGuess, syncGuesses }
