import { test, expect, loadAllTestAccounts } from 'deepspace/testing'
import { readFileSync } from 'node:fs'

test('AI Q&A: private server truth, refresh and duplicate answer', async ({ users }) => {
  test.setTimeout(120_000)
  test.skip(loadAllTestAccounts().length < 2, 'Needs two independent DeepSpace accounts.')
  const [a, b] = await users(2)
  // Both phase clocks must ignore opposite browser wall-clock offsets.
  await a.page.addInitScript(() => { const wallNow = Date.now; Date.now = () => wallNow() + 30_000 })
  await b.page.addInitScript(() => { const wallNow = Date.now; Date.now = () => wallNow() - 30_000 })
  await a.page.goto('/lobby')
  await a.page.getByRole('button', { name: 'Create Room', exact: true }).click()
  await expect(a.page.getByTestId('lobby-code')).toBeVisible()
  const code = (await a.page.getByTestId('lobby-code').textContent())!
  await b.page.goto('/lobby')
  await b.page.getByLabel('Room code', { exact: true }).fill(code)
  const joining = b.page.waitForRequest((r) => r.url().endsWith('/api/actions/joinRoom'))
  await b.page.getByRole('button', { name: 'Join Room', exact: true }).click()
  const bobAuth = (await joining).headers().authorization
  await expect(b.page.getByTestId('lobby-seat-2')).toContainText('(you)', { timeout: 15_000 })
  await a.page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(a.page.getByTestId('selection-category')).toBeVisible()
  const label = await a.page.getByTestId('selection-category').textContent()
  const catalog = JSON.parse(readFileSync(new URL('../categories.json', import.meta.url), 'utf8')) as { categories: Array<{ name: string; answers: Array<{ canonical: string }> }> }
  const words = catalog.categories.find((entry) => entry.name === label)!.answers.slice(0, 2).map((entry) => entry.canonical)
  for (const [player, word] of [[a, words[0]], [b, words[1]]] as const) {
    await player.page.getByLabel('Your secret word', { exact: true }).fill(word)
    await player.page.getByRole('button', { name: 'Lock in word' }).click()
  }
  const qa = (player: typeof a) => player.page.getByRole('region', { name: 'Questions and answers', exact: true })
  await expect(qa(a)).toBeVisible()
  await expect(qa(b)).toBeVisible()
  await expect(a.page.getByTestId('qa-round')).toHaveText('Turn 1/3')
  await expect(a.page.getByTestId('duel-player-1').locator('.duel-countdown-ring')).toHaveCount(1)
  await expect(a.page.getByText('Don’t guess the secret word directly.', { exact: false })).toBeVisible()

  await a.page.getByLabel('Your question', { exact: true }).fill('Is it usually found in nature?')
  const submission = a.page.waitForResponse((response) => response.url().endsWith('/api/actions/askQuestion'))
  await a.page.getByRole('button', { name: 'Submit question', exact: true }).click()
  expect(await (await submission).json()).toMatchObject({ success: true, data: { accepted: true } })
  const truth = b.page.locator('.qa-private-note').filter({ hasText: 'AI truthful answer' })
  await expect(truth).toBeVisible({ timeout: 25_000 })
  await expect(a.page.getByText('AI truthful answer', { exact: false })).toHaveCount(0)
  await expect(b.page.getByRole('button', { name: /Declare truthful/ })).toHaveCount(0)
  const answer = (await truth.locator('strong').textContent())!
  await b.page.reload()
  await expect(b.page.locator('.qa-private-note').filter({ hasText: 'AI truthful answer' })).toContainText(answer)
  const spoof = await b.page.request.post('/api/actions/declareTruth', { headers: { Authorization: bobAuth }, data: { code, turn: 1, truth: 'Yes' } })
  expect(spoof.status()).toBe(404)
  const duplicate = await Promise.all([1, 2].map(() => b.page.request.post('/api/actions/submitAnswer', {
    headers: { Authorization: bobAuth }, data: { code, turn: 1, answer },
  }).then((r) => r.json())))
  expect(duplicate.filter((r) => r.success)).toHaveLength(1)
  await expect(a.page.getByRole('region', { name: 'Completed conversation' })).toContainText(answer)
  await b.page.getByRole('button', { name: 'Exit Room', exact: true }).click()
  await expect(a.page.getByText('This room has closed.', { exact: false })).toBeVisible()
})
