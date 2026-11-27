import { useState } from 'react';
import { Redirect, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pressable, View } from 'react-native';
import { AccountLoading, AccountPage } from '../src/account-ui';
import { cartKey, cartsKey, createCart, loadCarts, useProfile } from '../src/api';
import { useAuth } from '../src/auth';
import { Plus, ReceiptText, ShoppingBag } from '../src/icons';
import type { Cart } from '../src/model';
import { dollars } from '../src/model';
import { Button, Copy, Field, Notice, Panel, Price, Sheet, useTheme } from '../src/ui';

function CartList({ title, carts, open }: { title: string; carts: Cart[]; open: (id: string) => void }) {
  const { colors } = useTheme();
  return <Panel style={{ padding: 16, gap: 12 }}>
    <Copy heading size={18} weight="700">{title}</Copy>
    {!carts.length && <Copy muted>{title === 'Active' ? 'No active carts yet.' : 'No completed carts yet.'}</Copy>}
    {carts.map(cart => <Pressable key={cart.id} accessibilityRole="link" accessibilityLabel={cart.name}
      onPress={() => open(cart.id)} style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 11, padding: 9, borderRadius: 10,
        backgroundColor: pressed || hovered ? colors.tint : colors.soft,
      })}>
      {cart.completedAt ? <ReceiptText size={20} color={colors.accent} /> : <ShoppingBag size={20} color={colors.accent} />}
      <View style={{ flex: 1, gap: 2 }}>
        <Copy weight="700">{cart.name}</Copy>
        <Copy muted size={12}>{cart.access === 'owner' ? 'Owner' : 'Member'}</Copy>
      </View>
      <Price>{dollars(cart.totalCents)}</Price>
    </Pressable>)}
  </Panel>;
}

export default function MyCartsPage() {
  const auth = useAuth();
  const router = useRouter();
  const cache = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const account = auth.user?.id;
  const profile = useProfile();
  const list = useQuery({ queryKey: cartsKey(account), queryFn: ({ signal }) => loadCarts(signal), enabled: !!account, retry: false });
  const open = (id: string) => router.push({ pathname: '/cart/[id]', params: { id } });

  async function create() {
    if (!name.trim() || creating) return;
    setCreating(true);
    setError('');
    try {
      const cart = await createCart(false, name.trim(), true);
      cache.setQueryData(cartKey(cart.id, account), cart);
      void cache.invalidateQueries({ queryKey: cartsKey(account) });
      setShowCreate(false);
      open(cart.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Split could not create your cart.');
    } finally {
      setCreating(false);
    }
  }

  if (!auth.user && auth.enabled && !auth.pending && !auth.error) return <Redirect href="/sign-in" />;

  return <AccountPage title="My carts" wide>
    {!auth.enabled ? <Notice>Accounts are unavailable in this environment. You can still try the demo.</Notice> :
      auth.pending && !auth.user ? <AccountLoading /> :
      auth.error && !auth.user ? <><Notice>{auth.error}</Notice><Button label="Try again" onPress={auth.retry} /></> :
      <>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          <View style={{ gap: 4 }}>
            <Copy heading size={36} weight="800">My carts</Copy>
            <Copy muted>{profile.data?.name || auth.user?.name || auth.user?.email}</Copy>
          </View>
          <Button label="New private cart" icon={Plus} onPress={() => { setName(''); setError(''); setShowCreate(true); }} />
        </View>
        {!showCreate && !!error && <Notice>{error}</Notice>}
        {list.isPending ? <AccountLoading /> : list.error ? <>
          <Notice>{list.error.message}</Notice><Button label="Try again" variant="secondary" onPress={() => void list.refetch()} />
        </> : <>
          <CartList title="Active" carts={(list.data ?? []).filter(cart => !cart.completedAt)} open={open} />
          <CartList title="Completed" carts={(list.data ?? []).filter(cart => !!cart.completedAt)} open={open} />
        </>}
        {showCreate && <Sheet title="New private cart" onClose={() => { if (!creating) setShowCreate(false); }}>
          <Field label="Cart name" value={name} onChangeText={setName} maxLength={80} onSubmitEditing={() => void create()} autoFocus />
          {!!error && <Notice>{error}</Notice>}
          <Button label="Create private cart" disabled={!name.trim()} busy={creating} onPress={() => void create()} />
        </Sheet>}
      </>}
  </AccountPage>;
}
