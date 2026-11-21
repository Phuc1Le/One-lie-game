import { test, expect, loadAllTestAccounts } from 'deepspace/testing'

const accounts = loadAllTestAccounts().length

for (const exitingSeat of [0, 1]) {
  test(`lobby: player ${exitingSeat + 1} exits and closes the room for both players`, async ({ users }) => {
    test.skip(accounts < 2, 'Needs two DeepSpace test accounts.')
    const players = await users(2)
    const [host, guest] = players
    await host.page.goto('/lobby')
    await host.page.getByRole('button', { name: 'Create Room', exact: true }).click()
    await expect(host.page.getByTestId('lobby-code')).toHaveText(/^[A-HJ-NP-Z2-9]{4}$/)
    const code = (await host.page.getByTestId('lobby-code').textContent())!
    await guest.page.goto('/lobby')
    await guest.page.getByLabel('Room code', { exact: true }).fill(code)
    await guest.page.getByRole('button', { name: 'Join Room', exact: true }).click()
    await expect(guest.page.getByTestId('lobby-seat-2')).toContainText('(you)')

    const exiting = players[exitingSeat].page
    const remaining = players[1 - exitingSeat].page
    await exiting.getByRole('button', { name: 'Exit Room', exact: true }).click()
    await expect(exiting.getByRole('button', { name: 'Create Room', exact: true })).toBeVisible()
    // The other browser must receive closure without a refresh.
    await expect(remaining.getByRole('status')).toContainText('Your opponent left. This room has closed.')
    await expect(remaining.getByTestId('lobby-seat-1')).toHaveCount(0)
    await expect(remaining.getByTestId('lobby-seat-2')).toHaveCount(0)
    await remaining.reload()
    await expect(remaining.getByRole('status')).toContainText('This room has closed.')

    await remaining.getByRole('button', { name: 'Back to lobby', exact: true }).click()
    await remaining.getByLabel('Room code', { exact: true }).fill(code)
    await remaining.getByRole('button', { name: 'Join Room', exact: true }).click()
    await expect(remaining.getByRole('alert')).toContainText('This room has closed.')
  })
}

test('lobby: sign-in is required', async ({ page }) => {
  await page.goto('/lobby')
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create Room', exact: true })).toHaveCount(0)
  const response = await page.request.post('/api/actions/createRoom', { data: {} })
  expect(response.status()).toBe(401)
})

test('lobby: second player appears live and both seats survive refreshing', async ({ users }) => {
  test.skip(accounts < 2, 'Needs two DeepSpace test accounts.')
  const [a, b] = await users(2)
  await a.page.goto('/lobby')
  await a.page.getByRole('button', { name: 'Create Room', exact: true }).click()
  const codeElement = a.page.getByTestId('lobby-code')
  await expect(codeElement).toHaveText(/^[A-HJ-NP-Z2-9]{4}$/)
  const code = (await codeElement.textContent())!
  await expect(a.page.getByTestId('lobby-seat-1')).toContainText('(you)')
  await expect(a.page.getByTestId('lobby-seat-2')).toContainText('Open seat')

  await b.page.goto('/lobby')
  await b.page.getByLabel('Room code', { exact: true }).fill(code)
  await b.page.getByRole('button', { name: 'Join Room', exact: true }).click()
  await expect(b.page.getByTestId('lobby-seat-2')).toContainText('(you)')
  // No navigation or reload on A: this assertion must pass through live sync.
  await expect(a.page.getByTestId('lobby-seat-2')).not.toContainText('Open seat')
  await expect(a.page.getByRole('status')).toContainText('Both players are here')

  await Promise.all([a.page.reload(), b.page.reload()])
  await expect(a.page.getByTestId('lobby-seat-1')).toContainText('(you)')
  await expect(b.page.getByTestId('lobby-seat-2')).toContainText('(you)')
  await expect(a.page.getByRole('status')).toContainText('Both players are here')

  // The same account can rejoin a full room without consuming another seat.
  await b.page.goto('/lobby')
  await b.page.getByLabel('Room code', { exact: true }).fill(code)
  await b.page.getByRole('button', { name: 'Join Room', exact: true }).click()
  await expect(b.page.getByTestId('lobby-seat-2')).toContainText('(you)')
})

test('lobby: simultaneous joins award only one last seat', async ({ users }) => {
  test.skip(accounts < 3, 'Needs three DeepSpace test accounts to test a competing join.')
  const [a, b, c] = await users(3)
  await a.page.goto('/lobby')
  await a.page.getByRole('button', { name: 'Create Room', exact: true }).click()
  await expect(a.page.getByTestId('lobby-code')).toHaveText(/^[A-HJ-NP-Z2-9]{4}$/)
  const code = (await a.page.getByTestId('lobby-code').textContent())!
  for (const player of [b, c]) {
    await player.page.goto('/lobby')
    await player.page.getByLabel('Room code', { exact: true }).fill(code)
  }
  await Promise.all([b, c].map((player) => player.page.getByRole('button', { name: 'Join Room', exact: true }).click()))
  await expect.poll(async () => {
    const alerts = await Promise.all([b, c].map((player) => player.page.getByRole('alert').allTextContents()))
    return alerts.flat().filter((text) => text.includes('Room full')).length
  }).toBe(1)
  await expect(a.page.getByRole('status')).toContainText('Both players are here')
  const seated = await Promise.all([b, c].map((player) => player.page.getByTestId('lobby-seat-2').filter({ hasText: '(you)' }).count()))
  expect(seated.reduce((sum, count) => sum + count, 0)).toBe(1)
})
