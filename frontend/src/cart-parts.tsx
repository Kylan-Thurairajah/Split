import { Image, Pressable, View } from 'react-native';
import { Minus, Package, Pencil, Plus, ScanLine, Trash2 } from './icons';
import { AllocationBar, categoryLabels } from './editors';
import { dollars } from './model';
import type { Cart, Item } from './model';
import { Avatar, AvatarStack, Copy, IconButton, Price, useTheme } from './ui';

const products: Record<string, number> = {
  lamp: require('../assets/products/lamp.jpg'),
  coffee: require('../assets/products/coffee.jpg'),
  storage: require('../assets/products/storage.jpg'),
  rug: require('../assets/products/rug.jpg'),
  kitchen: require('../assets/products/kitchen.jpg'),
};

function ProductImage({ category }: { category: string }) {
  const { colors } = useTheme();
  if (products[category]) return <Image source={products[category]} style={{ width: 52, height: 52, borderRadius: 10, backgroundColor: colors.soft }} />;
  return <View style={{ width: 52, height: 52, backgroundColor: colors.tint, borderRadius: 10, alignItems: 'center', justifyContent: 'center' }}>
    <Package size={22} color={colors.accent} strokeWidth={1.6} />
  </View>;
}

export function ItemRow({ item, cart, compact, busy, onEdit, onRemove, onAllocate, onQuantity }: {
  item: Item; cart: Cart; compact: boolean; busy: boolean; onEdit: () => void; onRemove: () => void;
  onAllocate: () => void; onQuantity: (quantity: number) => void;
}) {
  const { colors } = useTheme();
  const people = cart.participants.filter(person => item.mode === 'custom' ?
    (item.allocations?.[person.id] ?? 0) > 0 : item.members?.includes(person.id));
  const title = item.mode === 'owner' ? people[0]?.name ?? 'Assign' : item.mode === 'equal' ?
    (people.length === cart.participants.length ? 'Everyone' : 'Equal split') : 'Custom split';
  const actions = <View style={{ flexDirection: 'row', alignItems: 'center', gap: 1 }}>
    <IconButton label={'Edit ' + item.name} icon={Pencil} onPress={onEdit} disabled={busy} size={29} />
    <IconButton label={'Remove ' + item.name} icon={Trash2} onPress={onRemove} disabled={busy} size={29} />
  </View>;

  return <View testID="item-row" style={{
    paddingHorizontal: compact ? 12 : 19, paddingVertical: compact ? 12 : 13,
    borderTopWidth: 1, borderColor: colors.border, gap: 10,
    flexDirection: compact ? 'column' : 'row', alignItems: compact ? 'stretch' : 'center',
  }}>
    <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 11 }}>
      <ProductImage category={item.category} />
      <View style={{ flex: 1, gap: 3 }}>
        <Copy weight="700" size={15} style={{ overflowWrap: 'anywhere' } as never}>{item.name}</Copy>
        <Copy muted size={12}>{(categoryLabels[item.category] ?? categoryLabels.other) + ' / ' + dollars(item.unitCents) + ' each'}</Copy>
      </View>
      {compact && actions}
    </View>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: compact ? 6 : 13, marginLeft: compact ? 62 : 0 }}>
      <Pressable key={item.mode + people.map(person => person.id).join()} testID="allocation-badge"
        accessibilityRole="button" accessibilityLabel={'Allocate ' + item.name} onPress={onAllocate} disabled={busy}
        style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
          paddingHorizontal: 6, paddingVertical: 4, borderRadius: 20, flexDirection: 'row', alignItems: 'center', gap: 4,
          backgroundColor: pressed || hovered ? colors.tint : colors.soft, opacity: busy ? 0.55 : 1,
        })}>
        <AvatarStack people={people} size={16} />
        {!compact && <Copy weight="600" size={12}>{title}</Copy>}
      </Pressable>
      <View style={{ flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: 9 }}>
        <IconButton label={'Decrease quantity of ' + item.name} icon={Minus} disabled={busy || item.quantity <= 1}
          onPress={() => onQuantity(item.quantity - 1)} size={27} />
        <Copy size={13} weight="600" style={{ minWidth: 16, textAlign: 'center', fontVariant: ['tabular-nums'] }}>{item.quantity}</Copy>
        <IconButton label={'Increase quantity of ' + item.name} icon={Plus} disabled={busy || item.quantity >= 999}
          onPress={() => onQuantity(item.quantity + 1)} size={27} />
      </View>
      <View style={{ minWidth: compact ? 58 : 71, alignItems: 'flex-end', marginLeft: compact ? 'auto' : 0 }}>
        <Price size={14}>{dollars(item.unitCents * item.quantity)}</Price>
      </View>
      {!compact && actions}
    </View>
  </View>;
}

export function Breakdown({ cart, actor, interactive, onSelect }: {
  cart: Cart; actor?: string; interactive?: boolean; onSelect?: (id: string) => void;
}) {
  const { colors } = useTheme();
  return <View style={{ gap: 11 }}>
    {cart.participants.map(person => {
      const line = <><Avatar person={person} size={33} /><View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Copy size={14} weight="600">{person.name}</Copy>
        {actor === person.id && <Copy color={colors.accent} size={12} weight="600">(you)</Copy>}
      </View><Price size={14}>{dollars(cart.totals[person.id] ?? 0)}</Price></>;
      const style = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 9, minHeight: 35, borderRadius: 9 };
      return interactive ?
        <Pressable key={person.id} accessibilityRole="button" accessibilityLabel={'View as ' + person.name} accessibilityState={{ selected: actor === person.id }}
          onPress={() => onSelect?.(person.id)} style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({ ...style, backgroundColor: pressed || hovered ? colors.tint : 'transparent' })}>{line}</Pressable>
        : <View key={person.id} style={style}>{line}</View>;
    })}
  </View>;
}

export function ReceiptItems({ cart }: { cart: Cart }) {
  const { colors } = useTheme();
  return <View style={{ gap: 15 }}>
    {cart.items.map(item => <View key={item.id} style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <Copy weight="600" style={{ flexShrink: 1 }}>{item.name + ' × ' + item.quantity}</Copy>
        <Price size={14}>{dollars(item.unitCents * item.quantity)}</Price>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {cart.participants.filter(person => (item.allocations?.[person.id] ?? 0) > 0).map(person =>
          <View key={person.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, padding: 4, paddingRight: 7, borderRadius: 20, backgroundColor: colors.soft }}>
            <Avatar person={person} size={17} /><Copy size={12} muted>{person.name + ' ' + dollars(item.allocations![person.id])}</Copy>
          </View>)}
      </View>
    </View>)}
  </View>;
}

export function Readiness({ cart }: { cart: Cart }) {
  const { colors } = useTheme();
  const allocated = Object.values(cart.totals).reduce((sum, value) => sum + value, 0);
  const ready = cart.items.length > 0 && allocated === cart.totalCents;
  return <View style={{ gap: 8 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
      <ScanLine size={15} color={ready ? colors.green : colors.muted} />
      <Copy size={13} weight="600" color={ready ? colors.green : colors.muted}>{ready ? 'Ready for checkout' : 'Add items to check out'}</Copy>
    </View>
    <AllocationBar people={cart.participants} amounts={cart.totals} total={cart.totalCents} height={7} />
  </View>;
}
