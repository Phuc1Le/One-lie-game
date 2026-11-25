import { describe, expect, it, vi } from 'vitest'
import type { ActionTools } from 'deepspace/worker'
import { judgeGuess } from './game-judge'

const data = { category: 'Vehicles', secret: 'car', guess: 'automobile' }
function boundary(content: unknown) {
  const integration = vi.fn(async () => ({ success: true, data: { choices: [{ message: { content: JSON.stringify(content) } }] } }))
  return { integration } as unknown as Pick<ActionTools, 'integration'>
}
describe('strict AI alias decisions', () => {
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
