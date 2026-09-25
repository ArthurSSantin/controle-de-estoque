// Personalização por conta: nome do sistema, logo do cabeçalho e cor do
// sistema (cor de destaque: botões, aba ativa, foco, cabeçalho do PDF).
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

  const DEFAULT_ACCENT = '#d71920';
  const ACCENT_COLOR_REGEX = /^#[0-9a-f]{6}$/i;

  let userId = null;
  let current = { appName: null, logo: null, accentColor: null };

  /* ---------- cor do sistema ---------- */

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(rgb) {
    return '#' + rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('');
  }
  function mix(rgb, target, t) {
    return rgb.map((c, i) => c + (target[i] - c) * t);
  }
  function luminance(rgb) {
    const [r, g, b] = rgb.map((c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  const WHITE = [255, 255, 255];
  const BLACK = [0, 0, 0];
  const DARK_INK = [30, 31, 34]; // mesmo --ink do style.css

  // Deriva da cor escolhida todas as variantes que o CSS usa. Qualquer cor
  // que a pessoa escolher continua legível: o texto sobre o botão vira
  // escuro em cor clara (amarelo, verde-limão), e o texto colorido sobre
  // fundo claro é escurecido até passar no contraste mínimo (WCAG AA).
  function accentPalette(hex) {
    const c = hexToRgb(hex);
    const ink = contrast(c, WHITE) >= contrast(c, DARK_INK) ? WHITE : DARK_INK;
    let text = c;
    for (let t = 0; contrast(text, WHITE) < 4.5 && t < 1; t += 0.05) text = mix(c, BLACK, t + 0.05);
    return {
      '--accent': rgbToHex(c),
      '--accent-hover': rgbToHex(mix(c, BLACK, 0.15)),
      '--accent-ink': rgbToHex(ink),
      '--accent-bg': rgbToHex(mix(c, WHITE, 0.9)),
      '--accent-text': rgbToHex(text),
      '--accent-shadow': rgbToHex(mix(c, BLACK, 0.35)),
      '--accent-border': rgbToHex(mix(c, WHITE, 0.7)),
    };
  }

  function paintAccent(hex) {
    const screen = document.getElementById('appScreen');
    const palette = hex ? accentPalette(hex) : null;
    if (screen) {
      for (const prop of Object.keys(accentPalette(DEFAULT_ACCENT))) {
        if (palette) screen.style.setProperty(prop, palette[prop]);
        else screen.style.removeProperty(prop);
      }
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      if (!meta.dataset.defaultColor) meta.dataset.defaultColor = meta.getAttribute('content');
      meta.setAttribute('content', hex || meta.dataset.defaultColor);
    }
  }

  function normalize(value) {
    const rawName = value && typeof value.appName === 'string' ? value.appName.trim().slice(0, MAX_APP_NAME_LEN) : '';
    const rawLogo = value && typeof value.logo === 'string' ? value.logo : '';
    const rawColor = value && typeof value.accentColor === 'string' ? value.accentColor.trim().toLowerCase() : '';
    return {
      appName: rawName || null,
      logo: LOGO_DATA_URL_REGEX.test(rawLogo) ? rawLogo : null,
      // também validada na leitura do cache: o valor vira variável de CSS
      accentColor: ACCENT_COLOR_REGEX.test(rawColor) ? rawColor : null,
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
    paintAccent(current.accentColor);

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
      if (!v.appName && !v.logo && !v.accentColor) localStorage.removeItem(cacheKey(id));
      else localStorage.setItem(cacheKey(id), JSON.stringify(v));
    } catch (e) {
      // modo privado ou cota estourada: segue sem cache, a API resolve
    }
  }

  window.Branding = {
    DEFAULT_APP_NAME,
    MAX_APP_NAME_LEN,
    DEFAULT_ACCENT,

    isValidColor(color) {
      return ACCENT_COLOR_REGEX.test(String(color || ''));
    },

    /** Cor de destaque em uso (a da conta ou a padrão), como [r, g, b]. */
    accentRgb() {
      return hexToRgb(current.accentColor || DEFAULT_ACCENT);
    },

    /** Texto legível sobre a cor de destaque, como [r, g, b]. */
    accentInkRgb() {
      return hexToRgb(accentPalette(current.accentColor || DEFAULT_ACCENT)['--accent-ink']);
    },

    /**
     * Prévia ao vivo na tela de configurações: pinta o app com a cor sem
     * salvar nada. null volta pra cor da conta (usado ao cancelar).
     */
    previewAccent(color) {
      paintAccent(ACCENT_COLOR_REGEX.test(String(color || '')) ? String(color).toLowerCase() : current.accentColor);
    },

    isValidLogo(logo) {
      return LOGO_DATA_URL_REGEX.test(String(logo || ''));
    },

    /** Conta dona da marca aplicada agora (null = ninguém logado). */
    userId() {
      return userId;
    },

    /** Personalização aplicada agora, já normalizada. */
    current() {
      return { appName: current.appName, logo: current.logo, accentColor: current.accentColor };
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
