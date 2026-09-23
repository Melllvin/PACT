import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/launch-app';
test('opens PACT', async () => {
  const app = await launchApp();
  const page = await app.firstWindow();
  await expect(page).toHaveTitle('PACT');
  await expect(page.getByText('Vos agents.')).toBeVisible();
  await app.close();
});
