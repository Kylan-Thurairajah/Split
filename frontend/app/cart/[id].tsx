import { useEffect, useState } from 'react';
import Head from 'expo-router/head';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, ScrollView, View, useWindowDimensions } from 'react-native';
import { ArrowLeft, Check, Clipboard, Link2, Plus, ReceiptText, RotateCcw, ShoppingBag } from '../../src/icons';
import { APIError, useCart } from '../../src/api';
import { useAuth } from '../../src/auth';
import { CartActivity, InviteManager } from '../../src/cart-sharing';
import { Breakdown, ItemRow, Readiness, ReceiptItems } from '../../src/cart-parts';
import { AllocationBar, AllocationEditor, ItemEditor, useReducedMotion } from '../../src/editors';
import { activityText, dollars, receiptText, reprice } from '../../src/model';
import type { Cart, Change, Item } from '../../src/model';
import { Avatar, AvatarStack, Brand, Button, Copy, IconButton, Notice, Panel, Price, Sheet, ThemeButton, useTheme } from '../../src/ui';

type Dialog = { kind: 'item'; item?: Item; version: number } | { kind: 'allocate'; item: Item; version: number } |
  { kind: 'remove'; item: Item; version: number } | { kind: 'reset' } | { kind: 'share' } | { kind: 'invite' };

function Live({ active }: { active: boolean }) {
  const { colors } = useTheme();
  return <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
    <View style={{ width: 7, height: 7, borderRadius: 8, backgroundColor: active ? colors.green : colors.muted }} />
    <Copy size={12} weight="600" color={active ? colors.green : colors.muted}>{active ? 'Live' : 'Connecting'}</Copy>
  </View>;
}

function Summary({ cart, actor, onSelect, onCheckout, compact }: {
  cart: Cart; actor: string; onSelect: (id: string) => void; onCheckout: () => void; compact: boolean;
}) {
  const { colors } = useTheme();
  return <Panel style={{ overflow: 'hidden' }}>
    <View style={{ backgroundColor: colors.tint, padding: 19, gap: 15 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Copy heading size={17} weight="700">Cart summary</Copy>
        <ShoppingBag size={19} strokeWidth={1.7} color={colors.accent} />
      </View>
      <View style={{ gap: 4 }}>
        <Copy size={13} muted>Group total</Copy>
        <Price size={38}>{dollars(cart.totalCents)}</Price>
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderTopWidth: 1, borderColor: colors.border, paddingTop: 12 }}>
        <Copy color={colors.accent} size={14} weight="700">Your share</Copy>
        <Price color={colors.accent} size={20}>{dollars(cart.totals[actor] ?? 0)}</Price>
      </View>
    </View>
    <View style={{ padding: 18, gap: 16 }}>
      <View style={{ gap: 4 }}>
        <Copy size={15} weight="700" heading>Participants</Copy>
        {!cart.access && <Copy size={12} muted>Select a name to switch perspective.</Copy>}
      </View>
      <Breakdown cart={cart} actor={actor} interactive={!cart.access} onSelect={onSelect} />
      <View style={{ borderTopWidth: 1, paddingTop: 15, borderColor: colors.border }}><Readiness cart={cart} /></View>
      {!compact && <Button label="Review checkout" disabled={cart.items.length === 0} onPress={onCheckout} />}
    </View>
  </Panel>;
}

function CartDocument({ cart, receipt, actor, pending, error, back, confirm, reset }: {
  cart: Cart; receipt: boolean; actor: string; pending: boolean; error: string; back: () => void;
  confirm: () => void; reset: () => void;
}) {
  const { colors } = useTheme();
  function downloadReceipt() {
    const url = URL.createObjectURL(new Blob([receiptText(cart)], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'split-receipt.txt';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <View style={{ width: '100%', maxWidth: 603, alignSelf: 'center', paddingHorizontal: 16, paddingVertical: 26, gap: 13 }}>
    {!receipt && <Button label="Back to cart" icon={ArrowLeft} variant="quiet" compact onPress={back} style={{ alignSelf: 'flex-start' }} />}
    <Panel style={{ overflow: 'hidden' }}>
      <View style={{ alignItems: 'center', backgroundColor: colors.tint, paddingHorizontal: 16, paddingVertical: 25, gap: 6 }}>
        <View testID={receipt ? 'checkout-success' : undefined} style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: colors.surface, marginBottom: 5 }}>
          {receipt ? <Check size={25} color={colors.green} /> : <ReceiptText size={24} color={colors.accent} strokeWidth={1.7} />}
        </View>
        <Copy size={31} weight="800" heading style={{ letterSpacing: -1.1, textAlign: 'center' }}>{receipt ? (cart.demo ? 'Demo checkout complete' : 'Checkout complete') : 'Review checkout'}</Copy>
        <Copy size={15} muted>{cart.name}</Copy>
        {receipt && !!cart.completedAt &&
          <Copy size={13} muted>{new Intl.DateTimeFormat('en-US', { dateStyle: 'long' }).format(new Date(cart.completedAt))}</Copy>}
      </View>
      <View style={{ paddingHorizontal: 20, paddingVertical: 21, gap: 19 }}>
        <Copy size={17} weight="700" heading>Items and allocations</Copy>
        <ReceiptItems cart={cart} />
        <View style={{ gap: 12, paddingTop: 15, borderTopWidth: 1, borderColor: colors.border }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Copy muted>Cart subtotal</Copy><Price>{dollars(cart.totalCents)}</Price></View>
          <Copy size={16} weight="700" heading>Participant totals</Copy>
          <Breakdown cart={cart} actor={actor} />
          <AllocationBar people={cart.participants} amounts={cart.totals} total={cart.totalCents} />
        </View>
        <View style={{ padding: 13, backgroundColor: colors.tint, borderRadius: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Copy size={16} weight="700">Group total</Copy><Price size={23}>{dollars(cart.totalCents)}</Price>
        </View>
        {!receipt && <Readiness cart={cart} />}
        {cart.demo && <Copy muted size={13}>This is a simulated checkout. No charge or order is created.</Copy>}
        {!!error && <Notice>{error}</Notice>}
        {receipt && typeof document !== 'undefined' &&
          <Button label="Download receipt" icon={ReceiptText} variant="secondary" onPress={downloadReceipt} />}
        {receipt ?
          <Button label={cart.demo ? 'Reset demo' : cart.access ? 'My carts' : 'Start a new cart'} icon={RotateCcw} onPress={cart.demo ? reset : back} /> :
          <Button label={cart.demo ? 'Confirm demo checkout' : 'Confirm checkout'} icon={Check} busy={pending} onPress={confirm} disabled={!cart.items.length} />}
      </View>
    </Panel>
  </View>;
}

export default function CartScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const compact = width < 880;
  const auth = useAuth();
  const [perspective, setActor] = useState('alex');
  const [dialog, setDialog] = useState<Dialog>();
  const [review, setReview] = useState(false);
  const [completion, setCompletion] = useState(false);
  const [copied, setCopied] = useState(false);
  const reduced = useReducedMotion();
  const { query, mutation, connected, cart } = useCart(id, perspective);
  const actor = cart?.actorId ?? perspective;
  const error = mutation.error?.message ?? '';
  const busy = mutation.isPending;
  const close = () => { if (!busy) { setDialog(undefined); mutation.reset(); } };

  useEffect(() => {
    if (!completion || !cart?.completedAt) return;
    const timer = setTimeout(() => setCompletion(false), reduced ? 0 : 430);
    return () => clearTimeout(timer);
  }, [cart?.completedAt, completion, reduced]);

  useEffect(() => {
    if (!cart?.completedAt) return;
    setReview(false);
    setDialog(previous => previous?.kind === 'share' || previous?.kind === 'reset' || previous?.kind === 'invite' ? previous : undefined);
  }, [cart?.completedAt]);

  function commit(change: Change, options: { close?: boolean; version?: number } = {}) {
    mutation.mutate({ ...change, version: options.version }, {
      onSuccess: () => { if (options.close) setDialog(undefined); if (change.action === 'reset') setReview(false); },
      onError: () => { if (change.action === 'checkout') setCompletion(false); },
    });
  }

  function enterReview() {
    mutation.reset();
    setReview(true);
  }

  if (!cart) return <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background, gap: 15, padding: 20 }}>
    <Brand onPress={() => router.replace('/')} />
    {query.isPending ? <ActivityIndicator color={colors.accent} /> : <>
      <Notice>{query.error instanceof APIError && [403, 404].includes(query.error.status) && auth.user
        ? 'This cart is unavailable. You may no longer have access.'
        : query.error?.message ?? 'This cart is unavailable.'}</Notice>
      {auth.enabled && !auth.user && query.error instanceof APIError && [401, 403, 404].includes(query.error.status) &&
        <Button label="Sign in" onPress={() => router.push({ pathname: '/sign-in', params: { cart: id } })} />}
      {auth.user && <Button label="My carts" variant="secondary" onPress={() => router.replace('/my-carts')} />}
      <Button label="Try again" onPress={() => void query.refetch()} />
      <Button label="Back to Split" variant="quiet" onPress={() => router.replace('/')} />
    </>}
  </View>;

  const activePerson = cart.participants.find(person => person.id === actor) ?? cart.participants[0];
  const activityPerson = cart.participants.find(person => person.id === cart.activity?.actor);
  const checkedOut = !!cart.completedAt;
  const isDocument = review || checkedOut;
  const shareURL = typeof window === 'undefined' ? '' : window.location.origin + '/cart/' + cart.id;

  return <View style={{ flex: 1, backgroundColor: colors.background }}>
    <Head><title>{cart.name + ' | Split'}</title></Head>
    <View style={{ borderBottomWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
      <View style={{
        width: '100%', maxWidth: 1192, alignSelf: 'center', paddingHorizontal: compact ? 14 : 22,
        height: 63, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: compact ? 10 : 18 }}>
          <Brand onPress={() => router.replace(cart.access ? '/my-carts' : '/')} />
          {!compact && <View style={{ height: 21, width: 1, backgroundColor: colors.border }} />}
          {!compact && <Copy muted size={13} weight="600">{cart.access ? 'Private cart' : 'Shared cart'}</Copy>}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: compact ? 5 : 11 }}>
          <Live active={connected} />
          {cart.access === 'owner' && <IconButton label="Invite collaborators" icon={Link2} onPress={() => setDialog({ kind: 'invite' })} />}
          {!cart.access && <IconButton label="Share cart" icon={Link2} onPress={() => { setCopied(false); setDialog({ kind: 'share' }); }} />}
          <ThemeButton />
          <Avatar person={activePerson} size={29} />
        </View>
      </View>
    </View>
    <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
      {completion ? <View accessibilityLiveRegion="polite" style={{ alignSelf: 'center', width: '100%', maxWidth: 498, padding: 20, marginTop: 50 }}>
        <Panel style={{ padding: 28, alignItems: 'center', gap: 16 }}>
          {checkedOut ? <View testID="checkout-success"><Check size={31} color={colors.green} /></View> : <ActivityIndicator size="large" color={colors.accent} />}
          <Copy heading size={24} weight="700">{checkedOut
            ? (cart.demo ? 'Demo checkout complete' : 'Checkout complete')
            : (cart.demo ? 'Completing demo checkout' : 'Completing checkout')}</Copy>
          <AllocationBar people={cart.participants} amounts={checkedOut ? cart.totals : { [cart.participants[0].id]: Math.round(cart.totalCents * 0.46) }} total={cart.totalCents} />
        </Panel>
      </View> : isDocument ? <CartDocument cart={cart} receipt={checkedOut} actor={actor} pending={busy} error={dialog ? '' : error}
        back={() => { if (checkedOut) router.replace(cart.access ? '/my-carts' : '/'); else { mutation.reset(); setReview(false); } }}
        reset={() => setDialog({ kind: 'reset' })}
        confirm={() => { setCompletion(true); commit({ action: 'checkout' }, { version: cart.version }); }} /> :
        <View style={{ width: '100%', maxWidth: 1192, alignSelf: 'center', paddingHorizontal: compact ? 14 : 22, paddingTop: compact ? 27 : 39, paddingBottom: 28, gap: 22 }}>
          <View style={{ gap: 9 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <Copy heading size={compact ? 33 : 48} weight="800" style={{ letterSpacing: compact ? -1.6 : -2.35, flexShrink: 1 }}>{cart.name}</Copy>
              {cart.demo && !compact && <Button label="Reset demo" icon={RotateCcw} compact variant="secondary" onPress={() => setDialog({ kind: 'reset' })} />}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <AvatarStack people={cart.participants} size={25} />
              <Copy muted size={13}>{cart.participants.map(person => person.name).join(', ')}</Copy>
            </View>
          </View>
          {!dialog && !!error && <Notice>{error}</Notice>}
          <View style={{ flexDirection: compact ? 'column' : 'row', alignItems: compact ? 'stretch' : 'flex-start', gap: compact ? 15 : 21 }}>
            <View style={{ flex: 1, minWidth: 0, gap: 13 }}>
              <Panel style={{ overflow: 'hidden' }}>
                <View style={{ padding: compact ? 13 : 17, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 7 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
                    <Copy heading size={19} weight="700">Cart items</Copy>
                    <Copy size={12} muted style={{ backgroundColor: colors.soft, borderRadius: 18, paddingVertical: 3, paddingHorizontal: 7 }}>{cart.items.length}</Copy>
                  </View>
                  <Button label="Add item" icon={Plus} compact onPress={() => { mutation.reset(); setDialog({ kind: 'item', version: cart.version }); }} disabled={busy || cart.items.length >= 100} />
                </View>
                {cart.items.length === 0 &&
                  <View style={{ borderTopWidth: 1, borderColor: colors.border, alignItems: 'center', gap: 10, padding: 28 }}>
                    <ShoppingBag size={24} color={colors.accent} /><Copy muted>Add the first item to your shared cart.</Copy>
                  </View>}
                {cart.items.map(item => <ItemRow key={item.id} item={item} cart={cart} compact={compact || width < 1040} busy={busy}
                  onEdit={() => { mutation.reset(); setDialog({ kind: 'item', item, version: cart.version }); }}
                  onRemove={() => { mutation.reset(); setDialog({ kind: 'remove', item, version: cart.version }); }}
                  onAllocate={() => { mutation.reset(); setDialog({ kind: 'allocate', item, version: cart.version }); }}
                  onQuantity={quantity => commit({ action: 'upsert', item: reprice(item, item.unitCents, quantity) }, { version: cart.version })} />)}
              </Panel>
              {cart.access && <CartActivity cart={cart} />}
              {!cart.access && !!cart.activity && <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 3 }}>
                {activityPerson && <Avatar person={activityPerson} size={21} />}
                <Copy size={13} muted>{(activityPerson ? activityPerson.name + ' ' : '') + activityText(cart, cart.activity.text)}</Copy>
              </View>}
            </View>
            <View style={{ width: compact ? '100%' : 316 }}>
              <Summary cart={cart} actor={actor} onSelect={setActor} onCheckout={enterReview} compact={compact} />
            </View>
          </View>
          {cart.demo && compact && <Button label="Reset demo" icon={RotateCcw} variant="quiet" onPress={() => setDialog({ kind: 'reset' })} />}
        </View>}
    </ScrollView>
    {compact && !isDocument && <View style={{
      borderTopWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, paddingHorizontal: 14,
      paddingVertical: 8, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10,
    }}>
      <View><Copy muted size={12}>Group total</Copy><Price size={17}>{dollars(cart.totalCents)}</Price></View>
      <Button label="Review checkout" disabled={!cart.items.length} onPress={enterReview} />
    </View>}
    {dialog?.kind === 'item' && !checkedOut && <ItemEditor item={dialog.item} actor={actor} busy={busy} error={error} onClose={close}
      onSave={item => commit({ action: 'upsert', item }, { close: true, version: dialog.version })} />}
    {dialog?.kind === 'allocate' && !checkedOut && <AllocationEditor item={dialog.item} cart={cart} actor={actor} busy={busy} error={error} onClose={close}
      onSave={item => commit({ action: 'upsert', item }, { close: true, version: dialog.version })} />}
    {dialog?.kind === 'remove' && !checkedOut && <Sheet title="Remove item?" onClose={close}>
      <Copy muted>{dialog.item.name + ' will be removed for everyone.'}</Copy>
      {!!error && <Notice>{error}</Notice>}
      <Button label="Confirm removal" variant="danger" busy={busy} onPress={() => commit({ action: 'remove', itemId: dialog.item.id }, { close: true, version: dialog.version })} />
    </Sheet>}
    {dialog?.kind === 'reset' && <Sheet title="Reset demo?" onClose={close}>
      <Copy muted>Restore the original items and shares for everyone in this demo cart.</Copy>
      {!!error && <Notice>{error}</Notice>}
      <Button label="Confirm reset" icon={RotateCcw} busy={busy} onPress={() => commit({ action: 'reset' }, { close: true, version: cart.version })} />
    </Sheet>}
    {dialog?.kind === 'invite' && cart.access === 'owner' && <InviteManager cart={cart} onClose={close} />}
    {dialog?.kind === 'share' && <Sheet title="Share cart" onClose={close}>
      <Copy muted>Open the same link in another browser tab or share it with your group.</Copy>
      <Copy size={14} weight="600" style={{ padding: 12, borderRadius: 8, backgroundColor: colors.soft, overflowWrap: 'anywhere', userSelect: 'text' } as never}>{shareURL}</Copy>
      <Button label={copied ? 'Link copied' : 'Copy link'} icon={copied ? Check : Clipboard} onPress={() => {
        if (navigator.clipboard) void navigator.clipboard.writeText(shareURL).then(() => setCopied(true)).catch(() => setCopied(false));
      }} />
    </Sheet>}
  </View>;
}
