import { useEffect, useRef, useState } from 'react';
import type { PropsWithChildren } from 'react';
import Head from 'expo-router/head';
import { useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { profileKey, updateProfile, useProfile } from './api';
import { sendSignInCode, signOut, useAuth, verifySignInCode } from './auth';
import { Avatar, Brand, Button, Copy, Field, Notice, Panel, Sheet, ThemeButton, useTheme } from './ui';
import type { Participant } from './model';

function AccountMenu({ person }: { person?: Participant }) {
  const { user } = useAuth();
  const profile = useProfile();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const container = useRef<View>(null);
  const trigger = useRef<View>(null);
  const logout = useMutation({
    mutationFn: signOut,
    onSuccess: () => { setOpen(false); router.replace('/'); },
  });

  useEffect(() => {
    if (!open || logout.isPending || typeof document === 'undefined') return;
    function outside(event: PointerEvent) {
      const element = container.current as unknown as HTMLElement | null;
      if (event.target instanceof Node && !element?.contains(event.target)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setOpen(false);
      (trigger.current as unknown as HTMLElement | null)?.focus();
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, logout.isPending]);

  if (!user) return person ? <Avatar person={person} size={29} /> : null;
  const accountName = profile.data?.name || user.name || user.email;
  return <View ref={container} style={{ position: 'relative', zIndex: 10 }}>
    <Pressable ref={trigger} accessibilityRole="button" accessibilityLabel="Account menu"
      aria-expanded={open} disabled={logout.isPending}
      onPress={() => { logout.reset(); setOpen(value => !value); }}
      style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20 }}>
      <Avatar person={{ id: user.id, name: accountName, color: person?.color ?? '#D7C2F4' }} size={29} />
    </Pressable>
    {open && <View style={{ position: 'absolute', top: 46, right: 0, width: 120 }}>
      <Panel style={{ padding: 8, gap: 6 }}>
        {logout.error && <Notice>{logout.error.message}</Notice>}
        <Button label="Sign out" variant="secondary" compact busy={logout.isPending} onPress={() => logout.mutate()} />
      </Panel>
    </View>}
  </View>;
}

export function HeaderControls({ person }: { person?: Participant }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
    <ThemeButton />
    <AccountMenu person={person} />
  </View>;
}

export function AccountPage({ title, children, wide }: PropsWithChildren<{ title: string; wide?: boolean }>) {
  const { colors } = useTheme();
  const router = useRouter();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Head><title>{title + ' | Split'}</title></Head>
      <View style={{ zIndex: 1, borderBottomWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
        <View style={{ width: '100%', maxWidth: 1192, alignSelf: 'center', paddingHorizontal: 20, height: 64, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Brand onPress={() => router.replace('/')} />
          <HeaderControls />
        </View>
      </View>
      <ScrollView style={{ flex: 1 }}>
        <View style={{ width: '100%', maxWidth: wide ? 960 : 480, alignSelf: 'center', paddingHorizontal: 16, paddingVertical: 38, gap: 18 }}>
          {children}
        </View>
      </ScrollView>
    </View>
  );
}

export function AccountLoading() {
  const { colors } = useTheme();
  return <ActivityIndicator accessibilityLabel="Checking sign-in" color={colors.accent} />;
}

export function SignInForm({ inviting = false }: { inviting?: boolean }) {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');
  const busy = sending || verifying;
  const cleanEmail = email.trim().toLowerCase();
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail);

  async function send() {
    if (!validEmail || busy) return;
    setSending(true);
    setError('');
    try {
      await sendSignInCode(cleanEmail);
      setCode('');
      setSent(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Split could not send a code.');
    } finally {
      setSending(false);
    }
  }

  async function verify() {
    if (busy || !/^\d{6}$/.test(code)) return;
    setVerifying(true);
    setError('');
    try {
      await verifySignInCode(cleanEmail, code);
      auth.retry();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Split could not verify the code.');
    } finally {
      setVerifying(false);
    }
  }

  return (
    <Panel style={{ padding: 22, gap: 16 }}>
      <Copy heading size={29} weight="800">{inviting ? 'Sign in to join the cart' : 'Sign in to Split'}</Copy>
      {!auth.enabled ? <Notice>Accounts are unavailable in this environment. You can still try the demo.</Notice> :
        auth.pending ? <AccountLoading /> :
        auth.error ? <><Notice>{auth.error}</Notice><Button label="Try again" onPress={auth.retry} /></> :
        <>
          <Copy muted>{sent ? 'Enter the six-digit code sent to ' + cleanEmail + '.' : 'Use a one-time email code to sign in or create an account.'}</Copy>
          {sent ? <>
            <Field label="Sign-in code" value={code} onChangeText={value => setCode(value.replace(/\D+/g, ''))}
              keyboardType="number-pad" autoComplete="one-time-code" maxLength={6} autoFocus onSubmitEditing={() => void verify()} />
          </> : <Field label="Email address" value={email} onChangeText={setEmail} keyboardType="email-address"
            autoComplete="email" autoCapitalize="none" autoCorrect={false} maxLength={254} autoFocus onSubmitEditing={() => void send()} />}
          {!!error && <Notice>{error}</Notice>}
          {sent ?
            <>
              <Button label="Verify and sign in" onPress={() => void verify()} disabled={sending || code.length !== 6} busy={verifying} />
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
                <Button label="Use a different email" compact variant="quiet" disabled={busy} onPress={() => { setSent(false); setError(''); setCode(''); }} />
                <Button label="Resend code" compact variant="quiet" busy={sending} disabled={verifying} onPress={() => void send()} />
              </View>
            </> :
            <Button label="Send sign-in code" onPress={() => void send()} disabled={!validEmail} busy={sending} />}
        </>}
    </Panel>
  );
}

export function ProfileSetup() {
  const { user } = useAuth();
  const profile = useProfile();
  return user && profile.data?.needsName ? <NameForm key={user.id} account={user.id} /> : null;
}

function NameForm({ account }: { account: string }) {
  const [name, setName] = useState('');
  const cache = useQueryClient();
  const save = useMutation({
    mutationFn: () => updateProfile({ name: name.trim() }),
    onSuccess: profile => cache.setQueryData(profileKey(account), profile),
  });
  const leave = useMutation({ mutationFn: signOut });
  const busy = save.isPending || leave.isPending;
  const submit = () => { if (name.trim() && !busy) save.mutate(); };
  return <Sheet title="Choose your display name">
    <Copy muted>This is the name people see when you share a cart.</Copy>
    <Field label="Display name" value={name} onChangeText={setName} autoComplete="name"
      placeholder="Your name" maxLength={60} autoFocus onSubmitEditing={submit} />
    {(save.error || leave.error) && <Notice>{(save.error || leave.error)?.message}</Notice>}
    <Button label="Save display name" disabled={!name.trim() || busy} busy={save.isPending} onPress={submit} />
    <Button label="Sign out" variant="quiet" disabled={busy} onPress={() => leave.mutate()} />
  </Sheet>;
}
