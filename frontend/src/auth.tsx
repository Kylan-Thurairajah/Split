import { createAuthClient } from '@neon/auth';
import { BetterAuthReactAdapter } from '@neon/auth/react/adapters';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect } from 'react';
import type { PropsWithChildren } from 'react';

const authURL = process.env.EXPO_PUBLIC_NEON_AUTH_URL?.trim();
const client = authURL ? createAuthClient(authURL, { adapter: BetterAuthReactAdapter({ fetchOptions: { credentials: 'include' } }) }) : null;

type SessionUser = { id: string; name: string; email: string };
type AuthState = {
  enabled: boolean;
  pending: boolean;
  user: SessionUser | null;
  error: string | null;
  retry: () => void;
};
const AuthContext = createContext<AuthState>({
  enabled: false, pending: false, user: null, error: null, retry: () => {},
});

function NeonSessionProvider({ children }: PropsWithChildren) {
  const session = client!.useSession();
  const user = session.data?.user.emailVerified ? session.data.user : null;
  const cache = useQueryClient();
  useEffect(() => {
    cache.removeQueries({
      predicate: query => query.queryKey[0] === 'account' && query.queryKey[1] !== user?.id,
    });
  }, [cache, user?.id]);
  return (
    <AuthContext.Provider value={{
      enabled: true,
      pending: session.isPending,
      user,
      error: session.error ? 'Split could not check your sign-in. Try again.' : null,
      retry: () => { void session.refetch(); },
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function AuthProvider({ children }: PropsWithChildren) {
  return client ? <NeonSessionProvider>{children}</NeonSessionProvider> : children;
}

export const useAuth = () => useContext(AuthContext);

function authClient() {
  if (!client) throw new Error('Account features are unavailable in this environment.');
  return client;
}

// Neon Auth exposes these managed endpoints at runtime, but its adapter types
// can omit the OTP plugin when npm installs both Better Fetch patch versions.
type OTPResult = Promise<{ error: { status?: number } | null }>;
function emailCodeClient() {
  return authClient() as ReturnType<typeof authClient> & {
    emailOtp: { sendVerificationOtp(input: { email: string; type: 'sign-in' }): OTPResult };
    signIn: { emailOtp(input: { email: string; otp: string }): OTPResult };
  };
}

export async function sendSignInCode(email: string) {
  const { error } = await emailCodeClient().emailOtp.sendVerificationOtp({ email, type: 'sign-in' });
  if (error) throw new Error(error.status === 429 ? 'Too many requests. Wait before requesting another code.' : 'We could not send a sign-in code. Try again.');
}

export async function verifySignInCode(email: string, otp: string) {
  const { error } = await emailCodeClient().signIn.emailOtp({ email, otp });
  if (error) throw new Error(error.status === 429 ? 'Too many attempts. Request a new code in a moment.' : 'That code could not be verified. Check the code or request a new one.');
}

export async function signUpWithPassword(email: string, password: string) {
  const { data, error } = await authClient().signUp.email({ email, password, name: 'Split member' });
  if (error) throw new Error(error.status === 429 ? 'Too many attempts. Try again later.' : 'Could not create an account. If you already have one, sign in instead.');
  return !!data?.token && data.user.emailVerified;
}

export async function signInWithPassword(email: string, password: string) {
  const { data, error } = await authClient().signIn.email({ email, password });
  if (error) throw new Error(error.status === 429 ? 'Too many attempts. Try again later.' : 'Could not sign in with that email and password. You can also sign in with an email code.');
  return !!data?.user.emailVerified;
}

export async function signOut() {
  const { error } = await authClient().signOut();
  if (error) throw new Error('Split could not sign you out. Try again.');
}

export async function accountToken() {
  const { data, error } = await authClient().getSession();
  // Neon Auth 0.8 injects its short-lived set-auth-jwt into the session.
  // An ordinary Better Auth session token is opaque and stays with the auth provider.
  const token = data?.session.token;
  return !error && typeof token === 'string' && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token) ? token : null;
}
