// Category titles drive the reel. Example words are reserved for future
// suggestions; players can currently submit any freely typed word.
export const CATEGORIES = [
  { id: 'sports', label: 'A sport', words: ['football', 'basketball', 'tennis', 'swimming', 'cricket', 'volleyball', 'badminton', 'table tennis'] },
  { id: 'asia', label: 'A country in Asia', words: ['Vietnam', 'Japan', 'China', 'India', 'Thailand', 'Indonesia', 'Malaysia', 'Singapore'] },
  { id: 'red-fruit', label: 'A red fruit', words: ['strawberry', 'cherry', 'raspberry', 'cranberry', 'redcurrant', 'pomegranate', 'red apple', 'lychee'] },
  { id: 'devices', label: 'An electronic device', words: ['smartphone', 'laptop', 'tablet', 'television', 'camera', 'printer', 'headphones', 'smartwatch'] },
  { id: 'ocean', label: 'An animal in the ocean', words: ['dolphin', 'shark', 'octopus', 'jellyfish', 'seahorse', 'stingray', 'sea turtle', 'starfish'] },
] as const

export function roomCategory(code: string, categoryId?: string) {
  const chosen = CATEGORIES.find((category) => category.id === categoryId)
  if (chosen) return chosen
  // Rooms created before categories existed get the same category in every
  // browser and on the server, without needing a separate migration action.
  const seed = Array.from(code).reduce((value, char) => value * 31 + char.charCodeAt(0), 0)
  return CATEGORIES[seed % CATEGORIES.length]
}
