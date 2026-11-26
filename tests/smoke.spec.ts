import { test, expect } from '@playwright/test'
import { captureConsoleErrors } from './helpers/errors'

for (const entry of ['/', '/home', '/lobby']) {
  test('game entry: ' + entry + ' opens One Lie', async ({ page }) => {
    const errors = captureConsoleErrors(page)
    await page.goto(entry)
    await expect(page).toHaveURL(/\/lobby$/, { timeout: 15_000 })
    await expect(page.getByRole('heading', { name: 'One Lie', exact: true })).toBeVisible()
    await expect(page.getByTestId('nav-sign-in-button')).toBeVisible()
    await expect(page.getByTestId('app-navigation').getByRole('link')).toHaveText(['One Lie'])
    await expect(page.getByTestId('nav-user-name')).toHaveCount(0)
    await expect(page).toHaveTitle('One Lie')
    expect(errors).toEqual([])
  })
}

test('game entry preserves a shared room code', async ({ page }) => {
  await page.goto('/?room=ABCD')
  await expect(page).toHaveURL(/\/lobby\?room=ABCD$/)
  await page.getByTestId('nav-sign-in-button').click()
  await expect(page.getByRole('heading', { name: 'Sign in to DeepSpace', exact: true })).toBeVisible()
})

test('unknown route shows 404', async ({ page }) => {
  await page.goto('/nonexistent-page-xyz')
  await expect(page.getByText('404', { exact: true })).toBeVisible()
})
