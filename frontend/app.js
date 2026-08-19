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
    async list() {
      const res = await fetch(`${API_BASE}/tires`, { headers: await authHeaders() });
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

  const contentEl = document.getElementById('content');
  const statsEl = document.getElementById('stats');
  const formPanel = document.getElementById('formPanel');
  const xmlPanel = document.getElementById('xmlPanel');
  const importPanel = document.getElementById('importPanel');
  const formTitle = document.getElementById('formTitle');
  const formErr = document.getElementById('formErr');
  const toast = document.getElementById('toast');
  const novoChip = document.getElementById('novoChip');
  const novoCount = document.getElementById('novoCount');
  const sortModeSelect = document.getElementById('sortModeSelect');

  const fMarca = document.getElementById('fMarca');
  const fMedida = document.getElementById('fMedida');
  const fQtd = document.getElementById('fQtd');
  const fPreco = document.getElementById('fPreco');
  const fCondicao = document.getElementById('fCondicao');

  /* =========================================================================
     3. UTILITÁRIOS GERAIS
  ========================================================================= */

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), 2600);
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

  async function load() {
    try {
      tires = await api.list();
    } catch (e) {
      tires = [];
      showToast('Não foi possível conectar à API. Verifique se o backend está rodando.');
    }
    render();
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

  async function deleteTire(id) {
    try {
      await api.remove(id);
      tires = tires.filter((t) => t.id !== id);
      render();
      showToast('Pneu removido do estoque.');
    } catch (e) {
      showToast('Não foi possível excluir. Tente novamente.');
    }
  }

  /* =========================================================================
     7. FORMULÁRIO MANUAL (adicionar / editar um item)
  ========================================================================= */

  function openAddForm() {
    closeXmlPanel();
    closeImportPanel();
    editingId = null;
    formTitle.textContent = 'Adicionar pneu';
    fMarca.value = '';
    fMedida.value = '';
    fQtd.value = '';
    fPreco.value = '';
    fCondicao.value = 'novo';
    formErr.classList.remove('show');
    formPanel.classList.add('open');
    fMarca.focus();
  }

  function openEditForm(id) {
    closeXmlPanel();
    closeImportPanel();
    const t = tires.find((x) => x.id === id);
    if (!t) return;
    editingId = id;
    formTitle.textContent = 'Editar pneu';
    fMarca.value = t.marca || '';
    fMedida.value = t.medida || '';
    fQtd.value = t.quantidade ?? '';
    fPreco.value = t.preco ?? '';
    fCondicao.value = t.condicao === 'usado' ? 'usado' : 'novo';
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
        const updated = { ...t, marca, medida, quantidade: Number(qtd), preco, condicao };
        await api.update(editingId, updated);
        Object.assign(t, updated);
      } else {
        const created = await api.create({
          marca, medida, quantidade: Number(qtd), preco, condicao,
          novo: true, notaRef: null,
        });
        tires.push(created);
      }
      closeForm();
      render();
      showToast(editingId ? 'Pneu atualizado.' : 'Pneu adicionado ao estoque.');
    } catch (e) {
      formErr.textContent = 'Não foi possível salvar. Verifique sua conexão com a API.';
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
      <button class="rm" title="Remover linha">✕</button>
    `;
    if (prefill.marca) div.querySelector('.b-marca').value = prefill.marca;
    if (prefill.medida) div.querySelector('.b-medida').value = prefill.medida;
    if (prefill.quantidade !== undefined && prefill.quantidade !== '') div.querySelector('.b-qtd').value = prefill.quantidade;
    if (prefill.preco) div.querySelector('.b-preco').value = prefill.preco;
    if (prefill.condicao === 'usado') div.querySelector('.b-condicao').value = 'usado';
    div.querySelector('.rm').onclick = () => div.remove();
    document.getElementById(containerId).appendChild(div);
    return div;
  }

  function rowsToItems(containerId, errEl, notaRefValue) {
    const rows = document.querySelectorAll(`#${containerId} .batch-row`);
    const items = [];
    for (const row of rows) {
      const marca = row.querySelector('.b-marca').value.trim();
      const medida = row.querySelector('.b-medida').value.trim();
      const qtd = row.querySelector('.b-qtd').value.trim();
      const preco = row.querySelector('.b-preco').value.trim();
      const condicao = row.querySelector('.b-condicao').value;
      if (!marca && !medida && !qtd) continue; // linha vazia, ignora
      if (!marca || !medida || qtd === '' || !validMedida(medida)) {
        errEl.textContent = 'Verifique se todas as linhas têm marca, medida válida (R13–R20) e quantidade.';
        errEl.classList.add('show');
        return null;
      }
      items.push({ marca, medida, quantidade: Number(qtd), preco, condicao, novo: true, notaRef: notaRefValue });
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
    closeForm();
    closeImportPanel();
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
    const newItems = rowsToItems('xmlRows', xmlErr, notaRefValue);
    if (newItems === null) return;

    if (newItems.length === 0) {
      xmlErr.textContent = 'Nenhum item para salvar.';
      xmlErr.classList.add('show');
      return;
    }

    try {
      const created = await api.bulkCreate(newItems);
      tires.push(...created);
      closeXmlPanel();
      render();
      showToast(`${created.length} item(ns) adicionados a partir do XML.`);
    } catch (e) {
      xmlErr.textContent = 'Não foi possível salvar os itens. Verifique sua conexão com a API.';
      xmlErr.classList.add('show');
    }
  }

  /* =========================================================================
     10. IMPORTAÇÃO POR PLANILHA (Excel/CSV) OU PDF DE RELATÓRIO
  ========================================================================= */

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

  function parseSpreadsheet(file) {
    return new Promise((resolve, reject) => {
      if (typeof XLSX === 'undefined') {
        reject(new Error('Biblioteca de planilhas não carregou. Verifique sua conexão e recarregue a página.'));
        return;
      }
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
    if (typeof pdfjsLib === 'undefined') {
      throw new Error('Biblioteca de leitura de PDF não carregou. Verifique sua conexão e recarregue a página.');
    }
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
    closeForm();
    closeXmlPanel();
    importPanel.classList.add('open');
    document.getElementById('importRows').innerHTML = '';
    document.getElementById('importErr').classList.remove('show');
    document.getElementById('importStatus').style.display = 'none';
    document.getElementById('importFileInput').value = '';
  }

  function closeImportPanel() {
    importPanel.classList.remove('open');
  }

  function downloadTemplate() {
    if (typeof XLSX === 'undefined') {
      showToast('Biblioteca de planilhas não carregou. Recarregue a página.');
      return;
    }
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

    const newItems = rowsToItems('importRows', importErr, 'importação');
    if (newItems === null) return;

    if (newItems.length === 0) {
      importErr.textContent = 'Nenhum item válido para importar.';
      importErr.classList.add('show');
      return;
    }

    try {
      const created = await api.bulkCreate(newItems);
      tires.push(...created);
      closeImportPanel();
      render();
      showToast(`${created.length} item(ns) importados.`);
    } catch (e) {
      importErr.textContent = 'Não foi possível salvar os itens. Verifique sua conexão com a API.';
      importErr.classList.add('show');
    }
  }

  /* =========================================================================
     11. EVENTOS
  ========================================================================= */

  document.getElementById('toggleFormBtn').onclick = () => {
    formPanel.classList.contains('open') ? closeForm() : openAddForm();
  };
  document.getElementById('cancelBtn').onclick = closeForm;
  document.getElementById('saveBtn').onclick = saveTire;

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
  document.getElementById('saveXmlBtn').onclick = saveXml;

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
  document.getElementById('saveImportBtn').onclick = saveImport;

  document.getElementById('searchInput').oninput = (e) => {
    searchTerm = e.target.value;
    render();
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

  window.__bootApp = load;
})();
