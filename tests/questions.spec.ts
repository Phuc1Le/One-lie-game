import { test, expect, loadAllTestAccounts } from 'deepspace/testing'

test('manual Q&A: private truth, one lie, refresh, duplicate submission and six answered questions', async ({ users }) => {
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
  for (const [player, word] of [[a, 'football'], [b, 'tennis']] as const) {
    await player.page.getByLabel('Your secret word', { exact: true }).fill(word)
    await player.page.getByRole('button', { name: 'Lock in word' }).click()
  }
  const qa = (player: typeof a) => player.page.getByRole('region', { name: 'Questions and answers', exact: true })
  await expect(qa(a)).toBeVisible()
  await expect(qa(b)).toBeVisible()
  await expect(a.page.getByTestId('qa-round')).toHaveText('Round 1/3')
  await expect(a.page.getByTestId('duel-player-1').locator('.duel-countdown-ring')).toHaveCount(1)
  await expect(a.page.getByText('Don’t guess the secret word directly.', { exact: false })).toBeVisible()
  // Reconnect both while the 30-second asking clock is running. Multiple full
  // app reloads in the 15-second answering window can legitimately time out.
  await Promise.all([a.page.reload(), b.page.reload()])
  await expect(a.page.getByLabel('Your question', { exact: true })).toBeVisible({ timeout: 15_000 })
  // The host asks; the answerer then refreshes a saved private declaration.
  await a.page.getByLabel('Your question', { exact: true }).fill('Does it use a ball?')
  await a.page.getByRole('button', { name: 'Submit question', exact: true }).click()
  await expect(b.page.getByRole('heading', { name: 'Does it use a ball?' })).toBeVisible()
  await expect(b.page.getByTestId('duel-player-2').getByRole('timer')).toHaveText(/^(1[0-5]|[0-9])s$/)
  const answerSeconds = parseInt((await b.page.getByRole('timer').textContent())!)
  await b.page.getByRole('button', { name: 'Declare truthful Yes', exact: true }).click()
  await expect(b.page.getByRole('button', { name: 'Send Yes', exact: true })).toBeEnabled()
  // The declaration itself survives refresh but never appears on the asker.
  await b.page.reload()
  await expect(b.page.getByText('Your private truthful declaration:')).toContainText('Yes', { timeout: 10_000 })
  expect(parseInt((await b.page.getByRole('timer').textContent())!)).toBeLessThanOrEqual(answerSeconds)
  await b.page.screenshot({ path: '.deepspace/qa-duel-desktop.png', fullPage: true })
  await expect(a.page.getByText('Your private truthful declaration:')).toHaveCount(0)
  await expect(a.page.getByTestId('lie-token')).toHaveCount(0)
  await b.page.setViewportSize({ width: 390, height: 844 })
  await b.page.screenshot({ path: '.deepspace/qa-answer-mobile.png', fullPage: true })
  expect(await b.page.evaluate(() => document.querySelector('.qa-arena')!.scrollWidth <= innerWidth)).toBe(true)
  // Choosing a different answer spends Bob's token. Two identical HTTP
  // submissions model a double click/retry that bypasses disabled UI buttons.
  await b.page.getByRole('button', { name: 'Send No', exact: true }).click()
  const duplicate = await Promise.all([1, 2].map(() => b.page.request.post('/api/actions/submitAnswer', {
    headers: { Authorization: bobAuth }, data: { code, turn: 1, answer: 'No' },
  }).then((r) => r.json())))
  expect(duplicate.filter((r) => r.success)).toHaveLength(1)
  for (const player of [a, b]) await expect(player.page.getByRole('region', { name: 'Completed conversation' }).getByText('No', { exact: true })).toBeVisible()
  await b.page.getByLabel('Your question', { exact: true }).fill('Is it played indoors?')
  await b.page.getByRole('button', { name: 'Submit question', exact: true }).click()
  await a.page.getByRole('button', { name: 'Declare truthful Depends', exact: true }).click()
  await a.page.getByRole('button', { name: 'Send Depends', exact: true }).click()
  await a.page.getByRole('button', { name: 'Submit answer', exact: true }).click()
  // Alice's truthful Depends leaves her token available. Bob must tell truth.
  await a.page.getByLabel('Your question', { exact: true }).fill('Is it a team sport?')
  await expect(a.page.getByTestId('qa-round')).toHaveText('Round 2/3')
  await a.page.getByRole('button', { name: 'Submit question', exact: true }).click()
  await b.page.getByRole('button', { name: 'Declare truthful No', exact: true }).click()
  await expect(b.page.getByText('Your private truthful declaration:')).toContainText('No')
  await expect(b.page.getByTestId('lie-token')).toContainText('Used')
  await expect(b.page.getByRole('button', { name: 'Send Yes', exact: true })).toBeDisabled()
  await expect(b.page.getByRole('button', { name: 'Send Depends', exact: true })).toBeDisabled()
  const secondLie = await b.page.request.post('/api/actions/submitAnswer', { headers: { Authorization: bobAuth }, data: { code, turn: 3, answer: 'Yes' } })
  expect(await secondLie.json()).toMatchObject({ success: false, code: 'lie_used' })
  await b.page.getByRole('button', { name: 'Send No', exact: true }).click()
  await b.page.getByRole('button', { name: 'Submit answer', exact: true }).click()
  for (const [turn, asker, answerer] of [[4, b, a], [5, a, b], [6, b, a]] as const) {
    await asker.page.getByLabel('Your question', { exact: true }).fill(`Question ${turn}?`)
    await asker.page.getByRole('button', { name: 'Submit question', exact: true }).click()
    await answerer.page.getByRole('button', { name: 'Declare truthful Yes', exact: true }).click()
    if (turn === 4) await expect(answerer.page.getByTestId('lie-token')).toContainText('Available')
    await answerer.page.getByRole('button', { name: 'Send Yes', exact: true }).click()
    await answerer.page.getByRole('button', { name: 'Submit answer', exact: true }).click()
  }
  for (const player of [a, b]) {
    await expect(player.page.getByRole('heading', { name: 'Awaiting guesses', exact: true })).toBeVisible()
    await expect(player.page.locator('.qa-exchange')).toHaveCount(6)
    await expect(player.page.locator('.qa-message')).toHaveCount(12)
    await expect(player.page.getByTestId('qa-round')).toHaveText('Round 3/3')
    await expect(player.page.getByLabel('Your question', { exact: true })).toHaveCount(0)
  }
  await a.page.reload()
  await expect(a.page.getByRole('heading', { name: 'Awaiting guesses', exact: true })).toBeVisible()
  await a.page.screenshot({ path: '.deepspace/qa-conversation-desktop.png', fullPage: true })
  // Exit failures must remain visible after word selection switches to Q&A.
  await a.page.route('**/api/actions/exitRoom', (route) => route.fulfill({
    status: 500, contentType: 'application/json',
    body: JSON.stringify({ success: false, error: 'Could not exit the room. Please try again.' }),
  }))
  await a.page.getByRole('button', { name: 'Exit Room', exact: true }).click()
  await expect(a.page.getByRole('alert')).toHaveText('Could not exit the room. Please try again.')
  await expect(qa(a)).toBeVisible()
  await expect(a.page.getByRole('button', { name: 'Exit Room', exact: true })).toBeEnabled()
  await a.page.unroute('**/api/actions/exitRoom')
  await b.page.getByRole('button', { name: 'Exit Room', exact: true }).click()
  await expect(a.page.getByText('This room has closed.', { exact: false })).toBeVisible()
})
