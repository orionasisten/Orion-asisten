import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Penyimpanan kredensial & data lokal mobile.
 *
 * - **Token perangkat** → `expo-secure-store` (Keychain iOS / EncryptedSharedPreferences Android).
 *   BUKAN AsyncStorage, BUKAN localStorage, BUKAN URL, BUKAN log.
 * - **Outbox pesan (bukan rahasia)** → AsyncStorage (persistensi, diproteksi namespace aplikasi).
 *   Outbox TIDAK pernah memuat token/secret.
 */

const TOKEN_KEY = 'orion_device_token';
const API_URL_KEY = 'orion_api_url';
const OUTBOX_KEY = 'orion_outbox_v1';
const CURSOR_KEY = 'orion_sync_cursor';

export interface OutboxEntry {
  eventId: string;            // id stabil = idempotency key
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  clientMessageId: string;
  createdAt: string;
  attempts: number;
  state: 'pending' | 'syncing' | 'failed';
  lastError?: string;
}

export const secureStore = {
  available: async (): Promise<boolean> => {
    try { return await SecureStore.isAvailableAsync(); } catch { return false; }
  },
  getToken: async (): Promise<string | null> => {
    try { return await SecureStore.getItemAsync(TOKEN_KEY); } catch { return null; }
  },
  setToken: async (token: string): Promise<void> => {
    await SecureStore.setItemAsync(TOKEN_KEY, token, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
    });
  },
  clearToken: async (): Promise<void> => {
    try { await SecureStore.deleteItemAsync(TOKEN_KEY); } catch { /* ignore */ }
  },
  getApiUrl: async (): Promise<string | null> => {
    try { return await AsyncStorage.getItem(API_URL_KEY); } catch { return null; }
  },
  setApiUrl: async (url: string): Promise<void> => {
    try { await AsyncStorage.setItem(API_URL_KEY, url); } catch { /* ignore */ }
  }
};

export const localStore = {
  getOutbox: async (): Promise<OutboxEntry[]> => {
    try {
      const raw = await AsyncStorage.getItem(OUTBOX_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  },
  setOutbox: async (entries: OutboxEntry[]): Promise<void> => {
    try { await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(entries)); } catch { /* ignore */ }
  },
  getCursor: async (): Promise<number> => {
    try { return Number(await AsyncStorage.getItem(CURSOR_KEY)) || 0; } catch { return 0; }
  },
  setCursor: async (cursor: number): Promise<void> => {
    try { await AsyncStorage.setItem(CURSOR_KEY, String(cursor)); } catch { /* ignore */ }
  }
};
