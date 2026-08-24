/* Фокус+ — вход фотографа (Firebase Auth REST) */
const FocusAuth = (() => {
  const SESSION_KEY = 'focusplus_auth_session';

  function apiKey() {
    return String(window.FOCUS_CLOUD?.apiKey || '').trim();
  }

  function requireAuth() {
    return window.FOCUS_CLOUD?.requireAuth !== false;
  }

  function authConfigured() {
    return Boolean(apiKey());
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s?.idToken || !s?.refreshToken) return null;
      return s;
    } catch {
      return null;
    }
  }

  function saveSession(session) {
    if (!session) {
      localStorage.removeItem(SESSION_KEY);
      return;
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  function clearSession() {
    saveSession(null);
  }

  function isLoggedIn() {
    return Boolean(loadSession()?.idToken);
  }

  function currentUser() {
    const s = loadSession();
    if (!s) return null;
    return { email: s.email || '', localId: s.localId || '' };
  }

  function mapAuthError(code) {
    const c = String(code || '');
    if (
      c.includes('EMAIL_NOT_FOUND') ||
      c.includes('INVALID_PASSWORD') ||
      c.includes('INVALID_LOGIN_CREDENTIALS')
    ) {
      return 'Неверный email или пароль';
    }
    if (c.includes('USER_DISABLED')) return 'Аккаунт отключён';
    if (c.includes('TOO_MANY_ATTEMPTS')) return 'Слишком много попыток. Подождите немного.';
    if (c.includes('INVALID_EMAIL')) return 'Некорректный email';
    if (c.includes('API_KEY')) return 'Проверьте apiKey в js/cloud-config.js';
    return 'Не удалось войти. Проверьте данные и интернет.';
  }

  async function signIn(email, password) {
    const key = apiKey();
    if (!key) {
      throw new Error('Сначала вставьте Web API Key в js/cloud-config.js (см. FIREBASE_RULES.md).');
    }
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: String(email || '').trim(),
        password: String(password || ''),
        returnSecureToken: true,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(mapAuthError(data?.error?.message));
    const session = {
      idToken: data.idToken,
      refreshToken: data.refreshToken,
      email: data.email || email,
      localId: data.localId || '',
      expiresAt: Date.now() + Number(data.expiresIn || 3600) * 1000,
    };
    saveSession(session);
    return session;
  }

  async function refreshIdToken() {
    const session = loadSession();
    if (!session?.refreshToken) return null;
    const key = apiKey();
    if (!key) return null;
    const url = `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(key)}`;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      clearSession();
      throw new Error('Сессия истекла. Войдите снова.');
    }
    const next = {
      ...session,
      idToken: data.id_token,
      refreshToken: data.refresh_token || session.refreshToken,
      localId: data.user_id || session.localId,
      expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
    };
    saveSession(next);
    return next;
  }

  async function getIdToken(forceRefresh = false) {
    const session = loadSession();
    if (!session?.idToken) return '';
    const soon = Date.now() + 60_000;
    if (!forceRefresh && session.expiresAt && session.expiresAt > soon) {
      return session.idToken;
    }
    try {
      const refreshed = await refreshIdToken();
      return refreshed?.idToken || '';
    } catch {
      return '';
    }
  }

  async function signOut() {
    clearSession();
  }

  return {
    apiKey,
    requireAuth,
    authConfigured,
    isLoggedIn,
    currentUser,
    signIn,
    signOut,
    getIdToken,
    loadSession,
    clearSession,
  };
})();
