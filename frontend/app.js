(function () {
  'use strict';

  /* =========================================================================
     1. CAMADA DE DADOS (API)
     Todas as chamadas ao banco passam por essa API REST (ver pasta /backend).
     O backend fala com o Supabase — o frontend nunca acessa o banco direto.
     Configure a URL da API em config.js (window.APP_CONFIG.apiBase).
  ========================================================================= */

  const API_BASE = (window.APP_CONFIG && window.APP_CONFIG.apiBase) || 'http://localhost:3000/api';

  async function authHeaders() {
    const token = await window.getAccessToken();
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
  }

  const api = {
    async list(offset, limit) {
      const params = new URLSearchParams();
      if (offset) params.set('offset', offset);
      if (limit) params.set('limit', limit);
      const qs = params.toString();
      const res = await fetch(`${API_BASE}/tires${qs ? `?${qs}` : ''}`, { headers: await authHeaders() });
      if (!res.ok) throw new Error('Falha ao carregar o estoque');
      return res.json();
    },
    async create(tire) {
      const res = await fetch(`${API_BASE}/tires`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify(tire),
      });
      if (!res.ok) throw new Error((await safeErr(res)) || 'Falha ao criar item');
      return res.json();
    },
    async bulkCreate(items) {
      const res = await fetch(`${API_BASE}/tires/bulk`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ items }),
      });
      if (!res.ok) throw new Error((await safeErr(res)) || 'Falha ao criar itens em lote');
      return res.json();
    },
    async update(id, tire) {
      const res = await fetch(`${API_BASE}/tires/${id}`, {
        method: 'PUT',
        headers: await authHeaders(),
        body: JSON.stringify(tire),
      });
      if (!res.ok) throw new Error((await safeErr(res)) || 'Falha ao atualizar item');
      return res.json();
    },
    async remove(id) {
      const res = await fetch(`${API_BASE}/tires/${id}`, {
        method: 'DELETE',
        headers: await authHeaders(),
      });
      if (!res.ok) throw new Error('Falha ao excluir item');
    },
    async history(limit, filters) {
      const params = new URLSearchParams();
      if (limit) params.set('limit', limit);
      if (filters && filters.tireId) params.set('tireId', filters.tireId);
      if (filters && filters.from) params.set('from', filters.from);
      if (filters && filters.to) params.set('to', filters.to);
      const qs = params.toString();
      const res = await fetch(`${API_BASE}/history${qs ? `?${qs}` : ''}`, {
        headers: await authHeaders(),
      });
      if (!res.ok) throw new Error('Falha ao carregar o histórico');
      return res.json();
    },
  };

  async function safeErr(res) {
    try {
      const data = await res.json();
      return data.error;
    } catch (e) {
      return null;
    }
  }

  /* =========================================================================
     2. ESTADO E REFERÊNCIAS DO DOM
  ========================================================================= */

  let tires = [];
  let editingId = null;
  let searchTerm = '';
  let filterNovoOnly = false;
  let condFilter = 'todos'; // 'todos' | 'novo' | 'usado'
  let sortMode = 'aro'; // 'aro' | 'qtd_asc' | 'qtd_desc'
  let xmlNota = null; // { chave }
  let batchRowCount = 0;

  // Paginação (ver seção 5)
  const TIRES_PAGE_SIZE = 200;
  let tiresOffset = 0;
  let tiresTotal = 0;

  // Cache offline (ver seção 5b)
  const OFFLINE_CACHE_KEY = 'estoque_pneus_cache_v1';

  const contentEl = document.getElementById('content');
  const statsEl = document.getElementById('stats');
  const formPanel = document.getElementById('formPanel');
  const xmlPanel = document.getElementById('xmlPanel');
  const importPanel = document.getElementById('importPanel');
  const syncPanel = document.getElementById('syncPanel');
  const scannerModal = document.getElementById('scannerModal');
  const stickerModal = document.getElementById('stickerModal');
  const formTitle = document.getElementById('formTitle');
  const formErr = document.getElementById('formErr');
  const toast = document.getElementById('toast');
  const novoChip = document.getElementById('novoChip');
  const novoCount = document.getElementById('novoCount');
  const sortModeSelect = document.getElementById('sortModeSelect');
  const paginationBar = document.getElementById('paginationBar');
  const paginationInfo = document.getElementById('paginationInfo');

  /* =========================================================================
     1b. NAVEGAÇÃO POR ABAS (Estoque / Histórico / Dashboard / Exportar)
  ========================================================================= */

  const TAB_PANELS = {
    estoque: document.getElementById('tabEstoque'),
    historico: document.getElementById('tabHistorico'),
    dashboard: document.getElementById('tabDashboard'),
    exportar: document.getElementById('tabExportar'),
  };
  let activeTab = 'estoque';

  function switchTab(name) {
    if (!TAB_PANELS[name]) return;
    activeTab = name;

    Object.entries(TAB_PANELS).forEach(([key, el]) => {
      el.hidden = key !== name;
    });
    document.querySelectorAll('.tabbar .tab').forEach((btn) => {
      const isActive = btn.dataset.tab === name;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
    });

    if (name === 'historico') {
      populateHistoryTireFilter();
      loadAndRenderHistory();
    } else if (name === 'dashboard') {
      loadAndRenderDashboard();
    } else if (name === 'exportar') {
      renderExportPreview();
    }
  }

  const fMarca = document.getElementById('fMarca');
  const fMedida = document.getElementById('fMedida');
  const fQtd = document.getElementById('fQtd');
  const fPreco = document.getElementById('fPreco');
  const fCondicao = document.getElementById('fCondicao');
  const fFornecedor = document.getElementById('fFornecedor');
  const fCodigoBarras = document.getElementById('fCodigoBarras');

  /* =========================================================================
     3. UTILITÁRIOS GERAIS
  ========================================================================= */

  function showToast(msg, opts) {
    opts = opts || {};
    toast.textContent = msg;
    if (opts.actionLabel && opts.onAction) {
      const btn = document.createElement('button');
      btn.className = 'undo-btn';
      btn.textContent = opts.actionLabel;
      btn.onclick = () => {
        opts.onAction();
        toast.classList.remove('show');
      };
      toast.appendChild(btn);
    }
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), opts.duration || 2600);
  }

  function parseAro(medida) {
    const m = /R\s*-?\s*(\d{2})/i.exec(medida || '');
    return m ? parseInt(m[1], 10) : null;
  }

  function validMedida(medida) {
    return /R\s*-?\s*(1[3-9]|20)[A-Z]?\b/i.test(medida || '');
  }

  function formatPrice(v) {
    if (v === undefined || v === null || v === '') return '';
    const n = Number(String(v).replace(',', '.'));
    if (isNaN(n)) return v;
    return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function timeAgo(ts) {
    if (!ts) return '';
    const diffMin = Math.floor((Date.now() - ts) / 60000);
    if (diffMin < 1) return 'agora';
    if (diffMin < 60) return `${diffMin} min atrás`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h atrás`;
    return `${Math.floor(diffH / 24)}d atrás`;
  }

  function formatDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleDateString('pt-BR');
  }

  function formatDateTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleString('pt-BR');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Atrasa a execução de fn até `ms` sem novas chamadas — usado na busca, pra
  // não re-renderizar a lista inteira a cada tecla digitada.
  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  // Desabilita o botão (evita clique duplo/duplo toque criando o item duas
  // vezes) e mostra um rótulo de carregamento enquanto fn roda.
  async function withButtonBusy(btn, busyLabel, fn) {
    if (btn.disabled) return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyLabel;
    try {
      await fn();
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  /* =========================================================================
     3b. MESCLAGEM DE ITENS DUPLICADOS
     Um pneu é considerado "o mesmo" quando marca + medida + condição batem
     (ignorando maiúsculas/espaços). Ao adicionar um item que já existe —
     manualmente, por XML ou por importação — a quantidade é somada ao item
     existente em vez de criar uma linha duplicada.
  ========================================================================= */

  function normalizeForMatch(s) {
    return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function normalizeMedidaForMatch(s) {
    return String(s || '').trim().toUpperCase().replace(/\s+/g, '');
  }

  function matchKey(item) {
    return [
      normalizeForMatch(item.marca),
      normalizeMedidaForMatch(item.medida),
      item.condicao === 'usado' ? 'usado' : 'novo',
      item.origem === 'empresa' ? 'empresa' : 'local',
    ].join('|');
  }

  // Converte o preço (guardado como texto, ex: "412,20") para número, para
  // poder comparar dois preços e descobrir qual é o maior.
  function priceValue(v) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(String(v).replace(',', '.'));
    return isNaN(n) ? null : n;
  }

  /**
   * Varre o estoque atual em busca de itens que já são duplicados entre si
   * (mesma marca + medida + condição + origem — ver matchKey) e mescla cada
   * grupo em um único item: soma as quantidades e mantém o MAIOR preço entre
   * eles. Isso cobre casos em que duas linhas iguais acabaram existindo no
   * banco (ex: uma falha ao editar que levou a criar um item novo em vez de
   * atualizar o existente).
   */
  async function mergeExistingDuplicates() {
    const groups = {};
    tires.forEach((t) => {
      const key = matchKey(t);
      (groups[key] = groups[key] || []).push(t);
    });

    const toUpdate = [];
    const toDeleteIds = [];

    Object.values(groups).forEach((group) => {
      if (group.length < 2) return;

      // mantém como "principal" o item cadastrado há mais tempo
      group.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
      const [keep, ...rest] = group;

      const somaQtd = group.reduce((s, t) => s + (Number(t.quantidade) || 0), 0);
      let maiorPreco = keep.preco;
      let maiorValor = priceValue(keep.preco);
      group.forEach((t) => {
        const v = priceValue(t.preco);
        if (v !== null && (maiorValor === null || v > maiorValor)) {
          maiorValor = v;
          maiorPreco = t.preco;
        }
      });

      keep.quantidade = somaQtd;
      keep.preco = maiorPreco;

      toUpdate.push(keep);
      rest.forEach((t) => toDeleteIds.push(t.id));
    });

    if (!toUpdate.length) return 0;

    await Promise.all(toUpdate.map((t) => api.update(t.id, t)));
    await Promise.all(toDeleteIds.map((id) => api.remove(id)));

    tires = tires.filter((t) => !toDeleteIds.includes(t.id));

    return toUpdate.length;
  }

  /**
   * Igual a matchKey, mas ignora a origem — usada na sincronização com a
   * empresa, que precisa reconhecer um pneu independentemente de ter sido
   * cadastrado manualmente ("local") ou vindo de uma sincronização anterior
   * ("empresa"). A regra de negócio aqui é: o relatório da empresa é a fonte
   * da verdade para qualquer pneu que ele mencionar, não importa quem
   * cadastrou primeiro.
   */
  function companyMatchKey(item) {
    return [
      normalizeForMatch(item.marca),
      normalizeMedidaForMatch(item.medida),
      item.condicao === 'usado' ? 'usado' : 'novo',
    ].join('|');
  }

  /**
   * Recebe uma lista de itens novos (1 ou vários), mescla duplicados dentro
   * do próprio lote, e para cada um decide entre atualizar (somando
   * quantidade) um item já existente no estoque, ou criar um item novo.
   */
  async function commitItems(items, notaRefValue) {
    // 1) soma duplicados dentro do próprio lote sendo enviado
    const consolidated = [];
    const posByKey = {};
    items.forEach((item) => {
      const key = matchKey(item);
      if (posByKey[key] !== undefined) {
        const target = consolidated[posByKey[key]];
        target.quantidade += item.quantidade;
        if (item.preco) target.preco = item.preco;
      } else {
        posByKey[key] = consolidated.length;
        consolidated.push({ ...item });
      }
    });

    // 2) compara com o estoque atual: mescla no que já existe, cria o resto
    const toUpdate = [];
    const toCreate = [];
    consolidated.forEach((item) => {
      const existing = tires.find((t) => matchKey(t) === matchKey(item));
      if (existing) {
        toUpdate.push({
          id: existing.id,
          payload: {
            ...existing,
            quantidade: (Number(existing.quantidade) || 0) + item.quantidade,
            preco: item.preco || existing.preco,
            novo: true,
          },
        });
      } else {
        toCreate.push({ ...item, notaRef: notaRefValue });
      }
    });

    // 3) executa
    const updatedResults = await Promise.all(toUpdate.map((u) => api.update(u.id, u.payload)));
    updatedResults.forEach((res) => {
      const t = tires.find((x) => x.id === res.id);
      if (t) Object.assign(t, res);
    });

    let createdResults = [];
    if (toCreate.length > 0) {
      createdResults = await api.bulkCreate(toCreate);
      tires.push(...createdResults);
    }

    const dedupedCount = await mergeExistingDuplicates().catch((e) => {
      console.error('Falha ao mesclar duplicados:', e);
      return 0;
    });

    return { createdCount: createdResults.length, mergedCount: toUpdate.length, dedupedCount };
  }

  function summarizeCommit(createdCount, mergedCount, dedupedCount) {
    const parts = [];
    if (createdCount) parts.push(`${createdCount} novo(s)`);
    if (mergedCount) parts.push(`${mergedCount} somado(s) a itens já existentes`);
    if (dedupedCount) parts.push(`${dedupedCount} duplicado(s) mesclado(s)`);
    return parts.length ? parts.join(', ') + '.' : 'Nada para salvar.';
  }

  /* =========================================================================
     4. RECONHECIMENTO DE MARCA E MEDIDA A PARTIR DE TEXTO LIVRE
     Usado tanto na leitura do XML de NF-e quanto na importação de PDF —
     ambos chegam com uma descrição de produto em texto livre
     (ex: "175/65R14 82H UX ROYALE" ou "PNEU TRACMAX 175/75 R13 85T RADIAL109").
     É um "melhor esforço": sempre revisável na tela antes de salvar.
  ========================================================================= */

  const KNOWN_BRANDS = [
    'MICHELIN', 'PIRELLI', 'GOODYEAR', 'BRIDGESTONE', 'CONTINENTAL', 'FIRESTONE',
    'DUNLOP', 'DUNLOPP', 'WANLI', 'COMFORSER', 'TRACMAX', 'APTANY', 'MINERVA',
    'LANVIGATOR', 'FASTONE', 'LANDSPIDER', 'CITYTRAXX', 'DELMAX', 'MILEVER',
    'BLACKARROW', 'MAXZEZ', 'VECTRA', 'MAXXIS', 'TOYO', 'HANKOOK', 'KUMHO',
    'YOKOHAMA', 'FALKEN', 'NEXEN', 'LINGLONG', 'TRIANGLE', 'WESTLAKE', 'ROADX',
    'ATLAS', 'GITI', 'SAILUN', 'ANTARES', 'FORMULA', 'ROYALE', 'JK',
  ];

  function guessMarcaMedida(rawDescricao) {
    const text = String(rawDescricao || '').toUpperCase();

    const medidaMatch = text.match(/\d{3}\/\d{2,3}\s*R\s*\d{2}[A-Z]?/);
    let medida = medidaMatch ? medidaMatch[0].replace(/\s+/g, '') : '';
    medida = medida.replace(/(\d)(R)/, '$1 $2'); // "175/65R14" -> "175/65 R14"

    let rest = medidaMatch ? text.replace(medidaMatch[0], ' ') : text;
    rest = rest
      .replace(/\bPNEU\b/g, ' ')
      .replace(/\(IP\)/g, ' ')
      .replace(/\bXL\b/g, ' ')
      .replace(/\bTL\b/g, ' ')
      .replace(/\bRADIAL\d*\b/g, ' ')
      .replace(/\b\d{2,3}(\/\d{2,3})?[A-Z]{1,2}\b/g, ' '); // índice de carga/velocidade (80H, 88T, 106/104S)

    const words = rest.replace(/[^A-Z\s]/g, ' ').split(/\s+/).filter(Boolean);

    let marca = KNOWN_BRANDS.find((b) => words.includes(b)) || '';
    if (!marca && words.length) marca = words[0];
    marca = marca ? marca.charAt(0) + marca.slice(1).toLowerCase() : '';

    return { marca, medida };
  }

  /* =========================================================================
     5. CARREGAMENTO E RENDERIZAÇÃO
  ========================================================================= */

  // Cache offline: guarda a última lista carregada com sucesso no navegador,
  // pra continuar mostrando algo (modo leitura) se a API cair.
  function saveOfflineCache() {
    try {
      localStorage.setItem(OFFLINE_CACHE_KEY, JSON.stringify({ tires, savedAt: Date.now() }));
    } catch (e) {
      // localStorage indisponível (modo privado, cota cheia) — não é crítico.
    }
  }

  function loadOfflineCache() {
    try {
      const raw = localStorage.getItem(OFFLINE_CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function updatePaginationBar() {
    const hasMore = tires.length < tiresTotal;
    paginationBar.style.display = tiresTotal > 0 ? 'flex' : 'none';
    paginationInfo.textContent = `${tires.length} de ${tiresTotal} itens carregados`;
    document.getElementById('loadMoreBtn').style.display = hasMore ? 'inline-flex' : 'none';
  }

  async function load() {
    tiresOffset = 0;
    try {
      const page = await api.list(0, TIRES_PAGE_SIZE);
      tires = page.items;
      tiresTotal = page.total;
      tiresOffset = page.items.length;
      saveOfflineCache();
    } catch (e) {
      const cached = loadOfflineCache();
      if (cached) {
        tires = cached.tires;
        tiresTotal = tires.length;
        tiresOffset = tires.length;
        showToast(`Sem conexão com a API — mostrando dados salvos localmente (${timeAgo(cached.savedAt)}).`);
      } else {
        tires = [];
        tiresTotal = 0;
        showToast('Não foi possível conectar à API. Verifique se o backend está rodando.');
      }
      render();
      return;
    }

    // Mostra o estoque JÁ CARREGADO na tela imediatamente — a limpeza de
    // duplicados é só uma manutenção em segundo plano, não precisa travar
    // a tela de carregamento esperando ela terminar.
    render();

    try {
      const mergedCount = await mergeExistingDuplicates();
      if (mergedCount) {
        showToast(`${mergedCount} item(ns) duplicado(s) mesclado(s) automaticamente.`);
        render();
      }
    } catch (e) {
      console.error('Falha ao mesclar duplicados:', e);
    }
  }

  async function loadMore() {
    try {
      const page = await api.list(tiresOffset, TIRES_PAGE_SIZE);
      tires.push(...page.items);
      tiresTotal = page.total;
      tiresOffset += page.items.length;
      saveOfflineCache();
      render();
    } catch (e) {
      showToast('Não foi possível carregar mais itens. Tente novamente.');
    }
  }

  function renderStats() {
    const totalItens = tires.length;
    const totalUnidades = tires.reduce((s, t) => s + (Number(t.quantidade) || 0), 0);
    const baixoEstoque = tires.filter((t) => (Number(t.quantidade) || 0) <= 2).length;
    statsEl.innerHTML = `
      <div class="stat"><b>${totalItens}</b><span>Itens cadastrados</span></div>
      <div class="stat"><b>${totalUnidades}</b><span>Unidades em estoque</span></div>
      <div class="stat"><b>${baixoEstoque}</b><span>Com estoque baixo (≤2)</span></div>
    `;
    novoCount.textContent = tires.filter((t) => t.novo).length;
  }

  function applyFilters(list) {
    if (filterNovoOnly) list = list.filter((t) => t.novo);
    if (condFilter !== 'todos') list = list.filter((t) => (t.condicao || 'novo') === condFilter);

    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      if (q === 'novo' || q === 'novos' || q === 'tag:novo') {
        list = list.filter((t) => t.novo);
      } else {
        list = list.filter(
          (t) =>
            (t.marca || '').toLowerCase().includes(q) ||
            (t.medida || '').toLowerCase().includes(q) ||
            (t.notaRef || '').toLowerCase().includes(q)
        );
      }
    }
    return list;
  }

  function tireRowHtml(t) {
    const qtd = Number(t.quantidade) || 0;
    const low = qtd <= 2;
    const isOdd = qtd % 2 !== 0;
    return `
      <div class="row ${t.novo ? 'is-novo' : ''}" data-id="${t.id}">
        <div class="col col-brand">
          <label class="mobile-label">Marca</label>
          ${escapeHtml(t.marca || '—')}
          <span class="tag-cond ${t.condicao === 'usado' ? 'usado' : 'novo'}">${t.condicao === 'usado' ? 'Usado' : 'Novo'}</span>
          ${t.novo ? `<span class="tag-novo" title="Adicionado ${timeAgo(t.addedAt)}">recente</span>` : ''}
          ${isOdd ? `<span class="tag-impar" title="Quantidade ímpar — sobra um pneu avulso">ímpar</span>` : ''}
          ${t.origem === 'empresa' ? `<span class="tag-empresa" title="Sincronizado do relatório da empresa">🏢 empresa</span>` : ''}
          ${t.fornecedor ? `<span class="tag-fornecedor" title="Fornecedor">${escapeHtml(t.fornecedor)}</span>` : ''}
        </div>
        <div class="col col-size">
          <label class="mobile-label">Medida</label>
          ${escapeHtml(t.medida || '—')}
        </div>
        <div class="col">
          <label class="mobile-label">Qtd.</label>
          <span class="qty-pill ${low ? 'low' : ''}">${qtd} un.</span>
        </div>
        <div class="col col-price">
          <label class="mobile-label">Preço</label>
          ${formatPrice(t.preco) || '—'}
        </div>
        <div class="col col-date">
          <label class="mobile-label">Adicionado em</label>
          <span title="${escapeHtml(formatDateTime(t.addedAt))}">${formatDate(t.addedAt)}</span>
        </div>
        <div class="col col-actions">
          ${t.novo ? `<button class="icon-btn check-btn" title="Marcar como visto" data-id="${t.id}">✓</button>` : ''}
          <button class="icon-btn edit-btn" title="Editar" data-id="${t.id}">✎</button>
          <button class="icon-btn del-btn" title="Excluir" data-id="${t.id}">🗑</button>
        </div>
      </div>`;
  }

  function bindRowActions() {
    contentEl.querySelectorAll('.edit-btn').forEach((btn) => {
      btn.onclick = () => openEditForm(btn.dataset.id);
    });
    contentEl.querySelectorAll('.del-btn').forEach((btn) => {
      btn.onclick = () => confirmDelete(btn);
    });
    contentEl.querySelectorAll('.check-btn').forEach((btn) => {
      btn.onclick = () => markViewed(btn.dataset.id);
    });
  }

  function render() {
    renderStats();
    updatePaginationBar();
    saveOfflineCache();

    let list = applyFilters(tires.slice());

    novoChip.classList.toggle('active', filterNovoOnly);
    document.querySelectorAll('#condFilterGroup .chip').forEach((c) => {
      c.classList.toggle('active', c.dataset.cond === condFilter);
    });
    sortModeSelect.value = sortMode;

    if (tires.length === 0) {
      contentEl.innerHTML = `
        <div class="empty">
          <div class="brand-mark"></div>
          <h3>Nenhum pneu cadastrado</h3>
          <p>Adicione o primeiro item para começar a controlar seu estoque.</p>
          <button class="btn btn-primary" id="emptyAddBtn">+ Novo pneu</button>
        </div>`;
      document.getElementById('emptyAddBtn').onclick = openAddForm;
      return;
    }

    if (list.length === 0) {
      contentEl.innerHTML = `
        <div class="empty">
          <h3>Nada encontrado</h3>
          <p>Nenhum item corresponde ao filtro atual.</p>
        </div>`;
      return;
    }

    const FLAT_SORTS = {
      qtd_asc: { label: 'Menor quantidade primeiro', cmp: (a, b) => (Number(a.quantidade) || 0) - (Number(b.quantidade) || 0) },
      qtd_desc: { label: 'Maior quantidade primeiro', cmp: (a, b) => (Number(b.quantidade) || 0) - (Number(a.quantidade) || 0) },
      data_desc: { label: 'Mais recentes primeiro', cmp: (a, b) => (b.addedAt || 0) - (a.addedAt || 0) },
      data_asc: { label: 'Mais antigos primeiro', cmp: (a, b) => (a.addedAt || 0) - (b.addedAt || 0) },
    };

    if (FLAT_SORTS[sortMode]) {
      const { label, cmp } = FLAT_SORTS[sortMode];
      list.sort(cmp);
      contentEl.innerHTML = `
        <div class="group">
          <div class="group-head">
            <h3>${label}</h3>
            <span class="group-count">${list.length} ${list.length === 1 ? 'item' : 'itens'}</span>
          </div>
          ${list.map(tireRowHtml).join('')}
        </div>`;
      bindRowActions();
      return;
    }

    // Agrupa por aro (R13 -> R20), sem aro identificado por último.
    const groups = {};
    list.forEach((t) => {
      const aro = parseAro(t.medida);
      const key = aro || 'other';
      (groups[key] = groups[key] || []).push(t);
    });

    const orderedKeys = Object.keys(groups).sort((a, b) => {
      if (a === 'other') return 1;
      if (b === 'other') return -1;
      return Number(a) - Number(b);
    });

    let html = '';
    orderedKeys.forEach((key) => {
      const items = groups[key].sort((a, b) => {
        const m = (a.marca || '').localeCompare(b.marca || '', 'pt-BR');
        return m !== 0 ? m : (a.medida || '').localeCompare(b.medida || '', 'pt-BR');
      });
      const label = key === 'other' ? 'Sem aro definido' : `R${key}`;
      html += `<div class="group">
        <div class="group-head">
          <div class="tire-badge"><span>${key === 'other' ? '—' : 'R' + key}</span></div>
          <h3>${label}</h3>
          <span class="group-count">${items.length} ${items.length === 1 ? 'item' : 'itens'}</span>
        </div>
        ${items.map(tireRowHtml).join('')}
      </div>`;
    });

    contentEl.innerHTML = html;
    bindRowActions();
  }

  /* =========================================================================
     6. AÇÕES SOBRE ITENS (marcar visto, excluir)
  ========================================================================= */

  async function markViewed(id) {
    const t = tires.find((x) => x.id === id);
    if (!t) return;
    const updated = { ...t, novo: false };
    try {
      await api.update(id, updated);
      t.novo = false;
      render();
      showToast('Item marcado como visto.');
    } catch (e) {
      showToast('Não foi possível salvar. Tente novamente.');
    }
  }

  function confirmDelete(btn) {
    if (btn.classList.contains('confirm')) {
      deleteTire(btn.dataset.id);
      return;
    }
    const original = btn.innerHTML;
    btn.classList.add('confirm');
    btn.innerHTML = 'Confirmar';
    setTimeout(() => {
      if (btn.classList.contains('confirm')) {
        btn.classList.remove('confirm');
        btn.innerHTML = original;
      }
    }, 3000);
  }

  // Exclusão com "desfazer": some da tela na hora, mas só chama a API depois
  // de UNDO_DELAY_MS — se o usuário clicar em "Desfazer" antes disso, cancela
  // e o item volta pro lugar.
  const UNDO_DELAY_MS = 5000;
  const pendingDeletes = {}; // id -> { tire, timer }

  function deleteTire(id) {
    const idx = tires.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const [tire] = tires.splice(idx, 1);
    render();

    const timer = setTimeout(async () => {
      delete pendingDeletes[id];
      try {
        await api.remove(id);
      } catch (e) {
        tires.push(tire);
        render();
        showToast('Não foi possível excluir. Tente novamente.');
      }
    }, UNDO_DELAY_MS);

    pendingDeletes[id] = { tire, idx };
    showToast('Pneu removido do estoque.', {
      actionLabel: 'Desfazer',
      duration: UNDO_DELAY_MS,
      onAction: () => {
        const pending = pendingDeletes[id];
        if (!pending) return;
        clearTimeout(timer);
        delete pendingDeletes[id];
        tires.splice(Math.min(pending.idx, tires.length), 0, pending.tire);
        render();
        showToast('Exclusão desfeita.');
      },
    });
  }

  /* =========================================================================
     7. FORMULÁRIO MANUAL (adicionar / editar um item)
  ========================================================================= */

  function openAddForm(prefillCodigoBarras) {
    switchTab('estoque');
    closeXmlPanel();
    closeImportPanel();
    closeSyncPanel();
    closeScanFlow();
    closeScanOnceModal();
    editingId = null;
    formTitle.textContent = 'Adicionar pneu';
    fMarca.value = '';
    fMedida.value = '';
    fQtd.value = '';
    fPreco.value = '';
    fCondicao.value = 'novo';
    fFornecedor.value = '';
    fCodigoBarras.value = prefillCodigoBarras || '';
    formErr.classList.remove('show');
    formPanel.classList.add('open');
    fMarca.focus();
  }

  function openEditForm(id) {
    switchTab('estoque');
    closeXmlPanel();
    closeImportPanel();
    closeSyncPanel();
    closeScanFlow();
    closeScanOnceModal();
    const t = tires.find((x) => x.id === id);
    if (!t) return;
    editingId = id;
    formTitle.textContent = 'Editar pneu';
    fMarca.value = t.marca || '';
    fMedida.value = t.medida || '';
    fQtd.value = t.quantidade ?? '';
    fPreco.value = t.preco ?? '';
    fCondicao.value = t.condicao === 'usado' ? 'usado' : 'novo';
    fFornecedor.value = t.fornecedor ?? '';
    fCodigoBarras.value = t.codigoBarras ?? '';
    formErr.classList.remove('show');
    formPanel.classList.add('open');
    fMarca.focus();
  }

  function closeForm() {
    formPanel.classList.remove('open');
    editingId = null;
    formErr.classList.remove('show');
  }

  async function saveTire() {
    const marca = fMarca.value.trim();
    const medida = fMedida.value.trim();
    const qtd = fQtd.value.trim();
    const preco = fPreco.value.trim();
    const condicao = fCondicao.value;
    const fornecedor = fFornecedor.value.trim();
    const codigoBarras = fCodigoBarras.value.trim();

    if (!marca || !medida || qtd === '') {
      formErr.textContent = 'Preencha marca, medida e quantidade.';
      formErr.classList.add('show');
      return;
    }
    if (!validMedida(medida)) {
      formErr.textContent = 'Informe o aro no formato R13 a R20 (ex: 185/65 R14).';
      formErr.classList.add('show');
      return;
    }
    if (isNaN(Number(qtd)) || Number(qtd) < 0) {
      formErr.textContent = 'Quantidade inválida.';
      formErr.classList.add('show');
      return;
    }

    try {
      if (editingId) {
        const t = tires.find((x) => x.id === editingId);
        const voltouParaLocal = t.origem === 'empresa';
        const updated = { ...t, marca, medida, quantidade: Number(qtd), preco, condicao, fornecedor: fornecedor || null, codigoBarras: codigoBarras || null, origem: 'local' };
        await api.update(editingId, updated);
        Object.assign(t, updated);
        closeForm();
        render();
        showToast(
          voltouParaLocal
            ? 'Pneu atualizado — agora está marcado como origem local.'
            : 'Pneu atualizado.'
        );
      } else {
        const { mergedCount, dedupedCount } = await commitItems(
          [{ marca, medida, quantidade: Number(qtd), preco, condicao, fornecedor: fornecedor || null, codigoBarras: codigoBarras || null, novo: true, notaRef: null, origem: 'local' }],
          null
        );
        closeForm();
        render();
        showToast(
          mergedCount
            ? `Esse pneu já estava no estoque — quantidade somada (+${qtd} un.).`
            : dedupedCount
            ? `Pneu adicionado — e ${dedupedCount} duplicado(s) mesclado(s) no estoque.`
            : 'Pneu adicionado ao estoque.'
        );
      }
    } catch (e) {
      formErr.textContent = e.message || 'Não foi possível salvar. Verifique sua conexão com a API.';
      formErr.classList.add('show');
    }
  }

  /* =========================================================================
     8. LINHAS DE LOTE (compartilhadas entre XML e importação de planilha/PDF)
  ========================================================================= */

  function addBatchRow(containerId, prefill) {
    prefill = prefill || {};
    batchRowCount++;
    const div = document.createElement('div');
    div.className = 'batch-row';
    div.dataset.rowId = 'b' + batchRowCount;
    div.innerHTML = `
      <div class="field"><label>Marca / modelo</label><input type="text" class="b-marca" placeholder="Ex: Goodyear Assurance"></div>
      <div class="field"><label>Medida</label><input type="text" class="b-medida" placeholder="Ex: 195/60 R15"></div>
      <div class="field"><label>Qtd.</label><input type="number" class="b-qtd" min="0" step="1" placeholder="0"></div>
      <div class="field"><label>Preço (R$)</label><input type="text" class="b-preco" placeholder="Opcional"></div>
      <div class="field"><label>Condição</label>
        <select class="b-condicao">
          <option value="novo">Novo</option>
          <option value="usado">Usado</option>
        </select>
      </div>
      <div class="field"><label>Fornecedor</label><input type="text" class="b-fornecedor" placeholder="Opcional"></div>
      <button class="rm" title="Remover linha">✕</button>
    `;
    if (prefill.marca) div.querySelector('.b-marca').value = prefill.marca;
    if (prefill.medida) div.querySelector('.b-medida').value = prefill.medida;
    if (prefill.quantidade !== undefined && prefill.quantidade !== '') div.querySelector('.b-qtd').value = prefill.quantidade;
    if (prefill.preco) div.querySelector('.b-preco').value = prefill.preco;
    if (prefill.condicao === 'usado') div.querySelector('.b-condicao').value = 'usado';
    if (prefill.fornecedor) div.querySelector('.b-fornecedor').value = prefill.fornecedor;
    div.querySelector('.rm').onclick = () => div.remove();
    document.getElementById(containerId).appendChild(div);
    return div;
  }

  function rowsToItems(containerId, errEl, notaRefValue, origem) {
    const rows = document.querySelectorAll(`#${containerId} .batch-row`);
    const items = [];
    for (const row of rows) {
      const marca = row.querySelector('.b-marca').value.trim();
      const medida = row.querySelector('.b-medida').value.trim();
      const qtd = row.querySelector('.b-qtd').value.trim();
      const preco = row.querySelector('.b-preco').value.trim();
      const condicao = row.querySelector('.b-condicao').value;
      const fornecedor = row.querySelector('.b-fornecedor').value.trim();
      if (!marca && !medida && !qtd) continue; // linha vazia, ignora
      if (!marca || !medida || qtd === '' || !validMedida(medida)) {
        errEl.textContent = 'Verifique se todas as linhas têm marca, medida válida (R13–R20) e quantidade.';
        errEl.classList.add('show');
        return null;
      }
      items.push({
        marca, medida, quantidade: Number(qtd), preco, condicao, fornecedor: fornecedor || null,
        novo: true, notaRef: notaRefValue, origem: origem === 'empresa' ? 'empresa' : 'local',
      });
    }
    return items;
  }

  /* =========================================================================
     9. ENTRADA POR XML (NF-e)
     O XML da nota fiscal traz os produtos de verdade (marca/medida via
     descrição, quantidade e valor unitário) — diferente do código de barras,
     que só tem a chave da nota. Por isso trocamos o scanner por câmera por
     upload direto do arquivo .xml.
  ========================================================================= */

  function parseNFeXml(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    if (doc.querySelector('parsererror')) {
      throw new Error('Esse arquivo não é um XML válido.');
    }

    const infNFe = doc.querySelector('infNFe');
    let chave = null;
    if (infNFe) {
      const digits = (infNFe.getAttribute('Id') || '').replace(/\D/g, '');
      if (digits.length >= 44) chave = digits.slice(-44);
    }

    const dets = Array.from(doc.querySelectorAll('det'));
    if (dets.length === 0) {
      throw new Error('Não encontrei produtos nesse XML. Confira se é o arquivo de NF-e correto.');
    }

    const items = dets
      .map((det) => {
        const prod = det.querySelector('prod');
        if (!prod) return null;
        const xProd = prod.querySelector('xProd')?.textContent || '';
        const qCom = prod.querySelector('qCom')?.textContent || '';
        const vUnCom = prod.querySelector('vUnCom')?.textContent || '';
        const { marca, medida } = guessMarcaMedida(xProd);
        return {
          marca,
          medida,
          quantidade: qCom ? Math.round(parseFloat(qCom)) : '',
          preco: vUnCom ? Number(vUnCom).toFixed(2).replace('.', ',') : '',
        };
      })
      .filter(Boolean);

    return { chave, items };
  }

  function openXmlPanel() {
    switchTab('estoque');
    closeForm();
    closeImportPanel();
    closeSyncPanel();
    closeScanFlow();
    closeScanOnceModal();
    xmlPanel.classList.add('open');
    document.getElementById('xmlStatus').style.display = 'none';
    document.getElementById('xmlResult').style.display = 'none';
    document.getElementById('xmlFileInput').value = '';
    xmlNota = null;
  }

  function closeXmlPanel() {
    xmlPanel.classList.remove('open');
  }

  async function handleXmlUpload(file) {
    const statusEl = document.getElementById('xmlStatus');
    statusEl.style.display = 'block';
    statusEl.textContent = 'Lendo o XML...';
    document.getElementById('xmlResult').style.display = 'none';

    try {
      const text = await file.text();
      const { chave, items } = parseNFeXml(text);

      xmlNota = { chave };
      statusEl.style.display = 'none';
      document.getElementById('xmlResult').style.display = 'block';
      document.getElementById('xmlChaveShown').textContent = chave ? chave.slice(-8) + ' (final)' : 'não identificada';

      document.getElementById('xmlRows').innerHTML = '';
      batchRowCount = 0;
      items.forEach((item) => addBatchRow('xmlRows', item));
      showToast(`${items.length} produto(s) lidos do XML. Confira antes de salvar.`);
    } catch (err) {
      statusEl.textContent = err.message || 'Não foi possível ler esse XML.';
    }
  }

  async function saveXml() {
    const xmlErr = document.getElementById('xmlErr');
    xmlErr.classList.remove('show');

    const notaRefValue = xmlNota && xmlNota.chave ? xmlNota.chave.slice(-8) : 'XML s/ chave';
    const newItems = rowsToItems('xmlRows', xmlErr, notaRefValue, 'local');
    if (newItems === null) return;

    if (newItems.length === 0) {
      xmlErr.textContent = 'Nenhum item para salvar.';
      xmlErr.classList.add('show');
      return;
    }

    try {
      const { createdCount, mergedCount, dedupedCount } = await commitItems(newItems, notaRefValue);
      closeXmlPanel();
      render();
      showToast(summarizeCommit(createdCount, mergedCount, dedupedCount));
    } catch (e) {
      xmlErr.textContent = 'Não foi possível salvar os itens. Verifique sua conexão com a API.';
      xmlErr.classList.add('show');
    }
  }

  /* =========================================================================
     10. IMPORTAÇÃO POR PLANILHA (Excel/CSV) OU PDF DE RELATÓRIO
     O xlsx e o pdf.js são bibliotecas pesadas usadas só nessa tela — em vez
     de carregá-las em toda visita ao site, elas só são baixadas na primeira
     vez que o usuário realmente abre a importação. Isso deixa o carregamento
     inicial do app bem mais rápido.
  ========================================================================= */

  const SCRIPT_LOAD_TIMEOUT_MS = 12000;
  const scriptLoadCache = {};
  function loadScriptOnce(src) {
    if (!scriptLoadCache[src]) {
      scriptLoadCache[src] = new Promise((resolve, reject) => {
        let settled = false;
        const fail = (err) => {
          if (settled) return;
          settled = true;
          // Tira do cache pra uma próxima tentativa (ex: usuário clicando de
          // novo depois de desativar o bloqueador) realmente tentar de novo
          // — sem isso, uma falha aqui deixava toda tentativa futura presa
          // numa promise já rejeitada pra sempre.
          delete scriptLoadCache[src];
          reject(err);
        };

        const timer = setTimeout(() => {
          fail(new Error('A biblioteca demorou demais pra carregar. Verifique sua conexão ou desative bloqueadores de anúncio/rastreamento e tente de novo.'));
        }, SCRIPT_LOAD_TIMEOUT_MS);

        const tag = document.createElement('script');
        tag.src = src;
        tag.onload = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        tag.onerror = () => {
          clearTimeout(timer);
          fail(new Error('Não foi possível carregar uma biblioteca externa. Verifique sua conexão ou desative bloqueadores de anúncio/rastreamento e tente de novo.'));
        };
        document.head.appendChild(tag);
      });
    }
    return scriptLoadCache[src];
  }

  // xlsx, jsPDF e o plugin de tabela ficam vendorizados em frontend/vendor/
  // (em vez de vir de CDN) porque a exportação depende deles e um
  // bloqueador de anúncio/DNS filtrando o CDN travava a exportação por
  // completo, sem alternativa — servindo do próprio domínio isso não
  // depende de nenhum host externo.
  const XLSX_CDN = 'vendor/xlsx.full.min.js';
  const PDFJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  const JSPDF_CDN = 'vendor/jspdf.umd.min.js';
  const JSPDF_AUTOTABLE_CDN = 'vendor/jspdf.plugin.autotable.min.js';

  async function ensureXLSX() {
    if (typeof XLSX === 'undefined') await loadScriptOnce(XLSX_CDN);
  }
  async function ensurePdfJs() {
    if (typeof pdfjsLib === 'undefined') await loadScriptOnce(PDFJS_CDN);
  }
  // Gera PDF (relatório de exportação) — diferente do pdf.js acima, que só lê PDF.
  async function ensureJsPdfGenerator() {
    if (typeof window.jspdf === 'undefined') await loadScriptOnce(JSPDF_CDN);
    if (typeof window.jspdf.jsPDF.API.autoTable === 'undefined') await loadScriptOnce(JSPDF_AUTOTABLE_CDN);
  }

  function normalizeHeader(h) {
    return String(h || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  }

  const HEADER_MAP = {
    marca: 'marca', modelo: 'marca',
    medida: 'medida', tamanho: 'medida', aro: 'medida',
    quantidade: 'quantidade', qtd: 'quantidade', qtde: 'quantidade',
    preco: 'preco', valor: 'preco', 'preco unitario': 'preco', 'valor unitario': 'preco', 'r$ venda': 'preco',
    condicao: 'condicao', estado: 'condicao',
  };

  async function parseSpreadsheet(file) {
    await ensureXLSX();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const workbook = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          resolve(XLSX.utils.sheet_to_json(sheet, { defval: '' }));
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
      reader.readAsArrayBuffer(file);
    });
  }

  function mapSpreadsheetRow(row) {
    const mapped = {};
    Object.keys(row).forEach((key) => {
      const canonical = HEADER_MAP[normalizeHeader(key)];
      if (canonical) mapped[canonical] = String(row[key]).trim();
    });
    if (mapped.condicao) mapped.condicao = /usad/i.test(mapped.condicao) ? 'usado' : 'novo';
    return mapped;
  }

  /**
   * Extrai o texto de um PDF preservando a ordem de leitura (linha por linha,
   * esquerda pra direita) — sem isso, o texto de um PDF com tabelas costuma
   * sair fora de ordem.
   */
  async function extractPdfLines(file) {
    await ensurePdfJs();
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    const buffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    const lines = [];

    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();

      const byLine = {};
      content.items.forEach((it) => {
        const y = Math.round(it.transform[5]);
        (byLine[y] = byLine[y] || []).push({ x: it.transform[4], text: it.str });
      });

      Object.keys(byLine)
        .map(Number)
        .sort((a, b) => b - a) // de cima pra baixo
        .forEach((y) => {
          const line = byLine[y].sort((a, b) => a.x - b.x).map((i) => i.text).join(' ');
          if (line.trim()) lines.push(line.trim());
        });
    }
    return lines;
  }

  /**
   * Interpreta uma linha de relatório de estoque no formato:
   * "<descrição> <referência de 10+ dígitos> <números...> <lucro%>"
   * Em vez de assumir uma ordem fixa de colunas (que varia entre relatórios),
   * identifica o valor de venda pela relação matemática: venda × estoque ≈ total.
   */
  function parseStockReportLine(line) {
    const refMatch = line.match(/\d{10,}/);
    if (!refMatch) return null;

    const descricao = line.slice(0, refMatch.index).trim();
    if (!descricao) return null;

    const afterRef = line.slice(refMatch.index + refMatch[0].length);
    const lucroMatch = afterRef.match(/[\d.,]+\s*%/);
    const beforeLucro = lucroMatch ? afterRef.slice(0, lucroMatch.index) : afterRef;

    const numTokens = (beforeLucro.match(/\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}/g) || []).map((t) =>
      parseFloat(t.replace(/\./g, '').replace(',', '.'))
    );
    if (numTokens.length < 3) return null;

    const estoque = numTokens[0];
    const rest = numTokens.slice(1);

    let vendaUnit = null;
    for (let i = 0; i < rest.length && vendaUnit === null; i++) {
      for (let j = 0; j < rest.length; j++) {
        if (i === j) continue;
        if (estoque > 0 && Math.abs(rest[i] * estoque - rest[j]) < 0.5) {
          vendaUnit = rest[i];
          break;
        }
      }
    }
    if (vendaUnit === null) return null;

    const { marca, medida } = guessMarcaMedida(descricao);
    if (!medida) return null;

    return {
      marca,
      medida,
      quantidade: Math.round(estoque),
      preco: vendaUnit.toFixed(2).replace('.', ','),
    };
  }

  async function parsePdfReport(file) {
    const lines = await extractPdfLines(file);
    const items = lines.map(parseStockReportLine).filter(Boolean);
    if (items.length === 0) {
      throw new Error(
        'Não consegui reconhecer nenhum pneu nesse PDF. O formato pode ser diferente do esperado — ' +
        'tente exportar como Excel/CSV, ou cadastre manualmente.'
      );
    }
    return items;
  }

  function openImportPanel() {
    switchTab('estoque');
    closeForm();
    closeXmlPanel();
    closeSyncPanel();
    closeScanFlow();
    closeScanOnceModal();
    importPanel.classList.add('open');
    document.getElementById('importRows').innerHTML = '';
    document.getElementById('importErr').classList.remove('show');
    document.getElementById('importStatus').style.display = 'none';
    document.getElementById('importFileInput').value = '';
  }

  function closeImportPanel() {
    importPanel.classList.remove('open');
  }

  async function downloadTemplate() {
    await ensureXLSX();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Marca', 'Medida', 'Quantidade', 'Preço', 'Condição'],
      ['Pirelli', '185/65 R14', 4, '350', 'Novo'],
      ['Michelin', '225/45 R18', 2, '', 'Usado'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Pneus');
    XLSX.writeFile(wb, 'modelo-importacao-pneus.xlsx');
  }

  async function handleImportUpload(file) {
    const statusEl = document.getElementById('importStatus');
    const importErr = document.getElementById('importErr');
    importErr.classList.remove('show');
    statusEl.style.display = 'block';
    statusEl.textContent = 'Lendo o arquivo...';

    try {
      const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
      const rows = isPdf ? await parsePdfReport(file) : (await parseSpreadsheet(file)).map(mapSpreadsheetRow);

      if (rows.length === 0) {
        statusEl.textContent = 'Nenhuma linha reconhecida nesse arquivo.';
        return;
      }

      document.getElementById('importRows').innerHTML = '';
      batchRowCount = 0;
      rows.forEach((row) => addBatchRow('importRows', row));
      statusEl.style.display = 'none';
      showToast(`${rows.length} linha(s) lidas. Confira antes de salvar.`);
    } catch (err) {
      statusEl.textContent = err.message || 'Não foi possível ler esse arquivo.';
    }
  }

  async function saveImport() {
    const importErr = document.getElementById('importErr');
    importErr.classList.remove('show');

    const newItems = rowsToItems('importRows', importErr, 'importação', 'local');
    if (newItems === null) return;

    if (newItems.length === 0) {
      importErr.textContent = 'Nenhum item válido para importar.';
      importErr.classList.add('show');
      return;
    }

    try {
      const { createdCount, mergedCount, dedupedCount } = await commitItems(newItems, 'importação');
      closeImportPanel();
      render();
      showToast(summarizeCommit(createdCount, mergedCount, dedupedCount));
    } catch (e) {
      importErr.textContent = 'Não foi possível salvar os itens. Verifique sua conexão com a API.';
      importErr.classList.add('show');
    }
  }

  /* =========================================================================
     10b. SINCRONIZAÇÃO COM O RELATÓRIO DA EMPRESA
     Diferente da importação comum (que SOMA quantidade a itens locais), a
     sincronização SUBSTITUI a quantidade dos itens de origem "empresa" pelo
     valor do relatório mais recente — e zera os itens de origem "empresa"
     que não aparecem mais no relatório novo (venderam/saíram de lá).
     Itens de origem "local" nunca são tocados por essa sincronização.
  ========================================================================= */

  async function syncCompanyStock(companyItems) {
    // 1) soma duplicados dentro do próprio relatório
    const consolidated = [];
    const posByKey = {};
    companyItems.forEach((item) => {
      const key = companyMatchKey(item);
      if (posByKey[key] !== undefined) {
        const target = consolidated[posByKey[key]];
        target.quantidade += item.quantidade;
        if (item.preco) target.preco = item.preco;
      } else {
        posByKey[key] = consolidated.length;
        consolidated.push({ ...item });
      }
    });

    const seenKeys = new Set(consolidated.map(companyMatchKey));
    const toCreate = [];
    const toUpdate = [];

    // 2) para cada item do relatório: procura um pneu equivalente no estoque,
    // seja ele de origem "local" (cadastrado manualmente) ou "empresa" (de uma
    // sincronização anterior). Se achar, a quantidade é SUBSTITUÍDA pela do
    // relatório e a origem passa a ser "empresa" — a partir daí, esse item é
    // rastreado pela empresa. Se não achar, cria um item novo já como "empresa".
    consolidated.forEach((item) => {
      const existing = tires.find((t) => companyMatchKey(t) === companyMatchKey(item));
      if (existing) {
        toUpdate.push({
          id: existing.id,
          payload: {
            ...existing,
            quantidade: item.quantidade,
            preco: item.preco || existing.preco,
            origem: 'empresa',
            novo: true,
          },
        });
      } else {
        toCreate.push({ ...item, origem: 'empresa', notaRef: 'sincronização empresa' });
      }
    });

    // 3) itens já rastreados como "empresa" que sumiram do relatório novo são
    // zerados (saíram do estoque de lá). Itens "local" que nunca bateram com
    // nenhum relatório continuam de fora dessa lista — nunca são zerados aqui.
    tires
      .filter((t) => t.origem === 'empresa' && !seenKeys.has(companyMatchKey(t)))
      .forEach((t) => {
        toUpdate.push({ id: t.id, payload: { ...t, quantidade: 0 } });
      });

    const updatedResults = await Promise.all(toUpdate.map((u) => api.update(u.id, u.payload)));
    updatedResults.forEach((res) => {
      const t = tires.find((x) => x.id === res.id);
      if (t) Object.assign(t, res);
    });

    let createdResults = [];
    if (toCreate.length > 0) {
      createdResults = await api.bulkCreate(toCreate);
      tires.push(...createdResults);
    }

    const dedupedCount = await mergeExistingDuplicates().catch((e) => {
      console.error('Falha ao mesclar duplicados:', e);
      return 0;
    });

    return { createdCount: createdResults.length, updatedCount: toUpdate.length, dedupedCount };
  }

  function openSyncPanel() {
    switchTab('estoque');
    closeForm();
    closeXmlPanel();
    closeImportPanel();
    closeScanFlow();
    closeScanOnceModal();
    syncPanel.classList.add('open');
    document.getElementById('syncRows').innerHTML = '';
    document.getElementById('syncErr').classList.remove('show');
    document.getElementById('syncStatus').style.display = 'none';
    document.getElementById('syncFileInput').value = '';
  }

  function closeSyncPanel() {
    syncPanel.classList.remove('open');
  }

  /* =========================================================================
     10c. HISTÓRICO DE MOVIMENTAÇÕES
  ========================================================================= */

  const HISTORY_ACAO_LABEL = {
    criado: '🆕 Criado',
    editado: '✏️ Editado',
    excluido: '🗑️ Excluído',
    entrada: '⬆️ Entrada',
    saida: '⬇️ Saída',
  };

  const HISTORY_CAMPO_LABEL = {
    marca: 'marca',
    medida: 'medida',
    preco: 'preço',
    quantidade: 'quantidade',
  };

  function historyEntryText(h) {
    const item = `${h.marca} ${h.medida}`;
    switch (h.acao) {
      case 'criado':
        return `${item} — adicionado ao estoque (${h.valorNovo ?? '?'} un.)`;
      case 'excluido':
        return `${item} — removido do estoque (tinha ${h.valorAnterior ?? '?'} un.)`;
      case 'entrada':
        return `${item} — quantidade subiu de ${h.valorAnterior} para ${h.valorNovo} un.`;
      case 'saida':
        return `${item} — quantidade caiu de ${h.valorAnterior} para ${h.valorNovo} un.`;
      case 'editado': {
        const campo = HISTORY_CAMPO_LABEL[h.campo] || h.campo;
        const de = h.campo === 'preco' ? formatPrice(h.valorAnterior) || '—' : (h.valorAnterior || '—');
        const para = h.campo === 'preco' ? formatPrice(h.valorNovo) || '—' : (h.valorNovo || '—');
        return `${item} — ${campo} alterado de "${de}" para "${para}"`;
      }
      default:
        return item;
    }
  }

  function populateHistoryTireFilter() {
    const sel = document.getElementById('historyTireFilter');
    const current = sel.value;
    const options = tires
      .slice()
      .sort((a, b) => (a.marca || '').localeCompare(b.marca || '', 'pt-BR'))
      .map((t) => `<option value="${t.id}">${escapeHtml(t.marca)} ${escapeHtml(t.medida)}</option>`)
      .join('');
    sel.innerHTML = '<option value="">Todos os pneus</option>' + options;
    sel.value = current;
  }

  async function loadAndRenderHistory() {
    const statusEl = document.getElementById('historyStatus');
    const listEl = document.getElementById('historyList');
    statusEl.style.display = 'block';
    statusEl.textContent = 'Carregando histórico...';
    listEl.innerHTML = '';

    const filters = {
      tireId: document.getElementById('historyTireFilter').value || null,
      from: document.getElementById('historyFromFilter').value || null,
      to: document.getElementById('historyToFilter').value || null,
    };

    try {
      const entries = await api.history(null, filters);
      statusEl.style.display = 'none';

      if (!entries.length) {
        listEl.innerHTML = '<p class="sub">Nenhuma movimentação encontrada para esse filtro.</p>';
        return;
      }

      listEl.innerHTML = entries.map((h) => `
        <div class="history-row">
          <span class="history-acao">${HISTORY_ACAO_LABEL[h.acao] || h.acao}</span>
          <span class="history-text">${escapeHtml(historyEntryText(h))}</span>
          <span class="history-date">${formatDateTime(h.createdAt)}</span>
        </div>
      `).join('');
    } catch (e) {
      statusEl.textContent = 'Não foi possível carregar o histórico. Verifique sua conexão com a API.';
    }
  }

  /* =========================================================================
     10d. DASHBOARD DE MOVIMENTAÇÕES
     Gráfico simples de barras (sem biblioteca) com entradas x saídas por dia,
     lidos do histórico dos últimos 14 dias.
  ========================================================================= */

  const DASHBOARD_DAYS = 14;

  function dateKey(d) {
    return d.toISOString().slice(0, 10);
  }

  async function loadAndRenderDashboard() {
    const statusEl = document.getElementById('dashboardStatus');
    const chartEl = document.getElementById('dashboardChart');
    statusEl.style.display = 'block';
    statusEl.textContent = 'Carregando movimentações...';
    chartEl.innerHTML = '';

    const today = new Date();
    const from = new Date(today);
    from.setDate(from.getDate() - (DASHBOARD_DAYS - 1));

    try {
      const entries = await api.history(2000, { from: dateKey(from) });
      statusEl.style.display = 'none';

      const byDay = {};
      for (let i = 0; i < DASHBOARD_DAYS; i++) {
        const d = new Date(from);
        d.setDate(d.getDate() + i);
        byDay[dateKey(d)] = { entrada: 0, saida: 0 };
      }

      entries.forEach((h) => {
        if (h.acao !== 'entrada' && h.acao !== 'saida') return;
        const key = dateKey(new Date(h.createdAt));
        if (!byDay[key]) return;
        const delta = Math.abs(Number(h.valorNovo) - Number(h.valorAnterior)) || 0;
        byDay[key][h.acao] += delta;
      });

      const days = Object.keys(byDay).sort();
      const maxVal = Math.max(1, ...days.map((k) => Math.max(byDay[k].entrada, byDay[k].saida)));

      chartEl.innerHTML = days.map((k) => {
        const { entrada, saida } = byDay[k];
        const label = new Date(k + 'T00:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        return `
          <div class="dash-bar-wrap" title="${label}: ${entrada} entrada(s), ${saida} saída(s)">
            <div class="dash-bars">
              <div class="dash-bar entrada" style="height:${(entrada / maxVal) * 100}%"></div>
              <div class="dash-bar saida" style="height:${(saida / maxVal) * 100}%"></div>
            </div>
            <span class="dash-bar-label">${label}</span>
          </div>`;
      }).join('') + `
        <style>#dashboardChart{align-items:flex-end;}</style>
      `;

      if (!document.getElementById('dashLegend')) {
        const legend = document.createElement('div');
        legend.id = 'dashLegend';
        legend.className = 'dash-legend';
        legend.innerHTML = `
          <span><i style="background:var(--green)"></i> Entradas</span>
          <span><i style="background:var(--rust)"></i> Saídas</span>
        `;
        chartEl.after(legend);
      }
    } catch (e) {
      statusEl.textContent = 'Não foi possível carregar o dashboard. Verifique sua conexão com a API.';
    }
  }

  /* =========================================================================
     10f. EXPORTAR ESTOQUE (Excel) — aba "Exportar" com pré-visualização
  ========================================================================= */

  const EXPORT_COLUMNS = [
    { key: 'marca', label: 'Marca / modelo', value: (t) => t.marca },
    { key: 'medida', label: 'Medida', value: (t) => t.medida },
    { key: 'quantidade', label: 'Quantidade', value: (t) => t.quantidade },
    { key: 'preco', label: 'Preço', value: (t) => t.preco || '' },
    { key: 'condicao', label: 'Condição', value: (t) => (t.condicao === 'usado' ? 'Usado' : 'Novo') },
    { key: 'fornecedor', label: 'Fornecedor', value: (t) => t.fornecedor || '' },
    { key: 'codigoBarras', label: 'Código de barras', value: (t) => t.codigoBarras || '' },
    { key: 'origem', label: 'Origem', value: (t) => (t.origem === 'empresa' ? 'Empresa' : 'Local') },
    { key: 'addedAt', label: 'Adicionado em', value: (t) => formatDate(t.addedAt) },
  ];
  let exportSelectedColumns = new Set(EXPORT_COLUMNS.map((c) => c.key));

  function buildExportRows() {
    const activeColumns = EXPORT_COLUMNS.filter((c) => exportSelectedColumns.has(c.key));
    return tires.map((t) => {
      const row = {};
      activeColumns.forEach((c) => { row[c.label] = c.value(t); });
      return row;
    });
  }

  function toggleExportColumn(key) {
    if (exportSelectedColumns.has(key)) {
      if (exportSelectedColumns.size === 1) {
        showToast('Deixe pelo menos uma coluna selecionada.');
        renderExportPreview();
        return;
      }
      exportSelectedColumns.delete(key);
    } else {
      exportSelectedColumns.add(key);
    }
    renderExportPreview();
  }

  function renderExportPreview() {
    const exportRows = buildExportRows();
    document.getElementById('exportSummary').textContent =
      exportRows.length === 1 ? '1 item será exportado' : `${exportRows.length} itens serão exportados`;

    const table = document.getElementById('exportPreviewTable');
    const headHtml = `<tr>${EXPORT_COLUMNS.map((c) => `
      <th class="${exportSelectedColumns.has(c.key) ? '' : 'col-excluded'}">
        <label><input type="checkbox" data-col="${c.key}" ${exportSelectedColumns.has(c.key) ? 'checked' : ''}> ${escapeHtml(c.label)}</label>
      </th>`).join('')}</tr>`;

    const bodyHtml = tires.length
      ? tires.map((t) => `<tr>${EXPORT_COLUMNS.map((c) =>
          `<td class="${exportSelectedColumns.has(c.key) ? '' : 'col-excluded'}">${escapeHtml(c.value(t))}</td>`
        ).join('')}</tr>`).join('')
      : `<tr><td colspan="${EXPORT_COLUMNS.length}" style="text-align:center;color:var(--ink-soft);">Nenhum item no estoque.</td></tr>`;

    table.innerHTML = `<thead>${headHtml}</thead><tbody>${bodyHtml}</tbody>`;
    table.querySelectorAll('th input[type="checkbox"]').forEach((cb) => {
      cb.onchange = () => toggleExportColumn(cb.dataset.col);
    });
  }

  async function exportStock() {
    const rows = buildExportRows();
    if (!rows.length) {
      showToast('Nada para exportar — o estoque está vazio.');
      return;
    }
    await ensureXLSX();
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Estoque');
    const dataStr = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `estoque-pneus-${dataStr}.xlsx`);
  }

  async function exportStockPdf() {
    const rows = buildExportRows();
    if (!rows.length) {
      showToast('Nada para exportar — o estoque está vazio.');
      return;
    }
    await ensureJsPdfGenerator();

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape' });
    const columns = Object.keys(rows[0]);
    const body = rows.map((r) => columns.map((c) => String(r[c] ?? '')));

    doc.setFontSize(14);
    doc.text('Estoque de Pneus', 14, 16);
    doc.setFontSize(10);
    doc.text(`Gerado em ${new Date().toLocaleDateString('pt-BR')} — ${rows.length} item(ns)`, 14, 22);

    doc.autoTable({
      head: [columns],
      body,
      startY: 28,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [227, 167, 43] },
    });

    const dataStr = new Date().toISOString().slice(0, 10);
    doc.save(`estoque-pneus-${dataStr}.pdf`);
  }

  /* =========================================================================
     10g. LEITOR DE CÓDIGO (compartilhado entre o campo do formulário e a
     conferência de estoque)
     Usa a BarcodeDetector API nativa do navegador quando disponível — ela lê
     código de barras real (o que já vem de fábrica/nota na etiqueta do
     pneu). Em navegadores sem suporte (ex: Firefox, Safari mais antigos),
     cai para o jsQR, que só lê QR code — nesse caso a leitura de código de
     barras não funciona, só de QR.
  ========================================================================= */

  const JSQR_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/jsQR/1.4.0/jsQR.js';
  async function ensureJsQR() {
    if (typeof jsQR === 'undefined') await loadScriptOnce(JSQR_CDN);
  }

  const BARCODE_FORMATS = [
    'qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'codabar', 'itf', 'data_matrix',
  ];

  // Retorna uma função async (canvas) => string|null que lê o próximo código
  // visível no canvas, usando o melhor mecanismo disponível no navegador.
  async function createCodeReader() {
    if ('BarcodeDetector' in window) {
      let formats = BARCODE_FORMATS;
      try {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        formats = BARCODE_FORMATS.filter((f) => supported.includes(f));
        if (!formats.length) formats = supported;
      } catch (e) {
        // getSupportedFormats pode não existir em algumas implementações — segue com a lista padrão.
      }
      const detector = new window.BarcodeDetector({ formats });
      return async (canvas) => {
        try {
          const codes = await detector.detect(canvas);
          return codes.length ? codes[0].rawValue : null;
        } catch (e) {
          return null;
        }
      };
    }

    // Fallback: só lê QR code.
    await ensureJsQR();
    return async (canvas) => {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height);
      return code ? code.data : null;
    };
  }

  // Encontra o pneu cujo código de barras cadastrado bate com o que foi lido.
  function findTireByScannedCode(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    return tires.find((t) => t.codigoBarras && t.codigoBarras.trim() === raw) || null;
  }

  /* =========================================================================
     10h. LEITURA RÁPIDA (preenche o campo "código de barras" do formulário)
  ========================================================================= */

  let scanOnceStream = null;
  let scanOnceRafId = null;
  let scanOnceReader = null;
  let scanOnceBusy = false;

  async function openScanOnceModal() {
    closeScanFlow();
    document.getElementById('scanOnceModal').classList.add('open');

    const statusEl = document.getElementById('scanOnceStatus');
    statusEl.style.display = 'block';
    statusEl.textContent = 'Carregando leitor...';

    try {
      scanOnceReader = await createCodeReader();
      statusEl.textContent = 'Solicitando acesso à câmera...';

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Este navegador não tem suporte a câmera (precisa de HTTPS ou localhost).');
      }

      scanOnceStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const video = document.getElementById('scanOnceVideo');
      video.srcObject = scanOnceStream;
      await video.play();

      statusEl.style.display = 'none';
      scanOnceBusy = false;
      scanOnceLoop();
    } catch (err) {
      statusEl.textContent = err.message || 'Não foi possível acessar a câmera.';
    }
  }

  function closeScanOnceModal() {
    document.getElementById('scanOnceModal').classList.remove('open');
    if (scanOnceRafId) {
      cancelAnimationFrame(scanOnceRafId);
      scanOnceRafId = null;
    }
    if (scanOnceStream) {
      scanOnceStream.getTracks().forEach((track) => track.stop());
      scanOnceStream = null;
    }
  }

  async function scanOnceLoop() {
    const video = document.getElementById('scanOnceVideo');
    const canvas = document.getElementById('scanOnceCanvas');
    if (!scanOnceStream) return;

    if (video.readyState === video.HAVE_ENOUGH_DATA && !scanOnceBusy) {
      scanOnceBusy = true;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      const text = await scanOnceReader(canvas);
      scanOnceBusy = false;
      if (text) {
        fCodigoBarras.value = text.trim();
        closeScanOnceModal();
        showToast('Código lido com sucesso.');
        return;
      }
    }
    scanOnceRafId = requestAnimationFrame(scanOnceLoop);
  }

  /* =========================================================================
     10i. VERIFICAÇÃO AVULSA POR CÂMERA (estilo álbum de figurinhas)
     Cada leitura identifica um único pneu, fecha a câmera na hora e mostra,
     num pop-out, os dados daquele item — com ações rápidas para somar ou
     subtrair a quantidade em estoque.
  ========================================================================= */

  let scannerStream = null;
  let scannerRafId = null;
  let scannerReader = null;
  let scannerBusy = false;

  let stickerTire = null;       // pneu exibido na figurinha atual
  let stickerAdjustMode = null; // 'add' | 'remove'

  function flashScannerCam() {
    const flash = document.getElementById('scannerFlash');
    flash.classList.add('on');
    setTimeout(() => flash.classList.remove('on'), 200);
  }

  async function openScannerModal() {
    switchTab('estoque');
    closeForm();
    closeXmlPanel();
    closeImportPanel();
    closeSyncPanel();
    closeScanOnceModal();
    closeStickerModal();
    scannerModal.classList.add('open');

    const statusEl = document.getElementById('scannerStatus');
    statusEl.style.display = 'block';
    statusEl.textContent = 'Carregando leitor...';

    try {
      scannerReader = await createCodeReader();
      statusEl.textContent = 'Solicitando acesso à câmera...';

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Este navegador não tem suporte a câmera (precisa de HTTPS ou localhost).');
      }

      scannerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const video = document.getElementById('scannerVideo');
      video.srcObject = scannerStream;
      await video.play();

      statusEl.style.display = 'none';
      scannerBusy = false;
      scannerRafId = requestAnimationFrame(scannerScanLoop);
    } catch (err) {
      statusEl.textContent = err.message || 'Não foi possível acessar a câmera.';
    }
  }

  function closeScannerModal() {
    scannerModal.classList.remove('open');
    if (scannerRafId) {
      cancelAnimationFrame(scannerRafId);
      scannerRafId = null;
    }
    if (scannerStream) {
      scannerStream.getTracks().forEach((track) => track.stop());
      scannerStream = null;
    }
  }

  async function scannerScanLoop() {
    const video = document.getElementById('scannerVideo');
    const canvas = document.getElementById('scannerCanvas');
    if (!scannerStream) return;

    if (video.readyState === video.HAVE_ENOUGH_DATA && !scannerBusy) {
      scannerBusy = true;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      const text = await scannerReader(canvas);
      scannerBusy = false;
      if (text) {
        const raw = text.trim();
        flashScannerCam();
        closeScannerModal();
        openStickerModal(findTireByScannedCode(raw), raw);
        return;
      }
    }
    scannerRafId = requestAnimationFrame(scannerScanLoop);
  }

  function renderStickerTire() {
    if (!stickerTire) return;
    document.getElementById('stickerMarca').textContent = stickerTire.marca || '—';
    document.getElementById('stickerMedida').textContent = stickerTire.medida || '—';
    document.getElementById('stickerQtd').textContent = stickerTire.quantidade ?? 0;
  }

  function openStickerModal(tire, rawCode) {
    stickerTire = tire || null;
    closeStickerAdjust();

    const foundEl = document.getElementById('stickerFound');
    const notFoundEl = document.getElementById('stickerNotFound');

    if (!tire) {
      foundEl.style.display = 'none';
      notFoundEl.style.display = 'block';
      document.getElementById('stickerCadastrarBtn').onclick = () => {
        closeStickerModal();
        openAddForm(rawCode);
      };
    } else {
      foundEl.style.display = 'block';
      notFoundEl.style.display = 'none';
      renderStickerTire();
    }

    stickerModal.classList.add('open');
  }

  function closeStickerModal() {
    stickerModal.classList.remove('open');
    stickerTire = null;
    closeStickerAdjust();
  }

  function openStickerAdjust(mode) {
    stickerAdjustMode = mode;
    document.getElementById('stickerMainActions').style.display = 'none';
    document.getElementById('stickerAdjustLabel').textContent =
      mode === 'add' ? 'Quantidade a somar' : 'Quantidade a remover';
    const qtdInput = document.getElementById('stickerAdjustQtd');
    qtdInput.value = '';
    document.getElementById('stickerAdjustErr').classList.remove('show');
    document.getElementById('stickerAdjust').classList.add('show');
    qtdInput.focus();
  }

  function closeStickerAdjust() {
    stickerAdjustMode = null;
    document.getElementById('stickerMainActions').style.display = 'flex';
    document.getElementById('stickerAdjust').classList.remove('show');
  }

  async function confirmStickerAdjust() {
    const errEl = document.getElementById('stickerAdjustErr');
    errEl.classList.remove('show');

    const raw = document.getElementById('stickerAdjustQtd').value.trim();
    const delta = Number(raw);
    if (raw === '' || isNaN(delta) || delta <= 0 || !Number.isInteger(delta)) {
      errEl.textContent = 'Informe uma quantidade válida.';
      errEl.classList.add('show');
      return;
    }

    const t = stickerTire;
    if (!t) return;
    const novaQtd = stickerAdjustMode === 'add' ? t.quantidade + delta : t.quantidade - delta;
    if (novaQtd < 0) {
      errEl.textContent = 'Essa quantidade deixaria o estoque negativo.';
      errEl.classList.add('show');
      return;
    }

    try {
      const updated = { ...t, quantidade: novaQtd, origem: t.origem === 'empresa' ? 'local' : t.origem };
      await api.update(t.id, updated);
      Object.assign(t, updated);
      renderStickerTire();
      closeStickerAdjust();
      render();
      showToast(
        stickerAdjustMode === 'add'
          ? `+${delta} un. adicionada(s) — novo total: ${novaQtd}.`
          : `-${delta} un. removida(s) — novo total: ${novaQtd}.`
      );
    } catch (e) {
      errEl.textContent = e.message || 'Não foi possível atualizar o estoque. Verifique sua conexão com a API.';
      errEl.classList.add('show');
    }
  }

  function closeScanFlow() {
    closeScannerModal();
    closeStickerModal();
  }

  async function handleSyncUpload(file) {
    const statusEl = document.getElementById('syncStatus');
    const syncErr = document.getElementById('syncErr');
    syncErr.classList.remove('show');
    statusEl.style.display = 'block';
    statusEl.textContent = 'Lendo o relatório...';

    try {
      const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
      const rows = isPdf ? await parsePdfReport(file) : (await parseSpreadsheet(file)).map(mapSpreadsheetRow);

      if (rows.length === 0) {
        statusEl.textContent = 'Nenhuma linha reconhecida nesse arquivo.';
        return;
      }

      document.getElementById('syncRows').innerHTML = '';
      batchRowCount = 0;
      rows.forEach((row) => addBatchRow('syncRows', row));
      statusEl.style.display = 'none';
      showToast(`${rows.length} linha(s) lidas do relatório da empresa. Confira antes de sincronizar.`);
    } catch (err) {
      statusEl.textContent = err.message || 'Não foi possível ler esse arquivo.';
    }
  }

  async function saveSync() {
    const syncErr = document.getElementById('syncErr');
    syncErr.classList.remove('show');

    const items = rowsToItems('syncRows', syncErr, null, 'empresa');
    if (items === null) return;

    if (items.length === 0) {
      syncErr.textContent = 'Nenhum item para sincronizar.';
      syncErr.classList.add('show');
      return;
    }

    try {
      const { createdCount, updatedCount, dedupedCount } = await syncCompanyStock(items);
      closeSyncPanel();
      render();
      showToast(
        `Estoque da empresa sincronizado: ${createdCount} novo(s), ${updatedCount} atualizado(s)` +
        (dedupedCount ? `, ${dedupedCount} duplicado(s) mesclado(s).` : '.')
      );
    } catch (e) {
      syncErr.textContent = 'Não foi possível sincronizar. Verifique sua conexão com a API.';
      syncErr.classList.add('show');
    }
  }

  /* =========================================================================
     11. EVENTOS
  ========================================================================= */

  document.getElementById('toggleFormBtn').onclick = () => {
    formPanel.classList.contains('open') ? closeForm() : openAddForm();
  };
  document.getElementById('cancelBtn').onclick = closeForm;
  document.getElementById('saveBtn').onclick = () =>
    withButtonBusy(document.getElementById('saveBtn'), 'Salvando...', saveTire);

  document.getElementById('xmlBtn').onclick = () => {
    xmlPanel.classList.contains('open') ? closeXmlPanel() : openXmlPanel();
  };
  document.getElementById('xmlFileInput').onchange = (e) => {
    const file = e.target.files[0];
    if (file) handleXmlUpload(file);
  };
  document.getElementById('rescanXmlBtn').onclick = openXmlPanel;
  document.getElementById('cancelXmlBtn').onclick = closeXmlPanel;
  document.getElementById('addXmlRowBtn').onclick = () => addBatchRow('xmlRows');
  document.getElementById('saveXmlBtn').onclick = () =>
    withButtonBusy(document.getElementById('saveXmlBtn'), 'Salvando...', saveXml);

  document.getElementById('importBtn').onclick = () => {
    importPanel.classList.contains('open') ? closeImportPanel() : openImportPanel();
  };
  document.getElementById('importFileInput').onchange = (e) => {
    const file = e.target.files[0];
    if (file) handleImportUpload(file);
  };
  document.getElementById('downloadTemplateBtn').onclick = downloadTemplate;
  document.getElementById('addImportRowBtn').onclick = () => addBatchRow('importRows');
  document.getElementById('cancelImportBtn').onclick = closeImportPanel;
  document.getElementById('saveImportBtn').onclick = () =>
    withButtonBusy(document.getElementById('saveImportBtn'), 'Salvando...', saveImport);

  document.getElementById('syncBtn').onclick = () => {
    syncPanel.classList.contains('open') ? closeSyncPanel() : openSyncPanel();
  };
  document.getElementById('syncFileInput').onchange = (e) => {
    const file = e.target.files[0];
    if (file) handleSyncUpload(file);
  };
  document.getElementById('addSyncRowBtn').onclick = () => addBatchRow('syncRows');
  document.getElementById('cancelSyncBtn').onclick = closeSyncPanel;
  document.getElementById('saveSyncBtn').onclick = saveSync;

  document.querySelectorAll('.tabbar .tab').forEach((btn) => {
    btn.onclick = () => switchTab(btn.dataset.tab);
  });

  document.getElementById('historyTireFilter').onchange = loadAndRenderHistory;
  document.getElementById('historyFromFilter').onchange = loadAndRenderHistory;
  document.getElementById('historyToFilter').onchange = loadAndRenderHistory;
  document.getElementById('historyFilterClearBtn').onclick = () => {
    document.getElementById('historyTireFilter').value = '';
    document.getElementById('historyFromFilter').value = '';
    document.getElementById('historyToFilter').value = '';
    loadAndRenderHistory();
  };

  document.getElementById('exportBtn').onclick = async () => {
    const btn = document.getElementById('exportBtn');
    const format = document.getElementById('exportFormatSelect').value;
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Gerando...';
    try {
      if (format === 'pdf') {
        await exportStockPdf();
      } else {
        await exportStock();
      }
    } catch (e) {
      showToast(e && e.message ? e.message : 'Não foi possível exportar o estoque.', { duration: 6000 });
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  };

  document.getElementById('loadMoreBtn').onclick = loadMore;

  document.getElementById('conferBtn').onclick = openScannerModal;
  document.getElementById('cancelScannerBtn').onclick = closeScannerModal;

  document.getElementById('stickerAddBtn').onclick = () => openStickerAdjust('add');
  document.getElementById('stickerRemoveBtn').onclick = () => openStickerAdjust('remove');
  document.getElementById('stickerAdjustCancelBtn').onclick = closeStickerAdjust;
  document.getElementById('stickerAdjustConfirmBtn').onclick = confirmStickerAdjust;
  document.getElementById('stickerRescanBtn').onclick = openScannerModal;
  document.getElementById('closeStickerBtn').onclick = closeStickerModal;

  document.getElementById('scanCodigoBtn').onclick = openScanOnceModal;
  document.getElementById('cancelScanOnceBtn').onclick = closeScanOnceModal;

  window.addEventListener('beforeunload', () => {
    if (scannerStream) scannerStream.getTracks().forEach((track) => track.stop());
    if (scanOnceStream) scanOnceStream.getTracks().forEach((track) => track.stop());
  });

  const debouncedSearchRender = debounce(render, 200);
  document.getElementById('searchInput').oninput = (e) => {
    searchTerm = e.target.value;
    debouncedSearchRender();
  };
  document.getElementById('clearSearchBtn').onclick = () => {
    searchTerm = '';
    filterNovoOnly = false;
    condFilter = 'todos';
    sortMode = 'aro';
    document.getElementById('searchInput').value = '';
    render();
  };
  novoChip.onclick = () => {
    filterNovoOnly = !filterNovoOnly;
    render();
  };
  document.querySelectorAll('#condFilterGroup .chip').forEach((chip) => {
    chip.onclick = () => {
      condFilter = chip.dataset.cond;
      render();
    };
  });
  sortModeSelect.onchange = (e) => {
    sortMode = e.target.value;
    render();
  };

  // Fecha o pop-out ao clicar fora do card (no fundo escurecido).
  const MODAL_CLOSERS = {
    formPanel: closeForm,
    xmlPanel: closeXmlPanel,
    importPanel: closeImportPanel,
    syncPanel: closeSyncPanel,
    scanOnceModal: closeScanOnceModal,
    scannerModal: closeScannerModal,
    stickerModal: closeStickerModal,
  };
  Object.keys(MODAL_CLOSERS).forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener('click', (e) => {
      if (e.target === el) MODAL_CLOSERS[id]();
    });
  });

  window.__bootApp = load;
})();
