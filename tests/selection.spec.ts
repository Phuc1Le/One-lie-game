import { readFileSync } from 'node:fs'
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'
import type { Page } from '@playwright/test'

const catalog = JSON.parse(readFileSync(new URL('../categories.json', import.meta.url), 'utf8')) as {
  categories: Array<{ name: string; answers: Array<{ canonical: string; aliases: string[] }> }>
}

async function shownCategory(page: Page) {
  const label = await page.getByTestId('selection-category').textContent()
  const category = catalog.categories.find((entry) => entry.name === label)
  expect(category, 'The displayed category must exist in categories.json').toBeDefined()
  return category!
}

async function enterDuel(a: { page: Page }, b: { page: Page }, waitForReveal = true) {
  await a.page.goto('/lobby')
  await a.page.getByRole('button', { name: 'Create Room', exact: true }).click()
  await expect(a.page.getByTestId('lobby-code')).toHaveText(/^[A-HJ-NP-Z2-9]{4}$/)
  const code = (await a.page.getByTestId('lobby-code').textContent())!
  await expect(a.page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0)
  await b.page.goto('/lobby')
  await b.page.getByLabel('Room code', { exact: true }).fill(code)
  const joinRequest = b.page.waitForRequest((request) => request.url().endsWith('/api/actions/joinRoom'))
  await b.page.getByRole('button', { name: 'Join Room', exact: true }).click()
  await expect(b.page.getByTestId('lobby-seat-2')).toContainText('(you)', { timeout: 15_000 })
  await expect(b.page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0)
  const guestStart = await b.page.request.post('/api/actions/startGame', {
    headers: { Authorization: (await joinRequest).headers().authorization }, data: { code },
  })
  expect(await guestStart.json()).toMatchObject({ success: false, code: 'host_only' })
  const startRequest = a.page.waitForRequest((request) => request.url().endsWith('/api/actions/startGame'))
  await a.page.getByRole('button', { name: 'Start', exact: true }).click()
  const authorization = (await startRequest).headers().authorization
  for (const player of [a, b]) {
    await expect(player.page.getByRole('dialog', { name: 'One Lie duel' })).toBeVisible()
    if (waitForReveal) await expect(player.page.getByTestId('selection-category')).toBeVisible()
    if (waitForReveal) await expect(player.page.getByText('Accepted words in this category', { exact: true })).toBeVisible()
  }
  if (waitForReveal) await expect(b.page.getByTestId('selection-category')).toHaveText((await a.page.getByTestId('selection-category').textContent())!)
  return { code, authorization }
}

test('word selection: Start opens the duel, words submit once, remain private and survive refresh', async ({ users }) => {
  test.setTimeout(60_000)
  test.skip(loadAllTestAccounts().length < 2, 'Needs two DeepSpace test accounts.')
  const [a, b] = await users(2)
  const incoming: any[] = []
  a.page.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => {
    if (typeof payload === 'string') {
      try { incoming.push(JSON.parse(payload)) } catch { /* Ignore non-game HMR frames. */ }
    }
  }))
  const { code, authorization } = await enterDuel(a, b)
  const [hostWord, guestWord] = (await shownCategory(a.page)).answers.map((answer) => answer.canonical)
  const timerBefore = parseInt((await a.page.getByTestId('selection-timer').textContent())!)
  expect(timerBefore).toBeGreaterThan(0)
  expect(timerBefore).toBeLessThanOrEqual(20)
  await a.page.screenshot({ path: '.deepspace/duel-selecting.png', fullPage: true })
  await a.page.getByLabel('Your secret word', { exact: true }).fill(hostWord)
  await a.page.getByRole('button', { name: 'Lock in word' }).click()
  await expect(a.page.getByTestId('own-secret-word')).toHaveText(hostWord)
  await expect(a.page.getByLabel('Your secret word', { exact: true })).toHaveCount(0)
  await expect(a.page.getByRole('button', { name: 'Update my word' })).toHaveCount(0)
  await expect(b.page.getByTestId('opponent-secret')).toHaveText('?????')
  await expect(b.page.getByTestId('duel-ready-1')).toHaveText('Locked in')

  const edit = await a.page.request.post('/api/actions/selectWord', {
    headers: { Authorization: authorization }, data: { code, word: guestWord },
  })
  expect(await edit.json()).toMatchObject({ success: false, code: 'already_selected' })
  await a.page.reload()
  await expect(a.page.getByTestId('own-secret-word')).toHaveText(hostWord)
  await expect(a.page.getByTestId('selection-timer')).toHaveText(/^\d+s$/)
  const timerAfter = parseInt((await a.page.getByTestId('selection-timer').textContent())!)
  expect(timerAfter).toBeLessThanOrEqual(timerBefore)

  await b.page.getByLabel('Your secret word', { exact: true }).fill(guestWord)
  await b.page.getByRole('button', { name: 'Lock in word' }).click()
  for (const player of [a, b]) {
    await expect(player.page.getByTestId('selections-locked')).toContainText('Both players ready')
    await expect(player.page.getByRole('timer', { name: 'Time remaining', exact: true })).toHaveCount(0)
    await expect(player.page.getByTestId('selection-timer')).toHaveCount(0)
    await expect(player.page.getByTestId('opponent-secret')).toHaveText('?????')
    await expect(player.page.getByLabel('Your secret word', { exact: true })).toHaveCount(0)
  }
  await expect(b.page.getByTestId('own-secret-word')).toHaveText(guestWord)
  expect(JSON.stringify(incoming.filter((frame) => frame.type === 'core.record_change' && frame.payload.collection === 'word_selections'))).not.toContain(guestWord)

  // Hold the room snapshot on reload. The old implementation rendered the
  // lobby here before it knew whether this room had already started.
  let holdRoomSnapshot = true
  const heldSnapshots: Array<() => void> = []
  await a.page.routeWebSocket((url) => url.pathname.startsWith('/ws/'), (socket) => {
    const server = socket.connectToServer()
    const roomSubscriptions = new Set<string>()
    socket.onMessage((message) => {
      try {
        const frame = JSON.parse(message.toString())
        if (frame.type === 'core.subscribe' && frame.payload.query.collection === 'lobby_seats') roomSubscriptions.add(frame.payload.subscriptionId)
      } catch { /* Forward non-record messages unchanged. */ }
      server.send(message)
    })
    server.onMessage((message) => {
      try {
        const frame = JSON.parse(message.toString())
        if (holdRoomSnapshot && frame.type === 'core.query_result' && roomSubscriptions.has(frame.payload.subscriptionId)) {
          heldSnapshots.push(() => socket.send(message))
          return
        }
      } catch { /* Forward non-record messages unchanged. */ }
      socket.send(message)
    })
  })
  await a.page.reload()
  await expect.poll(() => heldSnapshots.length, { timeout: 15_000 }).toBeGreaterThan(0)
  await expect(a.page.getByTestId('room-restoring')).toBeVisible()
  await expect(a.page.getByRole('region', { name: 'Game lobby', exact: true })).toHaveCount(0)
  await expect(a.page.getByRole('heading', { name: 'Your room code', exact: true })).toHaveCount(0)
  holdRoomSnapshot = false
  heldSnapshots.splice(0).forEach((deliver) => deliver())
  await expect(a.page.getByRole('dialog', { name: 'One Lie duel' })).toBeVisible()
  await expect(a.page.getByTestId('room-restoring')).toHaveCount(0)
  await expect(a.page.getByTestId('own-secret-word')).toHaveText(hostWord)
  await expect(a.page.getByRole('timer', { name: 'Time remaining', exact: true })).toHaveCount(0)

  await a.page.setViewportSize({ width: 390, height: 844 })
  await a.page.screenshot({ path: '.deepspace/duel-mobile.png', fullPage: true })
  // Exit still works from the full-screen duel and closes the other screen.
  await a.page.getByRole('button', { name: 'Exit Room', exact: true }).click()
  await expect(a.page.getByRole('button', { name: 'Create Room', exact: true })).toBeVisible()
  await expect(b.page.getByTestId('lobby-status')).toContainText('This room has closed.')
})

test('word selection: rejects unknown words, saves aliases canonically and requires confirmation for typos', async ({ users }) => {
  test.setTimeout(60_000)
  test.skip(loadAllTestAccounts().length < 2, 'Needs two DeepSpace test accounts.')
  const [a, b] = await users(2)
  const { code, authorization } = await enterDuel(a, b)
  const category = await shownCategory(a.page)
  const aliasAnswer = category.answers.find((answer) => answer.aliases.length > 0)!
  const typoAnswer = [...category.answers].sort((a, b) => b.canonical.length - a.canonical.length)[0]

  await a.page.getByLabel('Your secret word', { exact: true }).fill('Not a catalog answer zzzzzz')
  await expect(a.page.getByRole('button', { name: 'Lock in word' })).toBeDisabled()
  const invalid = await a.page.request.post('/api/actions/selectWord', {
    headers: { Authorization: authorization }, data: { code, word: 'Not a catalog answer zzzzzz' },
  })
  expect(await invalid.json()).toMatchObject({ success: false, code: 'invalid_category_word' })
  await expect(b.page.getByTestId('duel-ready-1')).not.toHaveText('Locked in')

  await a.page.getByLabel('Your secret word', { exact: true }).fill(aliasAnswer.aliases[0])
  await a.page.getByRole('button', { name: 'Lock in word' }).click()
  await expect(a.page.getByTestId('own-secret-word')).toHaveText(aliasAnswer.canonical)

  await b.page.getByLabel('Your secret word', { exact: true }).fill(`${typoAnswer.canonical}~`)
  await expect(b.page.getByRole('button', { name: 'Lock in word' })).toBeDisabled()
  await expect(b.page.getByTestId('own-secret-word')).toHaveCount(0)
  await b.page.getByRole('button', { name: `Use “${typoAnswer.canonical}”`, exact: true }).click()
  await expect(b.page.getByLabel('Your secret word', { exact: true })).toHaveValue(typoAnswer.canonical)
  await b.page.getByRole('button', { name: 'Lock in word' }).click()
  await expect(b.page.getByTestId('own-secret-word')).toHaveText(typoAnswer.canonical)
  await expect(a.page.getByTestId('selections-locked')).toBeVisible()
  await a.page.getByRole('button', { name: 'Exit Room', exact: true }).click()
  await expect(b.page.getByTestId('lobby-status')).toContainText('This room has closed.')
})

test('word selection: the shared 20-second deadline locks an empty word for a player who does not submit', async ({ users }) => {
  test.setTimeout(60_000)
  test.skip(loadAllTestAccounts().length < 2, 'Needs two DeepSpace test accounts.')
  const [a, b] = await users(2)
  await enterDuel(a, b)
  const [hostWord, guestWord] = (await shownCategory(a.page)).answers.map((answer) => answer.canonical)
  await a.page.getByLabel('Your secret word', { exact: true }).fill(hostWord)
  await a.page.getByRole('button', { name: 'Lock in word' }).click()
  await b.page.getByLabel('Your secret word', { exact: true }).fill(guestWord)
  await expect(b.page.getByTestId('own-secret-word')).toHaveText('Empty word', { timeout: 25_000 })
  await expect(b.page.getByTestId('selections-locked')).toBeVisible()
  await expect(b.page.getByRole('timer', { name: 'Time remaining', exact: true })).toHaveCount(0)
  await expect(a.page.getByTestId('own-secret-word')).toHaveText(hostWord)
  await b.page.reload()
  await expect(b.page.getByTestId('own-secret-word')).toHaveText('Empty word')
  await expect(b.page.getByLabel('Your secret word', { exact: true })).toHaveCount(0)
})

for (const exitingSeat of [0, 1]) {
  for (const phase of ['reveal', 'countdown']) {
    test(`word selection: player ${exitingSeat + 1} can exit during ${phase}`, async ({ users }) => {
      test.setTimeout(60_000)
      test.skip(loadAllTestAccounts().length < 2, 'Needs two DeepSpace test accounts.')
      const players = await users(2)
      const errors: string[] = []
      for (const player of players) player.page.on('pageerror', (error) => errors.push(error.message))
      await enterDuel(players[0], players[1], phase === 'countdown')
      const exiting = players[exitingSeat].page
      const remaining = players[1 - exitingSeat].page
      await exiting.getByRole('button', { name: 'Exit Room', exact: true }).click()
      await expect(exiting.getByRole('dialog', { name: 'One Lie duel' })).toHaveCount(0)
      await expect(exiting.getByRole('button', { name: 'Create Room', exact: true })).toBeVisible({ timeout: 15_000 })
      await expect(remaining.getByTestId('lobby-status')).toContainText('This room has closed.', { timeout: 15_000 })
      await expect(remaining.getByRole('dialog', { name: 'One Lie duel' })).toHaveCount(0)
      expect(errors).toEqual([])
    })
  }
}

for (const hostOffset of [-30_000, 30_000]) {
  test(`word selection: browser wall clock offset ${hostOffset}ms cannot skip word entry or reset the timer`, async ({ users }) => {
    test.setTimeout(60_000)
    test.skip(loadAllTestAccounts().length < 2, 'Needs two DeepSpace test accounts.')
    const [a, b] = await users(2)
    for (const [player, offset] of [[a, hostOffset], [b, -hostOffset]] as const) {
      await player.page.addInitScript((delta) => {
        const actualNow = Date.now.bind(Date)
        Date.now = () => actualNow() + delta
      }, offset)
    }
    await enterDuel(a, b)
    const [hostWord, guestWord] = (await shownCategory(a.page)).answers.map((answer) => answer.canonical)
    const readSeconds = async (page: Page) => parseInt((await page.getByTestId('selection-timer').textContent())!)
    for (const player of [a, b]) {
      await expect(player.page.getByLabel('Your secret word', { exact: true })).toBeVisible()
      expect(await readSeconds(player.page)).toBeGreaterThan(10)
      expect(await readSeconds(player.page)).toBeLessThanOrEqual(20)
    }
    expect(Math.abs(await readSeconds(a.page) - await readSeconds(b.page))).toBeLessThanOrEqual(1)
    // Confirm this browser really has the injected offset, not a fake timer.
    expect(Math.abs((await a.page.evaluate(() => Date.now())) - Date.now() - hostOffset)).toBeLessThan(1000)
    await a.page.getByLabel('Your secret word', { exact: true }).fill(hostWord)
    await a.page.getByRole('button', { name: 'Lock in word' }).click()
    await expect(a.page.getByTestId('own-secret-word')).toHaveText(hostWord)

    const beforeRefresh = await readSeconds(b.page)
    await b.page.reload()
    await expect(b.page.getByLabel('Your secret word', { exact: true })).toBeVisible()
    expect(await readSeconds(b.page)).toBeGreaterThan(0)
    expect(await readSeconds(b.page)).toBeLessThanOrEqual(beforeRefresh)
    // An additional wall-clock jump during the round must not move the timer.
    const beforeJump = await readSeconds(b.page)
    const resync = b.page.waitForResponse((response) => response.url().endsWith('/api/actions/getDuelTiming'))
    await b.page.evaluate(() => {
      const oldNow = Date.now.bind(Date)
      Date.now = () => oldNow() + 60_000
      window.dispatchEvent(new Event('focus'))
    })
    await resync
    expect(await readSeconds(b.page)).toBeGreaterThan(0)
    expect(await readSeconds(b.page)).toBeLessThanOrEqual(beforeJump)
    await b.page.getByLabel('Your secret word', { exact: true }).fill(guestWord)
    await b.page.getByRole('button', { name: 'Lock in word' }).click()
    await expect(b.page.getByTestId('own-secret-word')).toHaveText(guestWord)
    for (const player of [a, b]) {
      await expect(player.page.getByTestId('selections-locked')).toBeVisible()
      await expect(player.page.getByRole('timer', { name: 'Time remaining', exact: true })).toHaveCount(0)
      await expect(player.page.getByTestId('opponent-secret')).toHaveText('?????')
    }
  })
}
