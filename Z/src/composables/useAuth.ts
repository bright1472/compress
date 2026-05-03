import { ref, computed } from 'vue';
import { api } from '../services/api';

const TOKEN_KEY = 'titan-token';
const USER_KEY = 'titan-user';

export const token = ref<string | null>(localStorage.getItem(TOKEN_KEY));
export const authUser = ref<{ id: string; account: string; email?: string } | null>(
  (() => { try { return JSON.parse(localStorage.getItem(USER_KEY) ?? 'null'); } catch { return null; } })(),
);

export const isLoggedIn = computed(() => !!token.value);

function persist(t: string, u: { id: string; account: string; email?: string }) {
  token.value = t;
  authUser.value = u;
  localStorage.setItem(TOKEN_KEY, t);
  localStorage.setItem(USER_KEY, JSON.stringify(u));
}

function clear() {
  token.value = null;
  authUser.value = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export async function login(account: string, password: string) {
  const res = await api.post<{ token: string; account: string; email?: string; _id?: string; id?: string }>(
    '/authManager/login',
    { account, password },
  );
  const id = res.id || res._id || '';
  persist(res.token, { id, account: res.account || account, email: res.email });
}

export async function register(account: string, password: string) {
  const res = await api.post<{ token: string; account: string; email?: string; id?: string; _id?: string }>(
    '/compress/register',
    { account, password },
  );
  const id = res.id || res._id || '';
  persist(res.token, { id, account: res.account || account, email: res.email });
}

export function updateUser(updates: Partial<{ id: string; account: string; email: string }>) {
  if (authUser.value) {
    const newUser = { ...authUser.value, ...updates };
    authUser.value = newUser;
    localStorage.setItem(USER_KEY, JSON.stringify(newUser));
  }
}

export function logout() {
  clear();
}
