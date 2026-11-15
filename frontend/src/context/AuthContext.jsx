import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { getToken, setToken, clearToken } from '../utils/storage.js';
import { getLocalProfile, setLocalProfile } from '../offline/snapshots.js';
import * as authApi from '../api/auth.js';

export const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setTokenState] = useState(() => getToken());
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  const applyLogout = useCallback(() => {
    clearToken();
    setLocalProfile(null);
    setTokenState(null);
    setUser(null);
  }, []);

  // Hydrate on mount: if a token is present, validate it by loading the user.
  useEffect(() => {
    let cancelled = false;

    async function hydrate() {
      const existing = getToken();
      if (!existing) {
        setIsLoading(false);
        return;
      }
      try {
        const me = await authApi.me();
        if (!cancelled) {
          setLocalProfile(me);
          setTokenState(existing);
          setUser(me);
        }
      } catch (error) {
        if (cancelled) return;
        const profile = getLocalProfile();
        if (profile && (!error.status || error.status === 401 || error.status >= 500)) {
          setUser(profile);
        } else {
          applyLogout();
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    hydrate();
    return () => {
      cancelled = true;
    };
  }, [applyLogout]);

  useEffect(() => {
    const refreshAccount = (event) => {
      if (event.key === null || event.key === 'gym.token') window.location.reload();
    };
    window.addEventListener('storage', refreshAccount);
    return () => window.removeEventListener('storage', refreshAccount);
  }, []);

  // LOGIN: ottiene un token JWT dal backend e carica l'utente.
  const login = useCallback(async ({ email, password }) => {
    // 1) Chiama POST /auth/login. Il backend, se le credenziali sono corrette,
    //    risponde con { access_token, token_type }. Estraiamo l'access_token
    //    e lo rinominiamo `accessToken`.
    const { access_token: accessToken } = await authApi.login({ email, password });

    // The request interceptor needs the token before fetching the account.
    setToken(accessToken);

    // 3) Con il token ormai attivo, chiediamo "chi sono" (GET /auth/me) per
    //    avere i dati dell'utente (id, email, ...) e li mettiamo nello stato.
    let me;
    try {
      me = await authApi.me();
      setLocalProfile(me);
    } catch (error) {
      applyLogout();
      throw error;
    }
    setTokenState(accessToken);
    setUser(me);
    return me;
  }, [applyLogout]);

  // REGISTER: la logica di registrazione con email e password.
  // E' volutamente semplice perche' la validazione (email valida, password
  // >= 8, conferma uguale) e' gia' avvenuta nel form con Zod; qui parliamo
  // solo col backend.
  const register = useCallback(
    async ({ email, password }) => {
      // 1) Chiama POST /auth/register per CREARE l'account.
      //    Se l'email e' gia' registrata, il backend risponde 409 e l'axios
      //    interceptor trasforma la risposta in un errore (throw): l'esecuzione
      //    salta al catch del form, che mostra il messaggio nel banner rosso.
      await authApi.register({ email, password });

      // 2) Il backend crea l'utente ma NON restituisce un token al register.
      //    Quindi facciamo subito il login con le stesse credenziali per
      //    ottenere il JWT e portare l'utente dentro l'app gia' autenticato.
      return login({ email, password });
    },
    [login]
  );

  const logout = useCallback(() => {
    applyLogout();
  }, [applyLogout]);

  const value = useMemo(
    () => ({
      token,
      user,
      isLoading,
      isAuthenticated: Boolean(token),
      login,
      register,
      logout,
    }),
    [token, user, isLoading, login, register, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
