"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";

import {
  apiGet,
  apiLogin,
  apiLogout,
  refreshAccessToken,
  setAccessToken as setApiAccessToken,
  setAuthFailureListener,
  setTokenChangeListener,
} from "./api";
import type { UserRead } from "./types";

interface AuthContextValue {
  accessToken: string | null;
  currentUser: UserRead | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  updateCurrentUser: (user: UserRead) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<UserRead | null>(null);
  // True until the initial session-restore attempt (below) resolves --
  // lets the app avoid flashing a "logged out" state before that finishes.
  const [isLoading, setIsLoading] = useState(true);

  const clearAuth = useCallback(() => {
    setApiAccessToken(null);
    setAccessToken(null);
    setCurrentUser(null);
  }, []);

  // Mirrors token changes that originate inside lib/api.ts (a silent
  // refresh triggered by a 401 on some unrelated request) into this
  // component's state, and reacts when a session can't be recovered at all.
  useEffect(() => {
    setTokenChangeListener(setAccessToken);
    setAuthFailureListener(() => {
      clearAuth();
      router.push("/login");
    });
    return () => {
      setTokenChangeListener(null);
      setAuthFailureListener(null);
    };
  }, [clearAuth, router]);

  // Restore a session on first load. The in-memory access token doesn't
  // survive a page reload, but the httponly refresh cookie does, so a
  // silent refresh is what actually keeps the user logged in across reloads.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const token = await refreshAccessToken();
      if (cancelled) return;

      if (!token) {
        setIsLoading(false);
        return;
      }

      setAccessToken(token);
      try {
        const user = await apiGet<UserRead>("/auth/me");
        if (!cancelled) setCurrentUser(user);
      } catch {
        if (!cancelled) clearAuth();
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [clearAuth]);

  const login = useCallback(
    async (email: string, password: string) => {
      const { access_token } = await apiLogin({ email, password });
      setAccessToken(access_token);
      try {
        const user = await apiGet<UserRead>("/auth/me");
        setCurrentUser(user);
      } catch (err) {
        // Don't leave a half-authenticated state (token set, no profile).
        clearAuth();
        throw err;
      }
    },
    [clearAuth],
  );

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } finally {
      // Always log the user out locally, even if the network request
      // failed -- an unreachable backend shouldn't trap someone in a
      // session they're trying to leave.
      clearAuth();
      router.push("/login");
    }
  }, [clearAuth, router]);

  return (
    <AuthContext.Provider
      value={{ accessToken, currentUser, isLoading, login, logout, updateCurrentUser: setCurrentUser }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
