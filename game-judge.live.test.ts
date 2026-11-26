import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ActionTools } from 'deepspace/worker'
import { judgeQuestion } from './src/ai/game-judge'

// Opt-in: these evaluations make paid calls using the current DeepSpace CLI
// login. Ordinary unit tests never invoke the provider.
const run = promisify(execFile)
const cli = fileURLToPath(new URL('./node_modules/deepspace/dist/cli.js', import.meta.url))
const tools = {
  integration: async (endpoint: string, body: unknown) => {
    const { stdout } = await run(process.execPath, [cli, 'integrations', 'invoke', endpoint,
      '--body', JSON.stringify(body), '--yes', '--json', '--timeout', '15000'], { timeout: 17_000 })
    const result = JSON.parse(stdout.trim())
    if (!result.ok) throw new Error(`Live integration failed: ${result.code}`)
    return { success: true, data: result.data }
  },
} as unknown as Pick<ActionTools, 'integration'>

describe.skipIf(process.env.ONE_LIE_LIVE_AI !== '1')('live question judge regression', () => {
  it.each([
    ['May', 'Can May have more than 30 days?', 'Yes'],
    ['May', 'Can it have more than 30 days?', 'Yes'],
    ['May', 'Does it have more than 31 days?', 'No'],
    ['February', 'Can it have 29 days?', 'Yes'],
    ['February', 'Does it always have 29 days?', 'No'],
    ['February', 'Does it have 29 days?', 'Depends'],
    ['April', 'Does it have more than 30 days?', 'No'],
  ])('%s: %s → %s', async (secret, question, truth) => {
    expect(await judgeQuestion(tools, { category: 'Months of the Year', secret, question }))
      .toEqual({ valid: true, reason: 'ok', truth })
  }, 20_000)

  it('still rejects a direct identity guess', async () => {
    expect(await judgeQuestion(tools, { category: 'Months of the Year', secret: 'May', question: 'Is it May?' }))
      .toEqual({ valid: false, reason: 'direct_guess', truth: 'Depends' })
  }, 20_000)

  it.each([
    ['Common Fruits', 'Banana', 'Is it a mammal?', 'No'],
    ['Animals That Have Wings', 'Penguin', 'Can it fly through the air?', 'No'],
    ['Basic Geometric Shapes', 'Square', 'Does it have at least four sides?', 'Yes'],
    ['Countries in Southeast Asia', 'Vietnam', 'Is it in Asia?', 'Yes'],
  ])('non-calendar: %s / %s / %s → %s', async (category, secret, question, truth) => {
    expect(await judgeQuestion(tools, { category, secret, question }))
      .toEqual({ valid: true, reason: 'ok', truth })
  }, 20_000)
})
