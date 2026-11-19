import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestCart, parseCents, previewAllocation, reprice } from '../src/model.ts';

const people = ['alex', 'jordan', 'sam'].map(id => ({ id, name: id, color: '' }));

test('money fields parse decimal cents exactly and reject malformed amounts', () => {
  assert.equal(parseCents(' 28.50 '), 2850);
  assert.equal(parseCents('0.3'), 30);
  assert.equal(parseCents('.75'), 75);
  assert.equal(parseCents('0'), 0);
  assert.equal(parseCents('999000000.00'), 99900000000);
  for (const invalid of ['-1.00', '1.500', '', '$20', '1e2', '1000000000']) {
    assert.equal(parseCents(invalid), null);
  }
});

test('equal allocation previews distribute the remainder in participant order', () => {
  assert.deepEqual(previewAllocation(1000, people, {
    mode: 'equal', members: ['sam', 'jordan', 'alex'],
  }), { alex: 334, jordan: 333, sam: 333 });
  assert.deepEqual(previewAllocation(1000, people, {
    mode: 'owner', members: ['sam'],
  }), { sam: 1000 });
});

test('changing the quantity preserves the relative custom shares and total', () => {
  const updated = reprice({
    unitCents: 10, quantity: 3, mode: 'custom', shares: { alex: 14, jordan: 10, sam: 6 },
  }, 10, 2);
  assert.deepEqual(updated.shares, { jordan: 7, alex: 9, sam: 4 });
  assert.equal(Object.values(updated.shares).reduce((sum, cents) => sum + cents), 20);
});

test('custom repricing keeps cents exact for the maximum supported quantity and unit price', () => {
  const updated = reprice({
    unitCents: 99_999_999, quantity: 998, mode: 'custom',
    shares: { alex: 70_900_000_000, jordan: 28_899_999_002 },
  }, 100_000_000, 999);
  assert.equal(Object.values(updated.shares).reduce((sum, cents) => sum + cents), 99_900_000_000);
});

test('late snapshots cannot replace a newer cart', () => {
  const current = { version: 12 };
  assert.equal(latestCart(current, { version: 11 }), current);
  assert.equal(latestCart(current, { version: 12 }), current);
  assert.deepEqual(latestCart(current, { version: 13 }), { version: 13 });
});
