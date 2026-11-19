export type Mode = 'owner' | 'equal' | 'custom';
export type Participant = { id: string; name: string; color: string };
export type Item = {
  id?: string;
  name: string;
  unitCents: number;
  quantity: number;
  category: string;
  mode: Mode;
  members: string[];
  shares: Record<string, number>;
  allocations?: Record<string, number>;
};
export type Cart = {
  id: string;
  name: string;
  demo: boolean;
  version: number;
  participants: Participant[];
  items: Item[];
  totalCents: number;
  totals: Record<string, number>;
  completedAt?: string;
  activity?: { actor: string; text: string };
};
export type Change = {
  version?: number;
  action: 'upsert' | 'remove' | 'checkout' | 'reset';
  item?: Item;
  itemId?: string;
};

export function dollars(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export function parseCents(input: string): number | null {
  const parts = /^(\d{0,9})(?:\.(\d{0,2}))?$/.exec(input.trim());
  return parts && (parts[1] || parts[2]) ? Number(parts[1]) * 100 + Number((parts[2] ?? '').padEnd(2, '0')) : null;
}

export function previewAllocation(total: number, people: Participant[], item: Item) {
  if (item.mode === 'custom') return item.shares ?? {};
  const selected = people.filter(person => item.members.includes(person.id));
  if (selected.length === 0) return {};
  return Object.fromEntries(selected.map((person, index) => [
    person.id,
    Math.floor(total / selected.length) + (index < total % selected.length ? 1 : 0),
  ]));
}



export function reprice(item: Item, unitCents: number, quantity: number): Item {
  if (item.mode !== 'custom') return { ...item, unitCents, quantity };
  const before = BigInt(item.unitCents * item.quantity);
  const after = BigInt(unitCents * quantity);
  if (before === after || before === 0n) return { ...item, unitCents, quantity };
  const fractions = Object.entries(item.shares ?? {}).map(([id, cents]) => ({
    id,
    cents: BigInt(cents) * after / before,
    remainder: BigInt(cents) * after % before,
  })).sort((a, b) => a.remainder === b.remainder ? (a.id < b.id ? -1 : 1) : a.remainder > b.remainder ? -1 : 1);
  const undistributed = Number(after - fractions.reduce((sum, share) => sum + share.cents, 0n));
  const shares = Object.fromEntries(fractions.map((share, index) => [share.id, Number(share.cents) + (index < undistributed ? 1 : 0)]));
  return { ...item, unitCents, quantity, shares };
}

export function latestCart(current: Cart | undefined, incoming: Cart): Cart {
  return current && current.version >= incoming.version ? current : incoming;
}
