// New rooms use this curated catalog for canonical words and aliases.
// Legacy categories preserve previously started free-text games.
import pack from '../../categories.json'

const LEGACY_CATEGORIES = [
  { id: 'sports', label: 'A sport', words: ['football', 'basketball', 'tennis', 'swimming', 'cricket', 'volleyball', 'badminton', 'table tennis'] },
  { id: 'asia', label: 'A country in Asia', words: ['Vietnam', 'Japan', 'China', 'India', 'Thailand', 'Indonesia', 'Malaysia', 'Singapore'] },
  { id: 'red-fruit', label: 'A red fruit', words: ['strawberry', 'cherry', 'raspberry', 'cranberry', 'redcurrant', 'pomegranate', 'red apple', 'lychee'] },
  { id: 'devices', label: 'An electronic device', words: ['smartphone', 'laptop', 'tablet', 'television', 'camera', 'printer', 'headphones', 'smartwatch'] },
  { id: 'ocean', label: 'An animal in the ocean', words: ['dolphin', 'shark', 'octopus', 'jellyfish', 'seahorse', 'stingray', 'sea turtle', 'starfish'] },
] as const

export const CATEGORIES = pack.categories.map((category) => ({
  id: category.id, label: category.name, description: category.description,
  words: category.answers.map((answer) => answer.canonical), answers: category.answers,
}))

export function normalizeWord(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').replace(/[.!?,;:]+$/u, '').trim().toLocaleLowerCase('en')
}

export function matchWord(categoryId: string, input: string): { canonical?: string; suggestion?: string } {
  const category = CATEGORIES.find((entry) => entry.id === categoryId)
  if (!category) return {} // Existing rooms retain the earlier free-text rules.
  const normalized = normalizeWord(input)
  if (!normalized) return {}
  const exact = category.answers.filter((answer) => [answer.canonical, ...answer.aliases].some((value) => normalizeWord(value) === normalized))
  if (exact.length === 1) return { canonical: exact[0].canonical }
  if (exact.length > 1) return {}
  const distances = category.answers.map((answer) => ({ canonical: answer.canonical,
    distance: Math.min(...[answer.canonical, ...answer.aliases].map((value) => editDistance(normalized, normalizeWord(value)))) }))
  distances.sort((a, b) => a.distance - b.distance)
  const first = distances[0]
  const threshold = normalized.length < 4 ? 0 : normalized.length < 8 ? 1 : 2
  return first && first.distance <= threshold && distances[1]?.distance !== first.distance ? { suggestion: first.canonical } : {}
}

function editDistance(a: string, b: string) {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1]
    for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1)))
    row = next
  }
  return row[b.length]
}

export function roomCategory(code: string, categoryId?: string) {
  const chosen = CATEGORIES.find((category) => category.id === categoryId) ?? LEGACY_CATEGORIES.find((category) => category.id === categoryId)
  if (chosen) return chosen
  // Rooms created before categories existed get the same category in every
  // browser and on the server, without needing a separate migration action.
  const seed = Array.from(code).reduce((value, char) => value * 31 + char.charCodeAt(0), 0)
  return CATEGORIES[seed % CATEGORIES.length]
}
