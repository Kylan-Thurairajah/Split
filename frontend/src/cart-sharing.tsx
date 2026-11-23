import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { View } from 'react-native';
import { cartKey, cartsKey, createInvite, removeMember, revokeInvites } from './api';
import { useAuth } from './auth';
import { Check, Clipboard, Link2 } from './icons';
import type { Cart, Participant } from './model';
import { activityText, latestCart } from './model';
import { Avatar, Button, Copy, Field, Notice, Panel, Sheet } from './ui';

export function InviteManager({ cart, onClose }: { cart: Cart; onClose: () => void }) {
  const [invite, setInvite] = useState<{ token: string; expiresAt: string }>();
  const [pending, setPending] = useState('');
  const [remove, setRemove] = useState<Participant>();
  const [revoke, setRevoke] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [copied, setCopied] = useState(false);
  const { user } = useAuth();
  const cache = useQueryClient();
  const members = cart.participants.filter(person => person.id !== cart.actorId && !person.inactive);
  const href = invite && typeof window !== 'undefined'
    ? window.location.origin + '/invite?token=' + encodeURIComponent(invite.token) : '';

  async function change(action: 'create' | 'revoke' | 'remove') {
    setPending(action);
    setError('');
    setStatus('');
    setCopied(false);
    try {
      if (action === 'create') setInvite(await createInvite(cart.id));
      if (action === 'revoke') {
        await revokeInvites(cart.id);
        setRevoke(false);
        setInvite(undefined);
        setStatus('Unused invite links revoked.');
      }
      if (action === 'remove' && remove) {
        const next = await removeMember(cart.id, remove.id);
        cache.setQueryData<Cart>(cartKey(cart.id, user?.id), current => latestCart(current, next));
        void cache.invalidateQueries({ queryKey: cartsKey(user?.id) });
        setRemove(undefined);
        setStatus(remove.name + ' no longer has access.');
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Split could not update sharing.');
    } finally {
      setPending('');
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(href);
      setCopied(true);
    } catch {
      setStatus('Select the invite link to copy it.');
    }
  }

  return <Sheet title="Invite collaborators" onClose={() => { if (!pending) onClose(); }}>
    {!!error && <Notice>{error}</Notice>}
    {!!status && <View accessibilityLiveRegion="polite"><Copy muted size={13}>{status}</Copy></View>}
    {remove ? <>
      <Copy>{'Remove ' + remove.name + ' from this cart? Their existing allocations will stay on the cart.'}</Copy>
      <Button label="Confirm member removal" variant="danger" busy={pending === 'remove'} onPress={() => void change('remove')} />
      <Button label="Cancel" variant="quiet" disabled={!!pending} onPress={() => { setRemove(undefined); setError(''); }} />
    </> : revoke ? <>
      <Copy>Revoke all unused invite links? People who have already joined will keep access.</Copy>
      <Button label="Confirm revocation" variant="danger" busy={pending === 'revoke'} onPress={() => void change('revoke')} />
      <Button label="Cancel" variant="quiet" disabled={!!pending} onPress={() => { setRevoke(false); setError(''); }} />
    </> : <>
      <Copy muted>Send a one-time link to someone you want to add to this private cart.</Copy>
      <Button label="Create invite link" icon={Link2} busy={pending === 'create'} onPress={() => void change('create')} />
      {!!href && <>
        <Field label="Invite link" value={href} editable={false} selectTextOnFocus />
        <Copy muted size={13}>{'Expires ' + new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(invite!.expiresAt))}</Copy>
        <Button label={copied ? 'Invite link copied' : 'Copy invite link'} icon={copied ? Check : Clipboard}
          variant="secondary" onPress={() => void copy()} />
      </>}
      <Button label="Revoke invite links" variant="quiet" disabled={!!pending} onPress={() => { setRevoke(true); setError(''); }} />
      {!!members.length && <View style={{ gap: 8 }}>
        <Copy heading weight="700">Members</Copy>
        {members.map(person => <View key={person.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Avatar person={person} size={25} />
          <Copy style={{ flex: 1 }}>{person.name}</Copy>
          <Button label={'Remove ' + person.name} compact variant="quiet" disabled={!!pending} onPress={() => { setRemove(person); setError(''); }} />
        </View>)}
      </View>}
    </>}
  </Sheet>;
}

export function CartActivity({ cart }: { cart: Cart }) {
  const [showAll, setShowAll] = useState(false);
  const activities = [...(cart.activities ?? [])].reverse();
  if (!activities.length) return null;
  return <Panel style={{ padding: 16, gap: 12 }}>
    <Copy heading size={17} weight="700">Activity</Copy>
    {(showAll ? activities : activities.slice(0, 5)).map((activity, index) => {
      const person = cart.participants.find(member => member.id === activity.actor);
      return <View key={activity.createdAt + ':' + index} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        {person && <Avatar person={person} size={24} />}
        <View style={{ flex: 1, gap: 2 }}>
          <Copy size={14}>{(person?.name ?? 'A collaborator') + ' ' + activityText(cart, activity.text)}</Copy>
          <Copy size={12} muted>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(activity.createdAt))}</Copy>
        </View>
      </View>;
    })}
    {activities.length > 5 && <Button label={showAll ? 'Show less activity' : 'Show more activity'} compact variant="quiet"
      style={{ alignSelf: 'flex-start' }} onPress={() => setShowAll(value => !value)} />}
  </Panel>;
}
