import { useState } from 'react';
import Head from 'expo-router/head';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Image, ScrollView, View, useWindowDimensions } from 'react-native';
import { Plus, ShoppingBag, Users } from '../src/icons';
import { cartKey, createCart } from '../src/api';
import { useAuth } from '../src/auth';
import { HeaderControls } from '../src/account-ui';
import { AvatarStack, Brand, Button, Copy, Field, Notice, Panel, Price, Sheet, useTheme } from '../src/ui';

const people = [
  { id: 'alex', name: 'Alex', color: '#D7C2F4' },
  { id: 'jordan', name: 'Jordan', color: '#B8E0D8' },
  { id: 'sam', name: 'Sam', color: '#F8CBA9' },
];
const preview = [
  { name: 'Studio desk lamp', note: 'Lighting', price: '$49.99', image: require('../assets/products/lamp.jpg') },
  { name: 'Pour-over coffee maker', note: 'Kitchen', price: '$64.95', image: require('../assets/products/coffee.jpg') },
  { name: 'Woven storage basket', note: 'Organization / 2 units', price: '$48.00', image: require('../assets/products/storage.jpg') },
];

export default function Landing() {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const compact = width < 820;
  const router = useRouter();
  const cache = useQueryClient();
  const auth = useAuth();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function open(demo: boolean) {
    setBusy(true);
    setError('');
    try {
      const cart = await createCart(demo, name.trim());
      cache.setQueryData(cartKey(cart.id, auth.user?.id), cart);
      router.push({ pathname: '/cart/[id]', params: { id: cart.id } });
      setShowCreate(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not create a cart.');
    } finally {
      setBusy(false);
    }
  }

  return <View style={{ flex: 1, backgroundColor: colors.background }}>
    <Head><title>Split | Shopping is better together</title></Head>
    <View style={{ zIndex: 1, borderBottomWidth: 1, borderColor: colors.border }}>
      <View style={{ width: '100%', maxWidth: 1192, alignSelf: 'center', paddingHorizontal: 22, height: 66, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Brand />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {auth.enabled && <Button label={auth.user ? 'My carts' : 'Sign in'} compact variant="quiet"
            disabled={auth.pending} onPress={() => router.push(auth.user ? '/my-carts' : '/sign-in')} />}
          <HeaderControls />
        </View>
      </View>
    </View>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }}>
    <View style={{
      width: '100%', maxWidth: 1192, alignSelf: 'center', paddingHorizontal: 22, paddingVertical: compact ? 48 : 86,
      flexDirection: compact ? 'column' : 'row', alignItems: compact ? 'stretch' : 'center', gap: compact ? 32 : 74,
    }}>
      <View style={{ flex: 1, gap: 22 }}>
        <View style={{ flexDirection: 'row', gap: 7, alignItems: 'center', alignSelf: 'flex-start', backgroundColor: colors.tint, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 30 }}>
          <Users color={colors.accent} size={14} strokeWidth={1.8} />
          <Copy size={13} color={colors.accent} weight="600">Shared shopping</Copy>
        </View>
        <Copy size={compact ? 51 : 76} weight="800" heading style={{ lineHeight: compact ? 53 : 77, letterSpacing: compact ? -3.5 : -5.7 }}>
          Shopping is <Copy size={compact ? 51 : 76} weight="800" color={colors.accent} style={{ lineHeight: compact ? 53 : 77, letterSpacing: compact ? -3.5 : -5.7 }}>better together.</Copy>
        </Copy>
        <Copy size={18} muted style={{ maxWidth: 345, lineHeight: 27 }}>
          Build a shared cart, split the cost, and check out together.
        </Copy>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingTop: 4 }}>
          <Button label="Try Split" icon={ShoppingBag} onPress={() => void open(true)} busy={busy && !showCreate} />
          <Button label="Create a cart" icon={Plus} variant="secondary" onPress={() => { setError(''); setShowCreate(true); }} disabled={busy} />
        </View>
        {!showCreate && !!error && <Notice>{error}</Notice>}
      </View>
      <View style={{ width: compact ? '100%' : '46%', backgroundColor: colors.tint, borderRadius: 29, padding: compact ? 13 : 24 }}>
        <Panel style={{ paddingHorizontal: compact ? 15 : 21, paddingTop: 18, paddingBottom: 14 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 6, marginBottom: 17 }}>
            <Copy weight="700" size={20} style={{ letterSpacing: -0.65 }}>Apartment Essentials</Copy>
            <AvatarStack people={people} size={25} />
          </View>
          {preview.map(product => <View key={product.name} style={{ borderTopWidth: 1, borderColor: colors.border, paddingVertical: 11, gap: 10, flexDirection: 'row', alignItems: 'center' }}>
            <Image source={product.image} style={{ width: 45, height: 45, borderRadius: 9, backgroundColor: colors.soft }} />
            <View style={{ flex: 1, gap: 3 }}>
              <Copy weight="600" size={14}>{product.name}</Copy>
              <Copy size={12} muted>{product.note}</Copy>
            </View>
            <Price size={14}>{product.price}</Price>
          </View>)}
          <View style={{ borderRadius: 12, padding: 13, marginTop: 4, backgroundColor: colors.soft, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Copy muted weight="600" size={13}>Group total (5 items)</Copy><Price size={19}>$287.94</Price>
          </View>
        </Panel>
      </View>
    </View>
    <View style={{ marginTop: 'auto', borderTopWidth: 1, borderColor: colors.border, padding: 20, alignItems: 'center' }}>
      <Copy muted size={13}>One cart. Multiple people. Zero awkward math.</Copy>
    </View>
    {showCreate && <Sheet title="Create a cart" onClose={() => { if (!busy) setShowCreate(false); }}>
      <Field label="Cart name" value={name} onChangeText={setName} placeholder="Weekend groceries" maxLength={80}
        onSubmitEditing={() => { if (name.trim() && !busy) void open(false); }} />
      {!!error && <Notice>{error}</Notice>}
      <Button label="Create cart" disabled={!name.trim()} busy={busy} onPress={() => void open(false)} />
    </Sheet>}
    </ScrollView>
  </View>;
}
