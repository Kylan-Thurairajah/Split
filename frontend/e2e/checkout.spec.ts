import { expect, test } from '@playwright/test';

test('two tabs share edits, allocations and a completed demo receipt', async ({ page, context }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try Split', exact: true }).click();
  await expect(page).toHaveURL(/\/cart\/[^/?]+/);
  const second = await context.newPage();
  const connection = second.waitForEvent('websocket', socket => socket.url().endsWith('/ws'));
  await second.goto(page.url());
  const socket = await connection;
  await expect(second.getByText('Apartment Essentials', { exact: true }).first()).toBeVisible();
  await expect(second.getByText('$287.94', { exact: true }).first()).toBeVisible();
  await expect(second.getByText('Live', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  await page.getByRole('textbox', { name: /item name/i }).fill('Reading pillow');
  await page.getByRole('textbox', { name: /price/i }).fill('10.00');
  const broadcast = socket.waitForEvent('framereceived', frame => frame.payload.toString().includes('Reading pillow'));
  await page.getByRole('button', { name: 'Save item', exact: true }).click();
  await broadcast;
  const pillow = second.getByTestId('item-row').filter({ hasText: 'Reading pillow' });
  await expect(pillow).toBeVisible();

  await page.getByRole('button', { name: 'Increase quantity of Reading pillow', exact: true }).click();
  await expect(pillow.getByText('$20.00', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Allocate Reading pillow', exact: true }).click();
  await page.getByRole('button', { name: 'Assign', exact: true }).click();
  await page.getByRole('radio', { name: 'Jordan', exact: true }).click();
  await page.getByRole('button', { name: 'Save allocation', exact: true }).click();

  await expect(second.getByText('$119.65', { exact: true }).first()).toBeVisible();
  await second.getByRole('button', { name: 'Allocate Reading pillow', exact: true }).click();
  await second.getByRole('button', { name: 'Split equally', exact: true }).click();
  await expect(second.getByText('$6.67', { exact: true })).toHaveCount(2);
  await expect(second.getByText('$6.66', { exact: true })).toBeVisible();
  await second.getByRole('button', { name: 'Save allocation', exact: true }).click();

  await expect(page.getByText('$106.32', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Review checkout', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm demo checkout', exact: true }).click();
  await expect(page.getByText('Demo checkout complete', { exact: true })).toBeVisible();
  await expect(second.getByText('Demo checkout complete', { exact: true })).toBeVisible();
  await expect(second.getByText('Reading pillow × 2', { exact: true })).toBeVisible();
  await second.reload();
  await expect(second.getByText('Reading pillow × 2', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Reset demo', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm reset', exact: true }).click();
  await expect(second.getByTestId('item-row')).toHaveCount(5);
  await expect(second.getByText('$287.94', { exact: true }).first()).toBeVisible();
});

test('a compact cart validates a custom split and supports editing and removing items', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a cart', exact: true }).click();
  await page.getByRole('textbox', { name: 'Cart name', exact: true }).fill('Saturday groceries');
  await page.getByRole('button', { name: 'Create cart', exact: true }).click();
  await expect(page.getByText('Saturday groceries', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Use dark mode', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use light mode', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  await page.getByRole('textbox', { name: 'Item name', exact: true }).fill('Breakfast groceries');
  await page.getByRole('textbox', { name: 'Unit price', exact: true }).fill('24.75');
  await page.getByRole('button', { name: 'Save item', exact: true }).click();

  await page.getByRole('button', { name: 'Allocate Breakfast groceries', exact: true }).click();
  await page.getByRole('button', { name: 'Custom', exact: true }).click();
  await page.getByRole('textbox', { name: 'Alex amount', exact: true }).fill('10.00');
  await expect(page.getByRole('button', { name: 'Save allocation', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Jordan amount', exact: true }).fill('9.50');
  await page.getByRole('textbox', { name: 'Sam amount', exact: true }).fill('5.25');
  await page.getByRole('button', { name: 'Save allocation', exact: true }).click();
  await expect(page.getByText('$5.25', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Edit Breakfast groceries', exact: true }).click();
  await page.getByRole('textbox', { name: 'Item name', exact: true }).fill('Breakfast supplies');
  await page.getByRole('button', { name: 'Save item', exact: true }).click();
  await expect(page.getByText('Breakfast supplies', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove Breakfast supplies', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await expect(page.getByTestId('item-row')).toHaveCount(0);
});

test('saving a stale editor preserves the latest item from another tab', async ({ page, context }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try Split', exact: true }).click();
  await expect(page).toHaveURL(/\/cart\/[^/?]+/);
  const second = await context.newPage();
  await second.goto(page.url());
  await expect(page.getByText('Live', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Edit Studio desk lamp', exact: true }).click();
  await page.getByRole('textbox', { name: 'Item name', exact: true }).fill('New lamp name');
  await second.getByRole('button', { name: 'Increase quantity of Studio desk lamp', exact: true }).click();
  const lamp = page.getByTestId('item-row').filter({ hasText: 'Studio desk lamp' });
  await expect(lamp.getByText('$99.98', { exact: true })).toHaveCount(1);

  await page.getByRole('button', { name: 'Save item', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: /changed in another tab/i })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(lamp.getByText('$99.98', { exact: true })).toBeVisible();
  await expect(second.getByText('New lamp name', { exact: true })).toHaveCount(0);
});
