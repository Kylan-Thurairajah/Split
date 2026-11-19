import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Pressable, View } from 'react-native';
import { CircleCheck, Package, Plus } from './icons';
import { dollars, parseCents, previewAllocation, reprice } from './model';
import type { Cart, Item, Mode, Participant } from './model';
import { Avatar, Button, Copy, Field, Notice, Price, Sheet, useTheme } from './ui';

export const categoryLabels: Record<string, string> = {
  lamp: 'Lighting', coffee: 'Kitchen', storage: 'Organization', rug: 'Decor', kitchen: 'Kitchen', other: 'General',
};

export function useReducedMotion() {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (active) setReduced(value); });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => { active = false; subscription.remove(); };
  }, []);
  return reduced;
}

function Segment({ fraction, color, reduced }: { fraction: number; color: string; reduced: boolean }) {
  const width = useRef(new Animated.Value(fraction)).current;
  useEffect(() => {
    if (reduced) { width.setValue(fraction); return; }
    const animation = Animated.timing(width, { toValue: fraction, duration: 205, useNativeDriver: false });
    animation.start();
    return () => animation.stop();
  }, [fraction, reduced, width]);
  return <Animated.View style={{ width: width.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }), height: '100%', backgroundColor: color }} />;
}

export function AllocationBar({ people, amounts, total, height = 9 }: {
  people: Participant[]; amounts: Record<string, number>; total: number; height?: number;
}) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  return <View style={{ height, width: '100%', flexDirection: 'row', overflow: 'hidden', borderRadius: 10, backgroundColor: colors.soft }}>
    {people.map(person => <Segment key={person.id} color={person.color} reduced={reduced}
      fraction={total > 0 ? Math.min(1, (amounts[person.id] ?? 0) / total) : 0} />)}
  </View>;
}

type EditorProps = { busy: boolean; error: string; onClose: () => void; onSave: (item: Item) => void };

export function ItemEditor({ item, actor, busy, error, onClose, onSave }: EditorProps & { item?: Item; actor: string }) {
  const [name, setName] = useState(item?.name ?? '');
  const [price, setPrice] = useState(item ? (item.unitCents / 100).toFixed(2) : '');
  const [quantity, setQuantity] = useState(String(item?.quantity ?? 1));
  const cents = parseCents(price);
  const count = /^\d{1,3}$/.test(quantity.trim()) ? Number(quantity) : 0;
  const valid = !!name.trim() && cents !== null && cents > 0 && cents <= 100_000_000 && count >= 1 && count <= 999;

  return <Sheet title={item ? 'Edit item' : 'Add item'} onClose={onClose}>
    <Field label="Item name" placeholder="e.g. Dinner plates" autoFocus value={name} maxLength={100} onChangeText={setName} />
    <View style={{ flexDirection: 'row', gap: 12 }}>
      <View style={{ flex: 1 }}><Field label="Unit price" placeholder="0.00" keyboardType="decimal-pad" value={price} onChangeText={setPrice} /></View>
      <View style={{ width: 110 }}><Field label="Quantity" keyboardType="number-pad" value={quantity} onChangeText={setQuantity} /></View>
    </View>
    {item?.mode === 'custom' && <Copy muted size={13}>Custom shares adjust proportionally when the item total changes.</Copy>}
    {!!error && <Notice>{error}</Notice>}
    <Button label="Save item" icon={item ? CircleCheck : Plus} disabled={!valid} busy={busy} onPress={() => {
      if (!valid || cents === null) return;
      const draft = item ? reprice(item, cents, count) : {
        unitCents: cents, quantity: count, category: 'other', mode: 'owner' as const, members: [actor], shares: {},
      };
      onSave({ ...draft, name: name.trim() });
    }} />
  </Sheet>;
}

const methods: { mode: Mode; text: string }[] = [
  { mode: 'owner', text: 'Assign' }, { mode: 'equal', text: 'Split equally' }, { mode: 'custom', text: 'Custom' },
];

export function AllocationEditor({ item, cart, actor, busy, error, onClose, onSave }: EditorProps & {
  item: Item; cart: Cart; actor: string;
}) {
  const { colors } = useTheme();
  const [mode, setMode] = useState<Mode>(item.mode);
  const [members, setMembers] = useState(item.members?.length ? item.members : [actor]);
  const [inputs, setInputs] = useState<Record<string, string>>(() => Object.fromEntries(cart.participants.map(person => [
    person.id, ((item.allocations?.[person.id] ?? 0) / 100).toFixed(2),
  ])));
  const total = item.unitCents * item.quantity;
  const values = cart.participants.map(person => [person.id, parseCents(inputs[person.id] ?? '')] as const);
  const shares = Object.fromEntries(values.map(([id, cents]) => [id, cents ?? 0]));
  const draft = { ...item, mode, members: mode === 'custom' ? [] : members, shares: mode === 'custom' ? shares : {} };
  const amounts = previewAllocation(total, cart.participants, draft);
  const distributed = Object.values(amounts).reduce((sum, amount) => sum + amount, 0);
  const valid = mode === 'custom' ? values.every(([, value]) => value !== null) && distributed === total : members.length > 0;
  const difference = total - distributed;

  function select(next: Mode) {
    if (next === mode) return;
    if (next === 'owner') setMembers([members[0] ?? actor]);
    if (next === 'equal') setMembers(cart.participants.map(person => person.id));
    if (next === 'custom') {
      setInputs(Object.fromEntries(cart.participants.map(person => [person.id, ((amounts[person.id] ?? 0) / 100).toFixed(2)])));
    }
    setMode(next);
  }

  return <Sheet title="Allocate item" onClose={onClose}>
    <View style={{ padding: 13, backgroundColor: colors.soft, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <Package size={18} color={colors.accent} />
      <Copy weight="700" style={{ flex: 1 }}>{item.name}</Copy>
      <Price>{dollars(total)}</Price>
    </View>
    <View style={{ flexDirection: 'row', gap: 3, padding: 4, backgroundColor: colors.soft, borderRadius: 12 }}>
      {methods.map(method => <Pressable key={method.mode} accessibilityRole="button" accessibilityState={{ selected: mode === method.mode }}
        onPress={() => select(method.mode)} style={{
          flex: 1, minHeight: 36, borderRadius: 8, justifyContent: 'center', alignItems: 'center',
          backgroundColor: mode === method.mode ? colors.surface : 'transparent',
        }}><Copy size={13} weight="700" color={mode === method.mode ? colors.accent : colors.muted}>{method.text}</Copy></Pressable>)}
    </View>
    <View style={{ gap: 10 }}>
      {cart.participants.map(person => {
        const selected = members.includes(person.id);
        const toggle = () => setMembers(mode === 'owner' ? [person.id] : selected ? members.filter(id => id !== person.id) : [...members, person.id]);
        return <View key={person.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 42 }}>
          {mode === 'custom' ? <>
            <Avatar person={person} size={32} /><Copy weight="600" style={{ flex: 1 }}>{person.name}</Copy>
            <View style={{ width: 128 }}><Field label={person.name + ' amount'} value={inputs[person.id] ?? ''}
              onChangeText={text => setInputs(previous => ({ ...previous, [person.id]: text }))} keyboardType="decimal-pad" /></View>
          </> : <Pressable accessibilityRole={mode === 'owner' ? 'radio' : 'checkbox'}
            accessibilityState={{ checked: selected }} accessibilityLabel={person.name} onPress={toggle}
            style={{ flex: 1, flexDirection: 'row', gap: 10, alignItems: 'center', padding: 8, borderRadius: 10, backgroundColor: selected ? colors.tint : colors.background }}>
            <Avatar person={person} size={28} /><Copy weight="600" style={{ flex: 1 }}>{person.name}</Copy>
            <Price>{dollars(amounts[person.id] ?? 0)}</Price>
            <View style={{
              width: 17, height: 17, borderRadius: mode === 'owner' ? 10 : 4, borderWidth: 1,
              borderColor: selected ? colors.accent : colors.border, backgroundColor: selected ? colors.accent : colors.surface,
            }} />
          </Pressable>}
        </View>;
      })}
    </View>
    <View style={{ gap: 8 }}>
      <AllocationBar people={cart.participants} amounts={amounts} total={total} height={11} />
      <View accessibilityLiveRegion="polite">
        <Copy size={13} muted={valid} color={valid ? undefined : colors.danger}>
          {valid ? dollars(total) + ' allocated' : mode === 'custom' ?
            (difference === 0 ? 'Enter dollar amounts with up to two decimal places.' : dollars(Math.abs(difference)) + (difference > 0 ? ' left to allocate' : ' over the item total'))
            : 'Select at least one participant.'}
        </Copy>
      </View>
    </View>
    {!!error && <Notice>{error}</Notice>}
    <Button label="Save allocation" onPress={() => onSave(draft)} disabled={!valid} busy={busy} />
  </Sheet>;
}
