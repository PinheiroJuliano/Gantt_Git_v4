'use strict';

/* CONSTANTS & STATE */
const STORE_CFG  = 'gantt_cfg_v2';
const STORE_PROG = 'gantt_prog_v2';
const TODAY = (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })();

const STATUS_COLORS = {
  'Andamento': 'var(--blue)',
  'Pausada':   'var(--amber)',
  'Concluída': 'var(--green)',
  'Aguardando':'var(--gray)',
};
const STATUS_CLASS = {
  'Andamento': 'sb-a',
  'Pausada':   'sb-p',
  'Concluída': 'sb-c',
  'Aguardando':'sb-w',
};
const SUM_CLASS = {
  'Andamento': 's-a',
  'Pausada':   's-p',
  'Concluída': 's-c',
  'Aguardando':'s-w',
};

const JSONBIN_ID  = "6a17424b21f9ee59d2927ff3";
const JSONBIN_KEY = "$2a$10$3Gy2uaQPtFI5sYWND4e1nOAhKfNcwnqAt/had4F0jmKdWSSItcaGS";
const JSONBIN_API = `https://api.jsonbin.io/v3/b/${JSONBIN_ID}`;

let allIssues = [];
let progress  = {};
let timeline  = null;

const DEFAULT_CFG = {
  token: '', url: 'https://gitlab.4mti.com.br', group: '94',
  milestone: 'Cliente) Porto Seguro - EPC'
};

/* CONFIG */
function loadCfg() {
  if (window.__API_CONFIG__ && window.__API_CONFIG__.token) {
    return { ...DEFAULT_CFG, ...window.__API_CONFIG__ };
  }
  try {
    const local = JSON.parse(localStorage.getItem(STORE_CFG) || '{}');
    if (local.token) return { ...DEFAULT_CFG, ...local };
  } catch (e) {}
  return { ...DEFAULT_CFG };
}

function readCfgFromUI() {
  return {
    token: document.getElementById('cfgToken').value.trim(),
    url: document.getElementById('cfgUrl').value.trim().replace(/\/$/, ''),
    group: document.getElementById('cfgGroup').value.trim(),
    milestone: document.getElementById('cfgMilestone').value.trim(),
  };
}

function fillCfgUI(cfg) {
  document.getElementById('cfgToken').value     = cfg.token     || '';
  document.getElementById('cfgUrl').value       = cfg.url       || DEFAULT_CFG.url;
  document.getElementById('cfgGroup').value     = cfg.group     || DEFAULT_CFG.group;
  document.getElementById('cfgMilestone').value = cfg.milestone || DEFAULT_CFG.milestone;
}

/* PROGRESS STORE */
function loadProgress() {
  try { progress = JSON.parse(localStorage.getItem(STORE_PROG)||'{}'); }
  catch { progress = {}; }
}
function saveProgress() {
  localStorage.setItem(STORE_PROG, JSON.stringify(progress));
  updateSaveIndicator();
}
function updateSaveIndicator() {
  const n = Object.keys(progress).length;
  const el = document.getElementById('saveIndicator');
  if (el) el.innerHTML = n ? `<span class="save-dot"></span>${n} issue(s) com progresso salvo` : '';
}

/* API */
function setApiStatus(msg, cls) {
  const el = document.getElementById('api-status');
  if (el) { el.textContent = msg; el.className = cls; }
}

async function fetchAllPages(url, token) {
  const headers = { 'Private-Token': token };
  let page = 1, results = [];
  while (true) {
    const sep = url.includes('?') ? '&' : '?';
    const r = await fetch(`${url}${sep}per_page=100&page=${page}`, { headers });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    results = results.concat(data);
    if (data.length < 100) break;
    page++;
  }
  return results;
}

function inferStatus(issue) {
  if (issue.state === 'closed') return 'Concluída';
  const labels = (issue.labels||[]).map(l => l.toLowerCase());
  if (labels.some(l => ['pausada','paused','bloqueada','blocked'].includes(l))) return 'Pausada';
  if (labels.some(l => ['aguardando','waiting','pendente'].includes(l))) return 'Aguardando';
  return 'Andamento';
}

function inferProgress(issue) {
  const desc = issue.description || '';
  const done  = (desc.match(/-\s*\[x\]/gi)||[]).length;
  const total = (desc.match(/-\s*\[[ x]\]/gi)||[]).length;
  if (total > 0) return Math.round(done/total*100);
  const m = desc.match(/(?:progress|progresso)\s*:\s*(\d{1,3})/i);
  if (m) return Math.min(100, parseInt(m[1]));
  return issue.state === 'closed' ? 100 : 0;
}

function mapIssue(raw) {
  const ms = raw.milestone || {};
  const start = ms.start_date || raw.created_at?.slice(0,10);
  const end   = raw.due_date  || ms.due_date || null;
  return {
    iid: raw.iid, id: raw.id, title: raw.title || '', url: raw.web_url || '',
    state: raw.state || '', labels: raw.labels || [], start, end,
    apiProgress: inferProgress(raw), apiStatus: inferStatus(raw),
  };
}

async function loadFromAPI() {
  const savedCfg = loadCfg();
  const uiCfg = readCfgFromUI();

  const cfg = {
    token: uiCfg.token || savedCfg.token,
    url: uiCfg.url || savedCfg.url,
    group: uiCfg.group || savedCfg.group,
    milestone: uiCfg.milestone || savedCfg.milestone
  };

  if (!cfg.token || !cfg.url || !cfg.group) {
    setApiStatus('⚠ Token ou IDs ausentes', 'warn');
    return;
  }

  if (!window.__API_CONFIG__) {
    localStorage.setItem(STORE_CFG, JSON.stringify(cfg));
  }

  setApiStatus('⏳ Carregando...', 'loading');

  try {
    const base = `${cfg.url}/api/v4/groups/${cfg.group}/issues`;

    const stateFilter = document.getElementById('filterState').value || 'opened';

    const params = new URLSearchParams({
      state: stateFilter,
      per_page: '100'
    });

    // Mantém funcionamento original da milestone
    if (cfg.milestone) {
      params.append('milestone', cfg.milestone);
    }

    // ============================================
    // LABELS QUE DEVEM SER IGNORADAS
    // ============================================
    const ignoredLabels = [
      'Ready',
      'Specification'
    ];

    // Exclui direto na API do GitLab
    if (ignoredLabels.length) {
      params.append('not[labels]', ignoredLabels.join(','));
    }

    // ============================================
    // CHAMADA ORIGINAL DA API
    // ============================================
    const raw = await fetchAllPages(
      `${base}?${params.toString()}`,
      cfg.token
    );

    // ============================================
    // FILTRO EXTRA LOCAL
    // (garantia caso API falhe)
    // ============================================
    allIssues = raw
      .map(mapIssue)
      .filter(issue => {
        const labels = (issue.labels || []).map(l => l.toLowerCase());

        return !labels.some(label =>
          ignoredLabels.includes(label)
        );
      });

    // Mantém ordenação original
    allIssues.sort((a, b) =>
      (a.start || '9999').localeCompare(b.start || '9999')
    );

    // Mantém comportamento original
    document.getElementById('msBadge').textContent =
      cfg.milestone || 'Todas';

    const btnReload = document.getElementById('btnReload');

    if (btnReload) {
      btnReload.style.display = 'inline-block';
    }

    setApiStatus(`✅ ${allIssues.length} issues`, 'ok');

    setDefaultFilters();

    render();

  } catch (e) {
    console.error(e);

    setApiStatus(`❌ Erro: ${e.message}`, 'err');
  }
}

/* FILTERS */
function setDefaultFilters() {
  const now = new Date(TODAY);
  
  // Identifica o dia da semana (0 = Domingo, 1 = Segunda...)
  const dayOfWeek = now.getDay(); 
  
  // Calcula o início da semana (Domingo)
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - dayOfWeek);
  
  // Calcula o fim da semana (Sábado)
  const endOfWeek = new Date(now);
  endOfWeek.setDate(now.getDate() + (6 - dayOfWeek));

  // Aplica aos inputs de data
  document.getElementById('filterFrom').value = fmt(startOfWeek);
  document.getElementById('filterTo').value   = fmt(endOfWeek);
}

function resetFilters() {
  document.getElementById('filterSearch').value = '';
  document.getElementById('filterStatus').value = '';
  setDefaultFilters();
  render();
}

function applyFilters() {
  const from   = document.getElementById('filterFrom').value;
  const to     = document.getElementById('filterTo').value;
  const status = document.getElementById('filterStatus').value;
  const search = document.getElementById('filterSearch').value.toLowerCase();

  return allIssues.filter(i => {
    const iStatus = effectiveStatus(i);
    if (status && iStatus !== status) return false;
    if (search && !String(i.iid).includes(search) && !i.title.toLowerCase().includes(search)) return false;
    if (from && i.end && i.end < from) return false;
    if (to && i.start && i.start > to) return false;
    return true;
  });
}

/* HELPERS */

// Helper para achar a linha da tabela rapidamente
function rowOf(iid) {
  return document.querySelector(`tr[data-iid="${iid}"]`);
}

// Atualiza apenas a barrinha de progresso manual durante o movimento (fica mais liso)
function updateProgUI_Minimal(row, pct, status) {
  if (!row) return;
  const fill = row.querySelector('.prog-fill');
  const label = row.querySelector('.prog-label');
  const color = STATUS_COLORS[status || 'Andamento'] || 'var(--blue)';
  
  if (fill) {
    fill.style.width = pct + '%';
    fill.style.background = color;
  }
  if (label) label.textContent = pct + '%';
}

window.changeWeek = function(days) {
  const fFrom = document.getElementById('filterFrom');
  const fTo = document.getElementById('filterTo');
  
  let d0 = parseD(fFrom.value);
  let d1 = parseD(fTo.value);
  
  d0.setDate(d0.getDate() + days);
  d1.setDate(d1.getDate() + days);
  
  fFrom.value = fmt(d0);
  fTo.value = fmt(d1);
  
  render(); // Re-renderiza com as novas datas
};

function getWeekNumber(d) {
  d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  var weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return weekNo;
}

function fmt(d) { return d.toISOString().slice(0,10); }
function parseD(s) {
  if (!s) return null;
  const [y,m,d] = s.split('-').map(Number);
  const dt = new Date(y, m-1, d); dt.setHours(0,0,0,0); return dt;
}
function fmtBR(s) {
  if (!s) return '—';
  return new Date(s + 'T12:00:00').toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'});
}
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function effectivePct(issue) { return progress[issue.iid]?.pct ?? issue.apiProgress; }
function effectiveStatus(issue) { return progress[issue.iid]?.status ?? issue.apiStatus; }

/* RENDER */
function render() {
  const issues = applyFilters();
  
  // Atualiza contagem
  document.getElementById('filterCount').textContent =
    issues.length < allIssues.length ? `${issues.length} / ${allIssues.length}` : `${issues.length} issues`;

  // Atualiza o Badge da Milestone com o número da semana
  const msBadge = document.getElementById('msBadge');
  const currentWeek = getWeekNumber(TODAY);
  const savedCfg = loadCfg(); 
  msBadge.textContent = `${savedCfg.milestone || 'Geral'} | Semana ${currentWeek}`;

  renderSummary(issues);
  buildTimeline();
  renderRows(issues);
}

function renderSummary(issues) {
  const counts = {};
  let totalPct = 0;
  issues.forEach(i => {
    const s = effectiveStatus(i);
    counts[s] = (counts[s]||0)+1;
    totalPct += effectivePct(i);
  });
  const avg = issues.length ? Math.round(totalPct / issues.length) : 0;
  const order = ['Andamento','Concluída','Pausada','Aguardando'];
  let html = order.map(s => counts[s]
    ? `<div class="sum-card ${SUM_CLASS[s]}"><span class="val">${counts[s]}</span> ${s}</div>` : '').join('');
  html += `<div class="sum-card s-avg"><span class="val">${avg}%</span> médio</div>`;
  document.getElementById('summary').innerHTML = html;
}

function buildTimeline() {
  const from = document.getElementById('filterFrom').value;
  const to = document.getElementById('filterTo').value;
  
  if (!from || !to) { 
    timeline = null; 
    return; 
  }

  const t0 = parseD(from);
  const t1 = parseD(to);
  
  // Cálculo do span garantindo que não seja zero para evitar erros matemáticos
  const span = Math.max(1, Math.round((t1 - t0) / 86400000));
  timeline = { t0, t1, span };

  const hdr = document.getElementById('tlHeader');
  hdr.innerHTML = '';

  const dayStep = span > 60 ? 7 : 1;

  for (let i = 0; i <= span; i += dayStep) {
    const current = new Date(t0);
    current.setDate(t0.getDate() + i);
    
    const pct = (i / span) * 100;
    
    const tick = document.createElement('div');
    tick.className = 'tl-tick';
    tick.style.left = pct + '%';
    
    // Ajuste para o texto do último dia não vazar à direita
    if (i + dayStep > span) {
        tick.style.transform = 'translateX(-100%)';
        tick.style.borderLeft = 'none';
        tick.style.textAlign = 'right';
    }

    tick.textContent = current.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
    hdr.appendChild(tick);
  }

  // Ajustar o tamanho da grade no CSS dinamicamente
  const tableCells = document.querySelectorAll('.bar-cell-td');
  const columnWidth = (dayStep / span) * 100;
  
  tableCells.forEach(cell => {
    cell.style.backgroundSize = `${columnWidth}% 100%`;
    cell.style.backgroundPosition = '0 0';
  });

  // Linha de "Hoje"
  if (TODAY >= t0 && TODAY <= t1) {
    const pct = ((TODAY - t0) / (t1 - t0)) * 100;
    hdr.insertAdjacentHTML('beforeend', `
      <div class="today-line" style="left:${pct}%"></div>
      <div class="today-lbl" style="left:${pct}%; z-index:11">hoje</div>
    `);
  }
}

function pctPos(dateStr) {
  if (!timeline || !dateStr) return null;
  const d = parseD(dateStr);
  return Math.max(0, Math.min(100, (d - timeline.t0) / (timeline.t1 - timeline.t0) * 100));
}

function renderRows(issues) {
  const body = document.getElementById('ganttBody');
  if (!issues.length) {
    body.innerHTML = '<tr><td colspan="7" class="no-data">Nenhuma issue nos filtros aplicados.</td></tr>';
    return;
  }

  const todayStr = fmt(TODAY);

  body.innerHTML = issues.map(issue => {
    const status = effectiveStatus(issue);
    const pct = effectivePct(issue); // Progresso manual (opcional se quiser exibir no label)
    const color = STATUS_COLORS[status] || 'var(--gray)';
    const sClass = STATUS_CLASS[status] || 'sb-w';
    
    // Identifica se está atrasada (passou do fim e não está concluída)
    const isOverdue = issue.end && issue.end < todayStr && status !== 'Concluída';

    let barHTML = '';
    const L = pctPos(issue.start);
    const R = pctPos(issue.end);

    if (L !== null && R !== null && R > L) {
      const w = R - L; // Largura total da barra (espaço entre start e end)
      let fillWidthFactor = 0; // 0 a 1 (percentual de preenchimento)
      let isCritical = false;

      // --- Lógica de Preenchimento da Barra ---
      if (isOverdue) {
        fillWidthFactor = 1; // 100% preenchida
        isCritical = true;
      } else if (status === 'Concluída') {
        fillWidthFactor = 1; // 100% preenchida
      } else {
        // Cálculo de progresso temporal (quanto tempo já passou)
        const t0 = parseD(issue.start);
        const t1 = parseD(issue.end);
        const totalDuration = t1 - t0;
        const elapsed = TODAY - t0;
        
        // Se ainda não começou, 0. Se já passou do fim, 1. Senão, proporção.
        fillWidthFactor = Math.max(0, Math.min(1, elapsed / totalDuration));
      }

      const barColor = isCritical ? 'var(--red)' : color;
      const criticalClass = isCritical ? 'bar-overdue' : '';
      const doneWidth = w * fillWidthFactor; // Largura final da parte preenchida
      const displayPct = Math.round(fillWidthFactor * 100);

      barHTML = `
        <div class="bar-ghost" style="left:${L}%; width:${w}%; background:${barColor}"></div>
        <div class="bar-done ${criticalClass}" style="left:${L}%; width:${doneWidth}%; background:${barColor}"></div>
        ${displayPct > 0 ? `<div class="bar-lbl" style="left:${L + doneWidth - 1}%">${displayPct}%</div>` : ''}
      `;
    } else if (issue.start && !issue.end) {
      // Caso não tenha data de fim, mostramos apenas um marcador no início
      const l = pctPos(issue.start);
      if (l !== null) barHTML = `<div class="bar-ghost" style="left:${l}%; width:2%; min-width:4px; background:${color}"></div>`;
    }

    return `<tr data-iid="${issue.iid}">
      <td><span class="iid">#${issue.iid}</span></td>
      <td>
        ${issue.url ? `<a class="issue-link" href="${esc(issue.url)}" target="_blank">${esc(issue.title)}</a>` : `<span>${esc(issue.title)}</span>`}
      </td>
      <td class="date-cell">${fmtBR(issue.start)}</td>
      <td class="date-cell ${isOverdue ? 'overdue' : ''}">${fmtBR(issue.end)}</td>
      <td>
        <select class="sbadge ${sClass}" onchange="changeStatus(${issue.iid}, this.value, this)">
          ${['Andamento','Pausada','Concluída','Aguardando'].map(s => 
            `<option value="${s}" ${s===status?'selected':''}>${s}</option>`).join('')}
        </select>
      </td>
      <td class="progress-col">
        <div class="prog-track" onmousedown="startDrag(event,${issue.iid})" ontouchstart="startDragTouch(event,${issue.iid})">
          <div class="prog-fill" style="width:${pct}%; background:${color}"></div>
          <div class="prog-label">${pct}%</div>
        </div>
      </td>
      <td class="bar-cell-td"><div class="bar-outer">${barHTML}</div></td>
    </tr>`;
  }).join('');
}

/* INTERACTION HANDLERS */
window.changeStatus = function(iid, val, sel) {
  // Garantimos que o objeto de progresso exista
  if (!progress[iid]) progress[iid] = { pct: 0 };
  
  // Atualiza o status sem perguntas nem travas
  progress[iid].status = val;

  // Se mudar para concluída, o progresso vai para 100%
  if (val === 'Concluída') {
    progress[iid].pct = 100;
  }

  saveProgress();
  saveToCentralData(); // <--- Sincroniza status com o banco coletivo
  render(); 
};

function updateProgUI(iid) {
  const manualPct = progress[iid]?.pct ?? 0;
  const row = document.querySelector(`tr[data-iid="${iid}"]`);
  if (!row) return;

  // 1. Atualiza visualmente a barra de arraste (esforço real)
  const track = row.querySelector('.prog-track');
  if (track) {
    const status = progress[iid]?.status || 'Andamento';
    const color = STATUS_COLORS[status] || 'var(--blue)';
    
    const fill = track.querySelector('.prog-fill');
    const label = track.querySelector('.prog-label');
    
    if (fill) {
      fill.style.width = manualPct + '%';
      fill.style.background = color;
    }
    if (label) label.textContent = manualPct + '%';
  }

  // 2. Lógica de renderização
  // Removida a linha que chamava changeStatus(iid, 'Concluída') automaticamente.
  // Agora, mesmo em 100%, o status só muda se VOCÊ quiser no select.
  
  render(); 
}


window.startDrag = function(e, iid) {
  e.preventDefault();
  const track = e.currentTarget;
  
  // Função interna para processar o movimento
  const onMove = (ev) => {
    const rect = track.getBoundingClientRect();
    const p = Math.round(Math.min(100, Math.max(0, (ev.clientX - rect.left) / rect.width * 100)));
    
    if (!progress[iid]) progress[iid] = {};
    progress[iid].pct = p;
    
    // Atualiza apenas o visual da barra de progresso durante o movimento para performance
    updateProgUI_Minimal(rowOf(iid), p, progress[iid].status);
  };

const onUp = () => {
  saveProgress(); 
  saveToCentralData(); // <--- Envia para o banco coletivo ao soltar o mouse
  render();
  document.removeEventListener('mousemove', onMove);
  document.removeEventListener('mouseup', onUp);
};

  onMove(e); // Registra o clique inicial
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
};

window.startDragTouch = function(e, iid) {
  const track = e.currentTarget;
  
  const onMove = (ev) => {
    const t = ev.touches[0];
    const rect = track.getBoundingClientRect();
    const p = Math.round(Math.min(100, Math.max(0, (t.clientX - rect.left) / rect.width * 100)));
    
    if (!progress[iid]) progress[iid] = {};
    progress[iid].pct = p;
    
    updateProgUI_Minimal(rowOf(iid), p, progress[iid].status);
  };

  const onEnd = () => {
    saveProgress();
    render();
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onEnd);
  };

  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onEnd);
};

// Função para BUSCAR os dados do arquivo JSON no GitHub
async function loadCentralData() {
  try {
    const resp = await fetch(JSONBIN_API + "/latest", {
      headers: { "X-Master-Key": JSONBIN_KEY }
    });
    if (resp.ok) {
      const data = await resp.json();
      progress = data.record;
      render();
    }
  } catch (e) {
    console.error("Erro ao carregar banco central:", e);
  }
}

async function saveToCentralData() {
  try {
    await fetch(JSONBIN_API, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Master-Key": JSONBIN_KEY
      },
      body: JSON.stringify(progress)
    });
  } catch (e) {
    console.error("Erro ao salvar banco central:", e);
  }
}

// Função para carregar as credenciais do arquivo externo
async function loadCredentials() {
  // Prioridade 1: configuração embutida no HTML (funciona em qualquer host)
  if (window.__API_CONFIG__) {
    const cfg = window.__API_CONFIG__;
    const finalCfg = {
      token:     cfg.token     || '',
      url:       cfg.url       || 'https://gitlab.4mti.com.br',
      group:     cfg.group     || '',
      milestone: cfg.milestone || ''
    };
    fillCfgUI(finalCfg);
    localStorage.setItem(STORE_CFG, JSON.stringify(finalCfg));
    return finalCfg;
  }

  // Prioridade 2: arquivo config.json (uso local / Live Server)
  try {
    const resp = await fetch(`config.json?t=${Date.now()}`);
    if (resp.ok) {
      const cfg = await resp.json();
      const finalCfg = {
        token:     cfg.token     || '',
        url:       cfg.url       || 'https://gitlab.4mti.com.br',
        group:     cfg.group     || '',
        milestone: cfg.milestone || ''
      };
      fillCfgUI(finalCfg);
      localStorage.setItem(STORE_CFG, JSON.stringify(finalCfg));
      return finalCfg;
    }
  } catch (e) {
    console.error("Erro ao carregar config.json:", e);
  }
  return null;
}

/* INIT */
async function inicializarApp() {
  console.log("Iniciando App...");
  
  // 1. Carrega progresso local imediatamente (sem depender de rede)
  loadProgress();

  // 2. Aguarda as credenciais PRIMEIRO — o token precisa estar pronto antes de qualquer chamada ao GitHub
  const cfgAtivo = await loadCredentials();

  // 3. Agora que o GITHUB_TOKEN está preenchido, busca o banco central
  await loadCentralData();

  // 3. Só tenta carregar a API se tivermos um token (seja do arquivo ou do que já estava salvo)
  if (cfgAtivo && cfgAtivo.token) {
    console.log("Token encontrado, carregando API...");
    loadFromAPI();
  } else {
    // Se falhou o arquivo, tenta ver se tem algo no localStorage de sessões anteriores
    const localCfg = loadCfg();
    if (localCfg && localCfg.token) {
        fillCfgUI(localCfg);
        loadFromAPI();
    }
  }

  // 4. Listeners de filtros
  ['filterSearch','filterStatus','filterFrom','filterTo'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', render);
  });

  const fState = document.getElementById('filterState');
  if (fState) {
    fState.addEventListener('change', () => {
      if (allIssues.length) loadFromAPI();
    });
  }
}

// Chama a inicialização
inicializarApp();