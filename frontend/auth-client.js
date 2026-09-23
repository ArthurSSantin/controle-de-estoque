// Cliente de autenticação próprio — fala direto com a API REST do Supabase
// Auth (GoTrue), sem o supabase-js. Cobre só o que o app usa: login por
// e-mail/senha, cadastro, logout, sessão persistida com refresh automático,
// sessão vinda do link de confirmação de e-mail e aviso de mudança de estado.
//
// A sessão fica no localStorage na MESMA chave e formato que o supabase-js
// usava (sb-<projeto>-auth-token), então quem já estava logado continua
// logado depois da troca.
(function () {
  const REFRESH_MARGIN_MS = 60 * 1000; // renova quando faltar menos de 1 min
  const REQUEST_TIMEOUT_MS = 15 * 1000;

  function create(supabaseUrl, apiKey) {
    const baseUrl = String(supabaseUrl || '').replace(/\/+$/, '');
    const projectRef = new URL(baseUrl).hostname.split('.')[0];
    const storageKey = `sb-${projectRef}-auth-token`;
    const lockName = `auth-refresh-${projectRef}`;
    const listeners = new Set();

    let session = readStoredSession();
    let refreshPromise = null;
    let refreshTimer = null;

    /* ---------- armazenamento ---------- */

    function readStoredSession() {
      try {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const s = parsed && parsed.currentSession ? parsed.currentSession : parsed; // formato antigo (v1)
        return s && s.access_token && s.refresh_token ? s : null;
      } catch (e) {
        return null;
      }
    }

    function writeStoredSession(s) {
      try {
        if (s) localStorage.setItem(storageKey, JSON.stringify(s));
        else localStorage.removeItem(storageKey);
      } catch (e) {
        // modo privado / storage bloqueado: segue só em memória
      }
    }

    function normalizeSession(body, fallbackUser) {
      const expiresIn = Number(body.expires_in) || 3600;
      const expiresAt = Number(body.expires_at) || Math.floor(Date.now() / 1000) + expiresIn;
      return {
        access_token: body.access_token,
        token_type: body.token_type || 'bearer',
        expires_in: expiresIn,
        expires_at: expiresAt,
        refresh_token: body.refresh_token,
        user: body.user || fallbackUser || null,
      };
    }

    /* ---------- eventos ---------- */

    function emit(event, s) {
      listeners.forEach((cb) => {
        try {
          cb(event, s);
        } catch (e) {
          console.error('Erro num listener de auth:', e);
        }
      });
    }

    function setSession(s, event) {
      session = s;
      writeStoredSession(s);
      scheduleRefresh();
      if (event) emit(event, s);
    }

    /* ---------- HTTP ---------- */

    async function request(method, path, { body, token } = {}) {
      const headers = { apikey: apiKey };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (token) headers.Authorization = `Bearer ${token}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(`${baseUrl}/auth/v1${path}`, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
      } catch (e) {
        return { data: null, error: { message: 'Falha de conexão com o servidor de autenticação.', status: 0, network: true } };
      } finally {
        clearTimeout(timer);
      }
      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (e) {
          data = null;
        }
      }
      if (!res.ok) {
        const message = (data && (data.msg || data.error_description || data.message || data.error)) || `HTTP ${res.status}`;
        return { data: null, error: { message: String(message), status: res.status, code: data && data.error_code } };
      }
      return { data, error: null };
    }

    /* ---------- refresh ---------- */

    function expiresSoon(s) {
      return !s.expires_at || s.expires_at * 1000 - Date.now() < REFRESH_MARGIN_MS;
    }

    // Refresh tokens do Supabase são de uso único: duas abas renovando ao
    // mesmo tempo podiam invalidar a sessão uma da outra. O lock serializa
    // entre abas, e depois dele relemos o storage — se outra aba já renovou,
    // só adotamos o resultado dela.
    function withCrossTabLock(fn) {
      if (navigator.locks && navigator.locks.request) {
        return navigator.locks.request(lockName, fn);
      }
      return fn();
    }

    function refresh() {
      if (!refreshPromise) {
        refreshPromise = withCrossTabLock(async () => {
          const stored = readStoredSession();
          if (stored && session && stored.refresh_token !== session.refresh_token && !expiresSoon(stored)) {
            setSession(stored, 'TOKEN_REFRESHED');
            return stored;
          }
          const current = stored || session;
          if (!current) return null;

          const { data, error } = await request('POST', '/token?grant_type=refresh_token', {
            body: { refresh_token: current.refresh_token },
          });
          if (error) {
            if (error.network || error.status >= 500) return session; // offline: mantém a sessão e tenta depois
            setSession(null, 'SIGNED_OUT');
            return null;
          }
          const next = normalizeSession(data, current.user);
          setSession(next, 'TOKEN_REFRESHED');
          return next;
        }).finally(() => {
          refreshPromise = null;
        });
      }
      return refreshPromise;
    }

    function scheduleRefresh() {
      clearTimeout(refreshTimer);
      if (!session || !session.expires_at) return;
      const delay = Math.max(session.expires_at * 1000 - Date.now() - REFRESH_MARGIN_MS, 0);
      refreshTimer = setTimeout(() => {
        refresh().catch(() => {});
      }, Math.min(delay, 2147483647));
    }

    /* ---------- API pública ---------- */

    async function getSession() {
      if (session && expiresSoon(session)) await refresh().catch(() => {});
      return { data: { session }, error: null };
    }

    async function signInWithPassword({ email, password }) {
      const { data, error } = await request('POST', '/token?grant_type=password', { body: { email, password } });
      if (error) return { data: { session: null, user: null }, error };
      const s = normalizeSession(data);
      setSession(s, 'SIGNED_IN');
      return { data: { session: s, user: s.user }, error: null };
    }

    async function signUp({ email, password }) {
      const { data, error } = await request('POST', '/signup', { body: { email, password } });
      if (error) return { data: { session: null, user: null }, error };
      // Com confirmação de e-mail ligada o Supabase devolve só o usuário;
      // desligada, já devolve uma sessão pronta.
      if (data && data.access_token) {
        const s = normalizeSession(data);
        setSession(s, 'SIGNED_IN');
        return { data: { session: s, user: s.user }, error: null };
      }
      return { data: { session: null, user: data }, error: null };
    }

    async function signOut() {
      const current = session;
      setSession(null, 'SIGNED_OUT');
      if (current) {
        await request('POST', '/logout?scope=global', { token: current.access_token });
      }
      return { error: null };
    }

    function onAuthStateChange(cb) {
      listeners.add(cb);
      return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } };
    }

    /* ---------- inicialização ---------- */

    // Link de confirmação de e-mail / recuperação volta pro site com a
    // sessão no hash: #access_token=...&refresh_token=...&expires_in=...
    async function detectSessionInUrl() {
      const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
      if (!hash) return;
      const p = new URLSearchParams(hash);
      if (!p.has('access_token') && !p.has('error') && !p.has('error_description')) return;
      history.replaceState(null, '', window.location.pathname + window.location.search);

      const accessToken = p.get('access_token');
      const refreshToken = p.get('refresh_token');
      if (!accessToken || !refreshToken) return;
      const { data: user, error } = await request('GET', '/user', { token: accessToken });
      if (error || !user) return;
      setSession(normalizeSession({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: p.get('expires_in'),
        expires_at: p.get('expires_at'),
        token_type: p.get('token_type'),
      }, user), 'SIGNED_IN');
    }

    // Outra aba logou, deslogou ou renovou o token.
    window.addEventListener('storage', (e) => {
      if (e.key !== storageKey) return;
      const next = readStoredSession();
      const hadSession = !!session;
      session = next;
      scheduleRefresh();
      if (!next && hadSession) emit('SIGNED_OUT', null);
      else if (next && !hadSession) emit('SIGNED_IN', next);
      else if (next) emit('TOKEN_REFRESHED', next);
    });

    // Timers de abas em segundo plano atrasam; ao voltar pra aba, confere.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && session && expiresSoon(session)) {
        refresh().catch(() => {});
      }
    });

    const ready = detectSessionInUrl()
      .catch(() => {})
      .then(async () => {
        // Sessão salva já vencida (app ficou fechado): renova antes de avisar.
        if (session && expiresSoon(session)) await refresh().catch(() => {});
        scheduleRefresh();
        emit('INITIAL_SESSION', session);
      });

    return {
      getSession: async () => {
        await ready;
        return getSession();
      },
      signInWithPassword,
      signUp,
      signOut,
      onAuthStateChange,
    };
  }

  window.AuthClient = { create };
})();
