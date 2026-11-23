import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { accountToken, useAuth } from './auth';
import { latestCart } from './model';
import type { Cart, Change } from './model';

function apiBase() {
  return process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, '') ?? (
    typeof window !== 'undefined' && window.location.port === '8081'
      ? window.location.protocol + '//' + window.location.hostname + ':8080'
      : ''
  );
}

export class APIError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request(path: string, method = 'GET', data?: unknown, authenticated = false, signal?: AbortSignal) {
  const headers = new Headers();
  if (data !== undefined) headers.set('Content-Type', 'application/json');
  if (authenticated) {
    const token = await accountToken();
    if (!token) throw new APIError(401, 'Sign in again to continue.');
    headers.set('Authorization', 'Bearer ' + token);
  }
  return fetch(apiBase() + '/api' + path, {
    method, headers, signal,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}

async function read<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new APIError(response.status, data?.error ?? 'Split could not complete this request.');
  return data;
}

export function cartKey(id: string, account?: string) {
  return account ? ['account', account, 'cart', id] : ['cart', id];
}

export const cartsKey = (account?: string) => ['account', account, 'carts'];

export async function createCart(demo: boolean, name: string, privateCart = false) {
  return read<Cart>(await request('/carts', 'POST', privateCart ? { private: true, name } : { demo, name }, privateCart));
}

export type AccountTheme = 'light' | 'dark';
export type Profile = { id: string; name: string; needsName: boolean; theme: AccountTheme | null };
export const profileKey = (account?: string) => ['account', account, 'profile'];
export const loadProfile = async (signal: AbortSignal) =>
  read<Profile>(await request('/me', 'GET', undefined, true, signal));
export const updateProfile = async (update: { name?: string; theme?: AccountTheme }) =>
  read<Profile>(await request('/me', 'PATCH', update, true));
export function useProfile() {
  const { user } = useAuth();
  return useQuery({
    queryKey: profileKey(user?.id), enabled: !!user,
    queryFn: ({ signal }) => loadProfile(signal), retry: false,
  });
}
export const loadCarts = async (signal: AbortSignal) =>
  read<Cart[]>(await request('/me/carts', 'GET', undefined, true, signal));
export const createInvite = async (id: string) =>
  read<{ token: string; expiresAt: string }>(await request('/carts/' + id + '/invites', 'POST', undefined, true));
export const revokeInvites = async (id: string) =>
  read<void>(await request('/carts/' + id + '/invites', 'DELETE', undefined, true));
export const removeMember = async (id: string, memberId: string) =>
  read<Cart>(await request('/carts/' + id + '/members/' + encodeURIComponent(memberId), 'DELETE', undefined, true));
export const redeemInvite = async (token: string) =>
  read<Cart>(await request('/invites/redeem', 'POST', { token }, true));

const forbidden = (error: unknown) => error instanceof APIError && [401, 403, 404].includes(error.status);

export function useCart(id: string, actor: string) {
  const { user, pending } = useAuth();
  const account = user?.id;
  const [activeSocket, setActiveSocket] = useState('');
  const cache = useQueryClient();
  const key = cartKey(id, account);
  const path = '/carts/' + encodeURIComponent(id);
  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      if (cache.getQueryData<Cart>(key)?.access) return read<Cart>(await request(path, 'GET', undefined, true, signal));
      const anonymous = await request(path, 'GET', undefined, false, signal);
      if (account && [401, 403, 404].includes(anonymous.status)) {
        return read<Cart>(await request(path, 'GET', undefined, true, signal));
      }
      return read<Cart>(anonymous);
    },
    enabled: !!id && (!pending || !!account),
    retry: (failures, error) => failures < 1 && !forbidden(error),
    structuralSharing: (previous, incoming) =>
      latestCart(previous as Cart | undefined, incoming as Cart),
    refetchInterval: state => state.state.data?.access ? 20_000 : false,
  });

  const cartAvailable = !!query.data && !forbidden(query.error);
  const privateCart = !!query.data?.access;
  const connectionId = id + ':' + (account ?? '') + ':' + privateCart;

  useEffect(() => {
    if (!cartAvailable || !id || typeof window === 'undefined') return;
    let closed = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout>;
    let delay = 350;
    const queryKey = cartKey(id, account);

    function reconnect() {
      if (closed) return;
      setActiveSocket('');
      if (privateCart) void cache.invalidateQueries({ queryKey });
      retry = setTimeout(() => void connect(), delay);
      delay = Math.min(delay * 2, 5000);
    }

    async function connect() {
      try {
        const url = new URL(apiBase() + '/api/carts/' + encodeURIComponent(id) + '/ws', window.location.href);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        if (privateCart) {
          const { ticket } = await read<{ ticket: string }>(
            await request('/carts/' + encodeURIComponent(id) + '/ws-ticket', 'POST', undefined, true),
          );
          if (closed) return;
          url.searchParams.set('ticket', ticket);
        }
        socket = new WebSocket(url);
        socket.onopen = () => {
          if (closed) return;
          setActiveSocket(connectionId);
          delay = 350;
          void cache.invalidateQueries({ queryKey });
        };
        socket.onmessage = event => {
          if (closed) return;
          const incoming: Cart = JSON.parse(event.data);
          if (incoming.id === id) cache.setQueryData<Cart>(queryKey, current => latestCart(current, incoming));
        };
        socket.onerror = () => socket?.close();
        socket.onclose = reconnect;
      } catch {
        reconnect();
      }
    }

    void connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [cache, id, account, cartAvailable, privateCart, connectionId]);

  const mutation = useMutation({
    mutationFn: async (change: Change) => {
      const current = cache.getQueryData<Cart>(key);
      if (!current || !cartAvailable) throw new Error('This cart is unavailable.');
      const response = await request(path, 'PATCH', {
        ...change, actor: current.actorId ?? actor, version: change.version ?? current.version,
      }, !!current.access);
      if (response.status === 409) {
        const incoming: Cart = await response.json();
        if (incoming.id === id) cache.setQueryData<Cart>(key, previous => latestCart(previous, incoming));
        throw new Error('The cart changed in another tab. If you are editing an item, close and reopen the editor before saving.');
      }
      if ([401, 403, 404].includes(response.status)) void cache.invalidateQueries({ queryKey: key });
      const incoming = await read<Cart>(response);
      cache.setQueryData<Cart>(key, previous => latestCart(previous, incoming));
      if (account && incoming.access) void cache.invalidateQueries({ queryKey: cartsKey(account) });
    },
  });

  return { query, mutation, connected: activeSocket === connectionId && cartAvailable, cart: cartAvailable ? query.data : undefined };
}
