import { describe, expect, it } from 'vitest'
import { CATEGORIES, matchWord, normalizeWord } from './categories'

describe('curated category vocabulary', () => {
  it('accepts every canonical answer and alias without changing their meaning', () => {
    for (const category of CATEGORIES) {
      for (const answer of category.answers) {
        for (const input of [answer.canonical, ...answer.aliases]) {
          expect(matchWord(category.id, `  ${input.toUpperCase()}! `).canonical).toBe(answer.canonical)
        }
      }
    }
  })
  it('suggests an unambiguous typo but does not accept it until confirmed', () => {
    expect(matchWord('planets', 'Jupitr')).toEqual({ suggestion: 'Jupiter' })
    expect(matchWord('planets', 'Jupiter')).toEqual({ canonical: 'Jupiter' })
  })
  it('rejects unrelated or wrong-category input and empty text', () => {
    expect(matchWord('planets', 'Banana')).toEqual({})
    expect(matchWord('planets', '')).toEqual({})
    expect(matchWord('missing', 'Mars')).toEqual({})
    expect(normalizeWord('  THE   Earth! ')).toBe('the earth')
  })
})
