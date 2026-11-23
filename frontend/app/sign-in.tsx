import { Redirect, useLocalSearchParams } from 'expo-router';
import { AccountPage, SignInForm } from '../src/account-ui';
import { useAuth } from '../src/auth';

export default function SignInPage() {
  const { user } = useAuth();
  const { cart } = useLocalSearchParams<{ cart?: string }>();
  if (user) return <Redirect href={typeof cart === 'string' && /^[a-f0-9]{32}$/.test(cart) ? { pathname: '/cart/[id]', params: { id: cart } } : '/my-carts'} />;
  return <AccountPage title="Sign in"><SignInForm /></AccountPage>;
}
