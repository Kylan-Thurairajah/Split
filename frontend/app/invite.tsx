import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { AccountPage, SignInForm } from '../src/account-ui';
import { APIError, cartKey, cartsKey, redeemInvite } from '../src/api';
import { useAuth } from '../src/auth';
import { Button, Copy, Notice, Panel } from '../src/ui';

export default function InvitePage() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const { user } = useAuth();
  const router = useRouter();
  const cache = useQueryClient();
  const join = useMutation({
    mutationFn: redeemInvite,
    onSuccess: cart => {
      cache.setQueryData(cartKey(cart.id, user?.id), cart);
      void cache.invalidateQueries({ queryKey: cartsKey(user?.id) });
      router.replace({ pathname: '/cart/[id]', params: { id: cart.id } });
    },
  });

  return <AccountPage title="Cart invitation">
    {typeof token !== 'string' || !token || token.length > 256 ?
      <Notice>This invitation link is incomplete. Ask the cart owner for a new one.</Notice> :
      !user ? <SignInForm inviting /> :
      <Panel style={{ padding: 22, gap: 14 }}>
        <Copy heading size={28} weight="800">Join a private cart</Copy>
        <Copy muted>{'Signed in as ' + user.email}</Copy>
        {join.error && <Notice>{join.error instanceof APIError && [400, 404, 410].includes(join.error.status)
          ? 'This invitation may have expired, been revoked, or already been used. Ask the cart owner for a new link.'
          : join.error.message}</Notice>}
        <Button label="Join cart" busy={join.isPending} onPress={() => join.mutate(token)} />
        <Button label="My carts" variant="quiet" onPress={() => router.replace('/my-carts')} />
      </Panel>}
  </AccountPage>;
}
