// Personalização por conta: nome do sistema e logo do cabeçalho.
//
// Duas regras mandam aqui:
//  1. A personalização é DA CONTA. O que uma conta salva nunca pode aparecer
//     pra outra — por isso o cache local é chaveado pelo id do usuário e o
//     logout volta tudo pro padrão na hora.
//  2. A tela de login é sempre padrão: antes de saber quem entrou não há
//     personalização pra aplicar, e o markup do login fica fora do
//     #appScreen justamente por isso.
//
// Quem guarda o valor de verdade é o backend (tabela user_settings, com RLS).
// O cache no localStorage existe só pra marca aparecer já na abertura do app,
// sem piscar o padrão enquanto a API responde.
(function () {
  'use strict';

  const DEFAULT_APP_NAME = 'Estoque de Pneus';
  const DEFAULT_PAGE_TITLE = 'Controle de Estoque de Pneus';
  const CACHE_PREFIX = 'estoque_branding_';
  const MAX_APP_NAME_LEN = 40;

  // Mesmo formato que a API aceita. Validar também na LEITURA do cache é de
  // propósito: o localStorage é editável pelo usuário e o valor vira uma
  // url() de CSS — sem isso dava pra injetar CSS mexendo na chave do cache.
  const LOGO_DATA_URL_REGEX = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

  let userId = null;
  let current = { appName: null, logo: null };

  function normalize(value) {
    const rawName = value && typeof value.appName === 'string' ? value.appName.trim().slice(0, MAX_APP_NAME_LEN) : '';
    const rawLogo = value && typeof value.logo === 'string' ? value.logo : '';
    return {
      appName: rawName || null,
      logo: LOGO_DATA_URL_REGEX.test(rawLogo) ? rawLogo : null,
    };
  }

  function apply(value) {
    current = normalize(value);

    const titleEl = document.getElementById('brandTitle');
    if (titleEl) titleEl.textContent = current.appName || DEFAULT_APP_NAME;
    document.title = current.appName || DEFAULT_PAGE_TITLE;

    // ícone da aba do navegador acompanha a logo da conta
    const favicon = document.getElementById('favicon');
    if (favicon) {
      if (!favicon.dataset.defaultHref) favicon.dataset.defaultHref = favicon.getAttribute('href');
      favicon.setAttribute('href', current.logo || favicon.dataset.defaultHref);
      favicon.setAttribute('type', current.logo ? current.logo.slice(5, current.logo.indexOf(';')) : 'image/png');
    }

    // A logo entra como custom property no #appScreen em vez de ser aplicada
    // elemento a elemento: assim qualquer .brand-mark que o render criar
    // depois (estado vazio, figurinha do scanner) já nasce com ela.
    const screen = document.getElementById('appScreen');
    if (!screen) return;
    if (current.logo) {
      screen.style.setProperty('--brand-logo', 'url("' + current.logo + '")');
      screen.classList.add('has-custom-logo');
    } else {
      screen.style.removeProperty('--brand-logo');
      screen.classList.remove('has-custom-logo');
    }
  }

  function cacheKey(id) {
    return CACHE_PREFIX + id;
  }

  function readCache(id) {
    if (!id) return null;
    try {
      return JSON.parse(localStorage.getItem(cacheKey(id)) || 'null');
    } catch (e) {
      return null;
    }
  }

  function writeCache(id, value) {
    if (!id) return;
    try {
      const v = normalize(value);
      if (!v.appName && !v.logo) localStorage.removeItem(cacheKey(id));
      else localStorage.setItem(cacheKey(id), JSON.stringify(v));
    } catch (e) {
      // modo privado ou cota estourada: segue sem cache, a API resolve
    }
  }

  window.Branding = {
    DEFAULT_APP_NAME,
    MAX_APP_NAME_LEN,

    isValidLogo(logo) {
      return LOGO_DATA_URL_REGEX.test(String(logo || ''));
    },

    /** Conta dona da marca aplicada agora (null = ninguém logado). */
    userId() {
      return userId;
    },

    /** Personalização aplicada agora, já normalizada. */
    current() {
      return { appName: current.appName, logo: current.logo };
    },

    /** Nome em uso — o personalizado da conta ou o padrão do app. */
    appName() {
      return current.appName || DEFAULT_APP_NAME;
    },

    /**
     * Uma conta entrou: aplica na hora o que estiver em cache pra ELA (sem
     * esperar a rede) e passa a chavear o cache por ela. Idempotente — o
     * auth.js chama isso de novo a cada refresh de token.
     */
    setUser(id) {
      const next = id || null;
      if (next === userId) return;
      userId = next;
      apply(readCache(next));
    },

    /**
     * Logout: volta pro padrão na hora, pra tela de login — e a próxima
     * conta que entrar nesse navegador — nunca herdarem a marca de quem saiu.
     */
    reset() {
      userId = null;
      apply(null);
    },

    /**
     * Resposta da API. `forUser` é de quem era o pedido: se a conta trocou
     * enquanto a requisição estava no ar, o resultado velho é descartado em
     * vez de pintar a marca da conta anterior. Devolve se aplicou.
     */
    applyRemote(value, forUser) {
      if ((forUser || null) !== userId) return false;
      apply(value);
      writeCache(userId, value);
      return true;
    },
  };
})();
