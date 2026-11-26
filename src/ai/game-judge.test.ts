import { describe, expect, it, vi } from 'vitest'
import type { ActionTools } from 'deepspace/worker'
import { judgeGuess, judgeQuestion } from './game-judge'

const data = { category: 'Vehicles', secret: 'car', guess: 'automobile' }
function boundary(content: unknown) {
  const integration = vi.fn(async () => ({ success: true, data: { choices: [{ message: { content: JSON.stringify(content) } }] } }))
  return { integration } as unknown as Pick<ActionTools, 'integration'>
}
describe('strict AI alias decisions', () => {
  it('uses mini for question truth and keeps alias checks on nano, with one bounded call each', async () => {
    const questionTools = boundary({ valid: true, reason: 'ok', truth: 'Yes' })
    await judgeQuestion(questionTools, { category: 'Months of the Year', secret: 'May', question: 'Can it have more than 30 days?' })
    expect(questionTools.integration).toHaveBeenCalledExactlyOnceWith('openai/chat-completion', expect.objectContaining({ model: 'gpt-5.4-mini', max_tokens: 160, temperature: 0 }))
    const guessTools = boundary({ relation: 'alias', canonical: 'car' })
    await judgeGuess(guessTools, data)
    expect(guessTools.integration).toHaveBeenCalledExactlyOnceWith('openai/chat-completion', expect.objectContaining({ model: 'gpt-5.4-nano', max_tokens: 160, temperature: 0 }))
  })
  it('accepts only an explicit alias mapped back to the exact secret', async () => {
    expect(await judgeGuess(boundary({ relation: 'alias', canonical: 'car' }), data)).toEqual({ matches: true })
    expect(await judgeGuess(boundary({ relation: 'alias', canonical: 'truck' }), data)).toEqual({ matches: false })
  })
  it.each(['different', 'ambiguous'])('rejects %s even when the response contains the secret', async (relation) => {
    expect(await judgeGuess(boundary({ relation, canonical: 'car' }), data)).toEqual({ matches: false })
  })
  it('does not accept the old permissive boolean or malformed output', async () => {
    await expect(judgeGuess(boundary({ matches: true }), data)).rejects.toThrow('invalid decision')
    await expect(judgeGuess(boundary({ relation: 'almost', canonical: 'car' }), data)).rejects.toThrow('invalid decision')
  })
})
