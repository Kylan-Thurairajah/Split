import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { latestCart } from './model';
import type { Cart, Change } from './model';

function apiBase() {
  return process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, '') ?? (
    typeof window !== 'undefined' && window.location.port === '8081'
      ? window.location.protocol + '//' + window.location.hostname + ':8080'
      : ''
  );
}

async function request(path: string, method = 'GET', data?: unknown) {
  return fetch(apiBase() + '/api/carts' + path, {
    method,
    headers: data ? { 'Content-Type': 'application/json' } : undefined,
    body: data ? JSON.stringify(data) : undefined,
  });
}

async function readCart(response: Response): Promise<Cart> {
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error ?? 'Split could not open this cart.');
  return data;
}

export async function createCart(demo: boolean, name: string) {
  try {
    return await readCart(await request('', 'POST', { demo, name }));
  } catch (error) {
    if (error instanceof TypeError) throw new Error('Cannot reach Split. Check that the API is running.');
    throw error;
  }
}

export function useCart(id: string, actor: string) {
  const [connected, setConnected] = useState(false);
  const cache = useQueryClient();
  const key = ['cart', id];
  const query = useQuery({
    queryKey: key,
    queryFn: async () => readCart(await request('/' + id)),
    enabled: !!id,
    retry: 1,
    structuralSharing: (previous, incoming) =>
      latestCart(previous as Cart | undefined, incoming as Cart),
  });

  useEffect(() => {
    if (!id || typeof window === 'undefined') return;
    let closed = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout>;
    let delay = 350;
    const queryKey = ['cart', id];

    function connect() {
      const url = new URL(apiBase() + '/api/carts/' + id + '/ws', window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(url);
      socket.onopen = () => {
        if (closed) return;
        setConnected(true);
        delay = 350;
        void cache.invalidateQueries({ queryKey });
      };
      socket.onmessage = event => {
        if (closed) return;
        const incoming: Cart = JSON.parse(event.data);
        if (incoming.id !== id) return;
        cache.setQueryData<Cart>(queryKey, current =>
          latestCart(current, incoming));
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (closed) return;
        setConnected(false);
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 5000);
      };
    }
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [cache, id]);

  const mutation = useMutation({
    mutationFn: async (change: Change) => {
      const current = cache.getQueryData<Cart>(key);
      if (!current) throw new Error('The cart is still loading.');
      const response = await request('/' + id, 'PATCH', { ...change, actor, version: change.version ?? current.version });
      if (response.status === 409) {
        const incoming: Cart = await response.json();
        if (incoming.id === id) cache.setQueryData<Cart>(key, previous => latestCart(previous, incoming));
        throw new Error('The cart changed in another tab. If you are editing an item, close and reopen the editor before saving.');
      }
      const incoming = await readCart(response);
      cache.setQueryData<Cart>(key, previous =>
        latestCart(previous, incoming));
    },
  });

  return { query, mutation, connected };
}



