import { getToken } from '../utils/storage.js';

// Store only explicitly supported read endpoints, scoped to a verified account.
const PROFILE_KEY = 'gym.local-profile';
const READ_PATH = /^\/(?:exercises|templates(?:\/\d+)?|workouts(?:\/\d+)?)$/;
let database;

export function getLocalProfile() {
  try {
    const record = JSON.parse(localStorage.getItem(PROFILE_KEY));
    return record?.token === getToken() ? record?.profile : null;
  } catch {
    return null;
  }
}

export function setLocalProfile(profile) {
  try {
    if (profile) {
      localStorage.setItem(PROFILE_KEY, JSON.stringify({ token: getToken(), profile }));
    } else {
      localStorage.removeItem(PROFILE_KEY);
    }
  } catch {
    // Online use remains available when browser storage is disabled.
  }
}

function openDatabase() {
  if (!database) {
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open('gym-tracker', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('snapshots');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch((error) => {
      database = undefined;
      throw error;
    });
  }
  return database;
}

async function snapshot(config, method, value) {
  const path = config.url;
  const account = config.gymAccount;
  if (!account || config.method !== 'get' || !READ_PATH.test(path)) return;
  const db = await openDatabase();
  const transaction = db.transaction('snapshots', method === 'put' ? 'readwrite' : 'readonly');
  const store = transaction.objectStore('snapshots');
  const key = [config.baseURL, account, path];
  const request = method === 'put' ? store.put(value, key) : store.get(key);
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function saveSnapshot(config, value) {
  await snapshot(config, 'put', value);
}

export function readSnapshot(config) {
  return snapshot(config, 'get');
}
