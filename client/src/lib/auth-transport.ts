const ADMIN_TOKEN_STORAGE_KEY = "sb_admin_access_token";
const ADMIN_USER_STORAGE_KEY = "sb_admin_user";
const ADMIN_SAVED_EMAIL_KEY = "sb_admin_saved_email";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function getClientCookie(name: string): string {
  if (typeof document === "undefined") return "";
  try {
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  } catch {
    return "";
  }
}

function setClientCookie(name: string, value: string | null): void {
  if (typeof document === "undefined") return;
  try {
    const secure = typeof window !== "undefined" && window.location.protocol === "https:" ? "; Secure; SameSite=None" : "; SameSite=Lax";
    if (value) {
      document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${COOKIE_MAX_AGE}${secure}`;
    } else {
      document.cookie = `${name}=; Path=/; Max-Age=0${secure}`;
    }
  } catch {
    // ignore cookie errors
  }
}

export function getStoredAccessToken(): string {
  if (typeof window === "undefined") return "";
  try {
    const fromLocal = localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
    if (fromLocal) return fromLocal;
  } catch {}
  try {
    const fromSession = sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
    if (fromSession) return fromSession;
  } catch {}
  return getClientCookie(ADMIN_TOKEN_STORAGE_KEY);
}

export function setStoredAccessToken(token: string | null | undefined, persist = true): void {
  if (typeof window === "undefined") return;
  try {
    if (token) {
      if (persist) {
        localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
        setClientCookie(ADMIN_TOKEN_STORAGE_KEY, token);
      }
      sessionStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
      sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
      setClientCookie(ADMIN_TOKEN_STORAGE_KEY, null);
    }
  } catch {
    // ignore storage errors
  }
}

export function getStoredAdminUser(): { id: string; uid: string; email: string | null } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw =
      localStorage.getItem(ADMIN_USER_STORAGE_KEY) ||
      sessionStorage.getItem(ADMIN_USER_STORAGE_KEY) ||
      getClientCookie(ADMIN_USER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.id === "string") {
      return { id: parsed.id, uid: parsed.id, email: parsed.email ?? null };
    }
    return null;
  } catch {
    return null;
  }
}

export function setStoredAdminUser(
  user: { id: string; email?: string | null } | null | undefined,
  persist = true
): void {
  if (typeof window === "undefined") return;
  try {
    if (user && user.id) {
      const serialized = JSON.stringify({
        id: user.id,
        uid: user.id,
        email: user.email ?? null,
      });
      if (persist) {
        localStorage.setItem(ADMIN_USER_STORAGE_KEY, serialized);
        setClientCookie(ADMIN_USER_STORAGE_KEY, serialized);
      }
      sessionStorage.setItem(ADMIN_USER_STORAGE_KEY, serialized);
    } else {
      localStorage.removeItem(ADMIN_USER_STORAGE_KEY);
      sessionStorage.removeItem(ADMIN_USER_STORAGE_KEY);
      setClientCookie(ADMIN_USER_STORAGE_KEY, null);
    }
  } catch {
    // ignore storage errors
  }
}

export function getSavedAdminEmail(): string {
  if (typeof localStorage === "undefined") return "";
  try {
    return localStorage.getItem(ADMIN_SAVED_EMAIL_KEY) || "";
  } catch {
    return "";
  }
}

export function setSavedAdminEmail(email: string | null | undefined): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (email && email.trim()) {
      localStorage.setItem(ADMIN_SAVED_EMAIL_KEY, email.trim().toLowerCase());
    } else {
      localStorage.removeItem(ADMIN_SAVED_EMAIL_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

export function clearStoredAccessToken(): void {
  setStoredAccessToken(null);
  setStoredAdminUser(null);
}

export function authRequestInit(init: RequestInit = {}): RequestInit {
  const token = getStoredAccessToken();
  const headers = new Headers(init.headers || {});
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return {
    ...init,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  };
}
