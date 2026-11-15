// Centralized Axios instance + interceptors.
// All other api/*.js modules import from here.

import axios from 'axios';
import { getToken } from '../utils/storage.js';

import { getLocalProfile, readSnapshot, saveSnapshot } from '../offline/snapshots.js';

const baseURL = import.meta.env.VITE_API_BASE_URL || '/api';

const axiosClient = axios.create({
  baseURL,
  timeout: 8000,
  headers: { 'Content-Type': 'application/json' },
});

// Request interceptor: attach JWT bearer if present.
axiosClient.interceptors.request.use((config) => {
  const token = config.gymToken ?? getToken();
  const profile = token === getToken() ? getLocalProfile() : null;
  config.gymAccount = profile?.id;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Response interceptor: unwrap {success, data, error} and handle 401 globally.
axiosClient.interceptors.response.use(
  async (response) => {
    // Per api_contract.md the body is { success, data, error }.
    const body = response.data;
    if (body && typeof body === 'object' && 'success' in body) {
      if (body.success) {
        await saveSnapshot(response.config, body.data).catch(() => {});
        return body.data;
      }
      throw new Error(body.error || 'Request failed');
    }
    return body;
  },
  async (error) => {
    const status = error.response?.status;
    if ((!status || status >= 500 || status === 401) && error.config && !error.config.gymNetworkOnly) {
      const cached = await readSnapshot(error.config).catch(() => undefined);
      if (cached !== undefined) return cached;
    }
    const apiError = error.response?.data?.error;
    throw Object.assign(new Error(apiError || error.message), { status });
  }
);

export default axiosClient;
