'use strict';

/* ─── CONSTANTS & STATE ─────────────────────────────────────────────────── */
const STORE_CFG  = 'gantt_cfg_v2';
const STORE_PROG = 'gantt_prog_v2';
const TODAY = (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })();

const STATUS_COLORS = {
  'Andamento': 'var(--blue)',  'Pausada':   'var(--amber)',
  'Concluída': 'var(--green)', 'Aguardando':'var(--gray)',
  'Não iniciada': 'var(--gray)',
};
const STATUS_CLASS = {
  'Andamento': 'sb-a', 'Pausada': 'sb-p',
  'Concluída': 'sb-c', 'Aguardando':'sb-w', 'Não iniciada':'sb-w',
};
const SUM_CLASS = {
  'Andamento': 's-a', 'Pausada': 's-p',
  'Concluída': 's-c', 'Aguardando':'s-w',
};

const JSONBIN_ID  = "6a17424b21f9ee59d2927ff3";
const JSONBIN_KEY = "$2a$10$3Gy2uaQPtFI5sYWND4e1nOAhKfNcwnqAt/had4F0jmKdWSSItcaGS";
const JSONBIN_API = `https://api.jsonbin.io/v3/b/${JSONBIN_ID}`;

let allIssues    = [];
let progress     = {};
let internalMilestones = [];   // milestones cadastradas internamente
let timeline     = null;
let macroTimeline = null;
let db           = null;       // Instância do Firebase Firestore

function initFirebase(cfg) {
  if (cfg && cfg.firebaseConfig && cfg.firebaseConfig.projectId && cfg.firebaseConfig.apiKey && cfg.firebaseConfig.apiKey !== "SUA_API_KEY") {
    try {
      if (!firebase.apps.length) {
        firebase.initializeApp(cfg.firebaseConfig);
      }
      db = firebase.firestore();
      console.log("Firebase Firestore inicializado com sucesso.");
    } catch (e) {
      console.error("Erro ao inicializar Firebase:", e);
    }
  }
}

// Modo de visualização: 'macro' | 'issues' | 'drill'
let currentView  = 'macro';
let drillMsId    = null;       // ID da milestone em drill-down

// Estado do modal
let editingMsId  = null;
let selectedIssueIids = new Set();

const DEFAULT_CFG = {
  token: '', url: 'https://gitlab.4mti.com.br', group: '94',
  milestone: 'Cliente) Porto Seguro - EPC'
};

/* ─── CONFIG ─────────────────────────────────────────────────────────────── */
function loadCfg() {
  if (window.__API_CONFIG__?.token) return { ...DEFAULT_CFG, ...window.__API_CONFIG__ };
  try {
    const local = JSON.parse(localStorage.getItem(STORE_CFG) || '{}');
    if (local.token) return { ...DEFAULT_CFG, ...local };
  } catch(e) {}
  return { ...DEFAULT_CFG };
}
function readCfgFromUI() {
  return {
    token:     document.getElementById('cfgToken').value.trim(),
    url:       document.getElementById('cfgUrl').value.trim().replace(/\/$/, ''),
    group:     document.getElementById('cfgGroup').value.trim(),
    milestone: document.getElementById('cfgMilestone').value.trim(),
  };
}
function fillCfgUI(cfg) {
  document.getElementById('cfgToken').value     = cfg.token     || '';
  document.getElementById('cfgUrl').value       = cfg.url       || DEFAULT_CFG.url;
  document.getElementById('cfgGroup').value     = cfg.group     || DEFAULT_CFG.group;
  document.getElementById('cfgMilestone').value = cfg.milestone || DEFAULT_CFG.milestone;
}

/* ─── PROGRESS STORE ─────────────────────────────────────────────────────── */
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

/* ─── INTERNAL MILESTONES STORE ─────────────────────────────────────────── */
function saveMilestonesLocal() {
  localStorage.setItem('gantt_milestones_v1', JSON.stringify(internalMilestones));
}
function loadMilestonesLocal() {
  try { internalMilestones = JSON.parse(localStorage.getItem('gantt_milestones_v1') || '[]'); }
  catch { internalMilestones = []; }
}

/* ─── JSONBIN ─────────────────────────────────────────────────────────────── */
async function loadCentralData() {
  if (db) {
    try {
      const doc = await db.collection("gantt").doc("database").get();
      if (doc.exists) {
        const data = doc.data() || {};
        progress = data.progress || {};
        internalMilestones = data.milestones || internalMilestones;
        if (data.issues) {
          allIssues = data.issues;
        }
        saveMilestonesLocal();
      }
      render();
    } catch(e) {
      console.error("Erro ao carregar dados do Firebase Firestore:", e);
    }
    return;
  }

  try {
    const resp = await fetch(JSONBIN_API + "/latest", {
      headers: { "X-Master-Key": JSONBIN_KEY }
    });
    if (resp.ok) {
      const data = await resp.json();
      const rec = data.record || {};
      // Suporte ao novo formato: { progress: {}, milestones: [] }
      if (rec.progress !== undefined) {
        progress = rec.progress || {};
        internalMilestones = rec.milestones || internalMilestones;
        saveMilestonesLocal();
      } else {
        // formato legado: apenas progress
        progress = rec;
      }
      render();
    }
  } catch(e) { console.error("Erro ao carregar banco central:", e); }
}

async function saveToCentralData() {
  if (db) {
    try {
      const dataToSave = {
        progress,
        milestones: internalMilestones,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      
      // Se tivermos issues carregadas na memória, salvamos no cache do Firebase
      if (allIssues && allIssues.length > 0) {
        dataToSave.issues = allIssues;
        dataToSave.issuesSyncedAt = new Date().toISOString();
      }

      await db.collection("gantt").doc("database").set(dataToSave, { merge: true });
      console.log("Dados salvos com sucesso no Firebase Firestore.");
    } catch(e) {
      console.error("Erro ao salvar dados no Firebase Firestore:", e);
    }
    return;
  }

  try {
    await fetch(JSONBIN_API, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Master-Key": JSONBIN_KEY },
      body: JSON.stringify({ progress, milestones: internalMilestones })
    });
  } catch(e) { console.error("Erro ao salvar banco central:", e); }
}

/* ─── VIEW SWITCHER ─────────────────────────────────────────────────────── */
window.switchView = function(view) {
  currentView = view;
  drillMsId   = null;

  const macroWrap   = document.getElementById('macroWrap');
  const issuesWrap  = document.getElementById('issuesWrap');
  const macroTb     = document.getElementById('macroToolbar');
  const issueTb     = document.getElementById('issueToolbar');
  const breadcrumb  = document.getElementById('breadcrumb');
  const btnMs       = document.getElementById('btnMilestones');
  const fabMacro    = document.getElementById('fabMacro');
  const fabIssues   = document.getElementById('fabIssues');

  if (view === 'macro') {
    macroWrap.style.display  = '';
    issuesWrap.style.display = 'none';
    macroTb.style.display    = '';
    issueTb.style.display    = 'none';
    breadcrumb.style.display = 'none';
    btnMs.style.display      = '';
    fabMacro.classList.add('active');
    fabIssues.classList.remove('active');
    renderMacro();
  } else if (view === 'issues') {
    macroWrap.style.display  = 'none';
    issuesWrap.style.display = '';
    macroTb.style.display    = 'none';
    issueTb.style.display    = '';
    breadcrumb.style.display = 'none';
    btnMs.style.display      = '';
    fabMacro.classList.remove('active');
    fabIssues.classList.add('active');
    render();
  }
};

window.enterDrill = function(msId) {
  const ms = internalMilestones.find(m => m.id === msId);
  if (!ms) return;

  currentView = 'drill';
  drillMsId   = msId;

  document.getElementById('macroWrap').style.display  = 'none';
  document.getElementById('issuesWrap').style.display = '';
  document.getElementById('macroToolbar').style.display = 'none';
  document.getElementById('issueToolbar').style.display = '';
  document.getElementById('breadcrumb').style.display  = 'flex';
  document.getElementById('breadcrumbLabel').textContent = ms.name;
  document.getElementById('btnMilestones').style.display = 'none';
  document.getElementById('fabMacro').classList.remove('active');
  document.getElementById('fabIssues').classList.remove('active');

  render();
};

window.exitDrill = function() {
  switchView('macro');
};

/* ─── API ─────────────────────────────────────────────────────────────────── */
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
  if (labels.includes('done')) return 'Concluída';
  if (labels.some(l => ['pausada','paused','bloqueada','blocked'].includes(l))) return 'Pausada';
  if (labels.some(l => ['aguardando','waiting','pendente'].includes(l))) return 'Aguardando';
  return 'Andamento';
}
function inferProgress(issue) {
  const desc = issue.description || '';
  const labels = (issue.labels||[]).map(l => l.toLowerCase());
  if (labels.includes('done')) return 100;
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
  const uiCfg    = readCfgFromUI();
  const cfg = {
    token:     uiCfg.token     || savedCfg.token,
    url:       uiCfg.url       || savedCfg.url,
    group:     uiCfg.group     || savedCfg.group,
    milestone: uiCfg.milestone || savedCfg.milestone,
  };
  if (!cfg.token || !cfg.url || !cfg.group) {
    setApiStatus('⚠ Token ou IDs ausentes', 'warn'); return;
  }
  if (!window.__API_CONFIG__) localStorage.setItem(STORE_CFG, JSON.stringify(cfg));

  setApiStatus('⏳ Carregando...', 'loading');
  try {
    const stateFilter = document.getElementById('filterState').value || 'opened';
    const params = new URLSearchParams({ state: stateFilter, per_page: '100' });
    if (cfg.milestone) params.append('milestone', cfg.milestone);
    const ignoredLabels = ['Ready','Specification'];
    if (ignoredLabels.length) params.append('not[labels]', ignoredLabels.join(','));

    const raw = await fetchAllPages(
      `${cfg.url}/api/v4/groups/${cfg.group}/issues?${params.toString()}`,
      cfg.token
    );
    allIssues = raw.map(mapIssue)
      .filter(i => !i.labels.some(l => ignoredLabels.includes(l)));
    allIssues.sort((a,b) => (a.start||'9999').localeCompare(b.start||'9999'));

    document.getElementById('msBadge').textContent = cfg.milestone || 'Todas';
    document.getElementById('btnReload').style.display = 'inline-block';
    setApiStatus(`✅ ${allIssues.length} issues`, 'ok');

    setDefaultFilters();

    let needsSync = false;
    allIssues.forEach(issue => {
      if (!progress[issue.iid]) {
        progress[issue.iid] = { pct: issue.apiProgress, status: issue.apiStatus, updatedAt: new Date().toISOString() };
        needsSync = true;
      } else if (!progress[issue.iid].status) {
        progress[issue.iid].status = issue.apiStatus;
        needsSync = true;
      }
    });
    if (needsSync) { saveProgress(); }
    
    // Sempre atualiza o cache no Firebase quando a requisição ao GitLab for bem-sucedida
    await saveToCentralData();

    // Atualiza picker do modal se estiver aberto
    if (document.getElementById('msModal').style.display !== 'none') populateIssuePicker();

    render();
    if (currentView === 'macro') renderMacro();

  } catch(e) {
    console.error("Erro ao carregar do GitLab, tentando cache do Firebase...", e);
    
    if (db) {
      try {
        const doc = await db.collection("gantt").doc("database").get();
        if (doc.exists) {
          const data = doc.data() || {};
          if (data.issues && data.issues.length > 0) {
            allIssues = data.issues;
            const syncDate = data.issuesSyncedAt ? fmtBR(data.issuesSyncedAt.slice(0, 10)) : 'desconhecida';
            
            setApiStatus(`☁ Cache: ${allIssues.length} issues (Sinc: ${syncDate})`, 'ok');
            document.getElementById('btnReload').style.display = 'inline-block';
            
            setDefaultFilters();
            if (document.getElementById('msModal').style.display !== 'none') populateIssuePicker();
            
            render();
            if (currentView === 'macro') renderMacro();
            return;
          }
        }
      } catch (dbErr) {
        console.error("Falha ao recuperar cache do Firebase:", dbErr);
      }
    }
    
    setApiStatus(`❌ Erro: ${e.message}`, 'err');
  }
}

/* ─── FILTERS ─────────────────────────────────────────────────────────────── */
function setDefaultFilters() {
  const now = new Date(TODAY);
  const day = now.getDay();
  const s   = new Date(now); s.setDate(now.getDate() - day);
  const e   = new Date(now); e.setDate(now.getDate() + (6 - day));
  document.getElementById('filterFrom').value = fmt(s);
  document.getElementById('filterTo').value   = fmt(e);
}
function resetFilters() {
  document.getElementById('filterSearch').value = '';
  document.getElementById('filterStatus').value = '';
  setDefaultFilters();
  render();
}
function applyFilters() {
  let issues = [...allIssues];
  if (currentView === 'drill' && drillMsId !== null) {
    const ms = internalMilestones.find(m => m.id === drillMsId);
    const iids = new Set((ms?.issueIids || []).map(Number));
    issues = issues.filter(i => iids.has(Number(i.iid)));
  }
  const from   = document.getElementById('filterFrom').value;
  const to     = document.getElementById('filterTo').value;
  const status = document.getElementById('filterStatus').value;
  const search = document.getElementById('filterSearch').value.toLowerCase();
  return issues.filter(i => {
    const iStatus = effectiveStatus(i);
    if (status && iStatus !== status) return false;
    if (search && !String(i.iid).includes(search) && !i.title.toLowerCase().includes(search)) return false;
    if (from && i.end && i.end < from) return false;
    if (to && i.start && i.start > to) return false;
    return true;
  });
}

/* ─── MACRO FILTERS ─────────────────────────────────────────────────────── */
function setDefaultMacroFilters() {
  if (!internalMilestones.length) return;
  const dates = internalMilestones.flatMap(m => [m.start, m.end].filter(Boolean));
  if (!dates.length) return;
  const min = dates.reduce((a,b) => a < b ? a : b);
  const max = dates.reduce((a,b) => a > b ? a : b);
  document.getElementById('macroFrom').value = min;
  document.getElementById('macroTo').value   = max;
}
window.resetMacroFilters = function() {
  document.getElementById('macroSearch').value = '';
  setDefaultMacroFilters();
  renderMacro();
};
window.changeMacroWeek = function(days) {
  const f = document.getElementById('macroFrom');
  const t = document.getElementById('macroTo');
  let d0 = parseD(f.value), d1 = parseD(t.value);
  d0.setDate(d0.getDate() + days); d1.setDate(d1.getDate() + days);
  f.value = fmt(d0); t.value = fmt(d1);
  renderMacro();
};
function applyMacroFilters() {
  const search = document.getElementById('macroSearch').value.toLowerCase();
  return internalMilestones.filter(m => !search || m.name.toLowerCase().includes(search));
}

/* ─── HELPERS ─────────────────────────────────────────────────────────────── */
window.changeWeek = function(days) {
  const fFrom = document.getElementById('filterFrom');
  const fTo   = document.getElementById('filterTo');
  let d0 = parseD(fFrom.value), d1 = parseD(fTo.value);
  d0.setDate(d0.getDate() + days); d1.setDate(d1.getDate() + days);
  fFrom.value = fmt(d0); fTo.value = fmt(d1);
  render();
};
function getWeekNumber(d) {
  d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay()||7));
  const y = new Date(Date.UTC(d.getUTCFullYear(),0,1));
  return Math.ceil((((d-y)/86400000)+1)/7);
}
function fmt(d)   { return d.toISOString().slice(0,10); }
function parseD(s) {
  if (!s) return new Date();
  const [y,m,d] = s.split('-').map(Number);
  const dt = new Date(y,m-1,d); dt.setHours(0,0,0,0); return dt;
}
function fmtBR(s) {
  if (!s) return '—';
  return new Date(s+'T12:00:00').toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'});
}
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function effectivePct(issue)    { return progress[issue.iid]?.pct    ?? issue.apiProgress; }
function effectiveStatus(issue) { return progress[issue.iid]?.status ?? issue.apiStatus;   }
function rowOf(iid)             { return document.querySelector(`tr[data-iid="${iid}"]`); }
function updateProgUI_Minimal(row, pct, status) {
  if (!row) return;
  const fill  = row.querySelector('.prog-fill');
  const label = row.querySelector('.prog-label');
  const color = STATUS_COLORS[status||'Andamento']||'var(--blue)';
  if (fill)  { fill.style.width = pct+'%'; fill.style.background = color; }
  if (label) label.textContent = pct+'%';
}

/* ─── RENDER (ISSUES) ────────────────────────────────────────────────────── */
function render() {
  if (currentView === 'macro') { renderMacro(); return; }
  const issues = applyFilters();
  const countEl = document.getElementById('filterCount');
  if (countEl) countEl.textContent = issues.length < allIssues.length
    ? `${issues.length} / ${allIssues.length}` : `${issues.length} issues`;

  const msBadge = document.getElementById('msBadge');
  if (currentView === 'drill' && drillMsId) {
    const ms = internalMilestones.find(m => m.id === drillMsId);
    msBadge.textContent = ms ? ms.name : '—';
  } else {
    const savedCfg = loadCfg();
    msBadge.textContent = `${savedCfg.milestone||'Geral'} | Semana ${getWeekNumber(TODAY)}`;
  }

  renderSummary(issues);
  buildTimeline('filterFrom','filterTo','tlHeader');
  renderRows(issues);
}

function renderSummary(issues) {
  const counts = {}; let totalPct = 0;
  issues.forEach(i => {
    const s = effectiveStatus(i);
    counts[s] = (counts[s]||0)+1;
    totalPct += effectivePct(i);
  });
  const avg = issues.length ? Math.round(totalPct/issues.length) : 0;
  const order = ['Andamento','Concluída','Pausada','Aguardando'];
  let html = order.map(s => counts[s]
    ? `<div class="sum-card ${SUM_CLASS[s]}"><span class="val">${counts[s]}</span> ${s}</div>` : '').join('');
  html += `<div class="sum-card s-avg"><span class="val">${avg}%</span> médio</div>`;
  document.getElementById('summary').innerHTML = html;
}

function buildTimeline(fromId, toId, headerId) {
  const from = document.getElementById(fromId)?.value;
  const to   = document.getElementById(toId)?.value;
  if (!from || !to) {
    if (fromId === 'filterFrom') timeline = null;
    else macroTimeline = null;
    return;
  }
  const t0   = parseD(from);
  const t1   = parseD(to);
  const span = Math.max(1, Math.round((t1-t0)/86400000));
  const tl   = { t0, t1, span };
  if (fromId === 'filterFrom') timeline = tl; else macroTimeline = tl;

  const hdr = document.getElementById(headerId);
  if (!hdr) return;
  hdr.innerHTML = '';

  let dayStep = 1;
  if (span > 365)      dayStep = 90; // A cada 3 meses
  else if (span > 180) dayStep = 30; // A cada mês
  else if (span > 90)  dayStep = 14; // A cada 2 semanas
  else if (span > 45)  dayStep = 7;  // A cada semana
  else if (span > 20)  dayStep = 5;  // A cada 5 dias
  else if (span > 10)  dayStep = 2;  // A cada 2 dias

  for (let i = 0; i <= span; i += dayStep) {
    const cur = new Date(t0); cur.setDate(t0.getDate()+i);
    const pct = (i/span)*100;
    const tick = document.createElement('div');
    tick.className = 'tl-tick';
    tick.style.left = pct+'%';
    if (i+dayStep > span) {
      tick.style.transform = 'translateX(-100%)';
      tick.style.borderLeft = 'none';
      tick.style.textAlign = 'right';
    }
    tick.textContent = cur.toLocaleDateString('pt-BR',{day:'2-digit',month:'short'});
    hdr.appendChild(tick);
  }
  if (TODAY >= t0 && TODAY <= t1) {
    const pct = ((TODAY-t0)/(t1-t0))*100;
    hdr.insertAdjacentHTML('beforeend',
      `<div class="today-line" style="left:${pct}%"></div>
       <div class="today-lbl" style="left:${pct}%;z-index:11">hoje</div>`);
  }
}

function timeBarColor(status, timePct, progressPct) {
  if (status==='Aguardando')   return 'var(--gray)';
  if (status==='Pausada')      return 'var(--amber)';
  if (status==='Concluída')    return 'var(--green)';
  if (status==='Não iniciada') return 'var(--gray)';
  const gap = timePct - progressPct;
  if (gap>35) return 'var(--red)';
  if (gap>15) return 'var(--orange)';
  return 'var(--blue)';
}

function pctPosInTl(dateStr, tl) {
  if (!tl || !dateStr) return null;
  const d = parseD(dateStr);
  return Math.max(0, Math.min(100, (d-tl.t0)/(tl.t1-tl.t0)*100));
}
function pctPos(dateStr) { return pctPosInTl(dateStr, timeline); }

function buildBarHTML(start, end, status, pct, tl, isOverdue) {
  const L = pctPosInTl(start, tl);
  const R = pctPosInTl(end,   tl);
  if (L === null || R === null || R <= L) {
    if (start) {
      const l = pctPosInTl(start, tl);
      if (l !== null) {
        const color = STATUS_COLORS[status]||'var(--gray)';
        return `<div class="bar-ghost" style="left:${l}%;width:2%;min-width:4px;background:${color}"></div>`;
      }
    }
    return '';
  }
  const w = R - L;
  let fillFactor = 0, isCritical = false;
  if (isOverdue) { fillFactor = 1; isCritical = true; }
  else if (status === 'Concluída') { fillFactor = 1; }
  else {
    const t0 = parseD(start), t1 = parseD(end);
    fillFactor = Math.max(0, Math.min(1, (TODAY-t0)/(t1-t0)));
  }
  const timePct  = Math.round(fillFactor*100);
  const barColor = isCritical ? 'var(--red)' : timeBarColor(status, timePct, pct);
  const critCls  = isCritical ? 'bar-overdue' : '';
  const doneW    = w * fillFactor;
  return `
    <div class="bar-ghost" style="left:${L}%;width:${w}%;background:${barColor}"></div>
    <div class="bar-done ${critCls}" style="left:${L}%;width:${doneW}%;background:${barColor}"></div>
    ${timePct > 0 ? `<div class="bar-lbl" style="left:${L+doneW-1}%">${timePct}%</div>` : ''}
  `;
}

function renderRows(issues) {
  const body = document.getElementById('ganttBody');
  if (!issues.length) {
    body.innerHTML = '<tr><td colspan="7" class="no-data">Nenhuma issue nos filtros aplicados.</td></tr>';
    return;
  }
  const todayStr = fmt(TODAY);
  body.innerHTML = issues.map(issue => {
    const status   = effectiveStatus(issue);
    const pct      = effectivePct(issue);
    const color    = STATUS_COLORS[status]||'var(--gray)';
    const sClass   = STATUS_CLASS[status]||'sb-w';
    const isOverdue = issue.end && issue.end < todayStr && status !== 'Concluída';
    const barHTML  = buildBarHTML(issue.start, issue.end, status, pct, timeline, isOverdue);
    return `<tr data-iid="${issue.iid}">
      <td><span class="iid">#${issue.iid}</span></td>
      <td>${issue.url
        ? `<a class="issue-link" href="${esc(issue.url)}" target="_blank">${esc(issue.title)}</a>`
        : `<span>${esc(issue.title)}</span>`}</td>
      <td class="date-cell">${fmtBR(issue.start)}</td>
      <td class="date-cell ${isOverdue?'overdue':''}">${fmtBR(issue.end)}</td>
      <td>
        <select class="sbadge ${sClass}" onchange="changeStatus(${issue.iid},this.value,this)">
          ${['Andamento','Pausada','Concluída','Aguardando'].map(s=>
            `<option value="${s}" ${s===status?'selected':''}>${s}</option>`).join('')}
        </select>
      </td>
      <td class="progress-col">
        <div class="prog-track" onmousedown="startDrag(event,${issue.iid})" ontouchstart="startDragTouch(event,${issue.iid})">
          <div class="prog-fill" style="width:${pct}%;background:${color}"></div>
          <div class="prog-label">${pct}%</div>
        </div>
      </td>
      <td class="bar-cell-td"><div class="bar-outer">${barHTML}</div></td>
    </tr>`;
  }).join('');
}

/* ─── RENDER (MACRO) ─────────────────────────────────────────────────────── */
function renderMacro() {
  if (!document.getElementById('macroFrom').value) setDefaultMacroFilters();
  buildTimeline('macroFrom','macroTo','macroTlHeader');

  const mss = applyMacroFilters();
  const body = document.getElementById('macroBody');
  const countEl = document.getElementById('macroCount');
  if (countEl) countEl.textContent = `${mss.length} milestones`;

  if (!mss.length) {
    body.innerHTML = '<tr><td colspan="7" class="no-data">Nenhuma milestone cadastrada. Clique em ⊞ Milestones.</td></tr>';
    return;
  }
  const todayStr = fmt(TODAY);
  body.innerHTML = mss.map(ms => {
    const { autoProgress, manualProgress, status } = getMsProgress(ms);
    const displayPct = manualProgress !== null ? manualProgress : autoProgress;
    const color   = ms.color || 'var(--blue)';
    const sClass  = STATUS_CLASS[ms.status]||'sb-w';
    const isOverdue = ms.end && ms.end < todayStr && ms.status !== 'Concluída';
    const barHTML = buildBarHTML(ms.start, ms.end, ms.status, displayPct, macroTimeline, isOverdue);

    return `<tr data-ms-id="${ms.id}" class="ms-row" onclick="enterDrill('${ms.id}')">
      <td style="width:32px">
        <span class="ms-color-dot" style="background:${color}"></span>
      </td>
      <td>
        <span class="ms-name">${esc(ms.name)}</span>
        <span class="ms-issue-count">${ms.issueIids?.length||0} issues</span>
      </td>
      <td class="date-cell">${fmtBR(ms.start)}</td>
      <td class="date-cell ${isOverdue?'overdue':''}">${fmtBR(ms.end)}</td>
      <td>
        <span class="sbadge ${sClass}">${ms.status}</span>
      </td>
      <td class="progress-col" onclick="event.stopPropagation()">
        <div class="prog-track macro-prog-track" data-ms-id="${ms.id}"
             onmousedown="startMsDrag(event,'${ms.id}')"
             ontouchstart="startMsDragTouch(event,'${ms.id}')">
          <div class="prog-fill" style="width:${displayPct}%;background:${color}"></div>
          <div class="prog-label">${displayPct}%</div>
        </div>
        ${autoProgress !== displayPct
          ? `<div class="auto-prog-hint">auto: ${autoProgress}%</div>` : ''}
      </td>
      <td class="bar-cell-td"><div class="bar-outer">${barHTML}</div></td>
    </tr>`;
  }).join('');
}

function getMsProgress(ms) {
  // Progresso automático: média das issues vinculadas
  let autoProgress = 0;
  if (ms.issueIids?.length && allIssues.length) {
    const linked = allIssues.filter(i => ms.issueIids.map(Number).includes(Number(i.iid)));
    if (linked.length) {
      autoProgress = Math.round(linked.reduce((s,i) => s + effectivePct(i), 0) / linked.length);
    }
  }
  // Progresso manual (salvo no progress store com key "ms_<id>")
  const manualProgress = progress[`ms_${ms.id}`]?.pct ?? null;
  // Status derivado das issues se não definido manualmente
  const status = ms.status || 'Não iniciada';
  return { autoProgress, manualProgress, status };
}

/* ─── DRAG PROGRESS (ISSUES) ─────────────────────────────────────────────── */
window.changeStatus = function(iid, val, sel) {
  if (!progress[iid]) progress[iid] = { pct: 0 };
  progress[iid].status = val;
  progress[iid].updatedAt = new Date().toISOString();
  if (val === 'Concluída') progress[iid].pct = 100;
  saveProgress(); saveToCentralData(); render();
};

window.startDrag = function(e, iid) {
  e.preventDefault();
  const track = e.currentTarget;
  const onMove = ev => {
    const rect = track.getBoundingClientRect();
    const p = Math.round(Math.min(100, Math.max(0, (ev.clientX-rect.left)/rect.width*100)));
    if (!progress[iid]) progress[iid] = {};
    progress[iid].pct = p;
    updateProgUI_Minimal(rowOf(iid), p, progress[iid].status);
  };
  const onUp = () => {
    if (progress[iid]) progress[iid].updatedAt = new Date().toISOString();
    saveProgress(); saveToCentralData(); render();
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  onMove(e);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
};
window.startDragTouch = function(e, iid) {
  const track = e.currentTarget;
  const onMove = ev => {
    const t = ev.touches[0];
    const rect = track.getBoundingClientRect();
    const p = Math.round(Math.min(100, Math.max(0, (t.clientX-rect.left)/rect.width*100)));
    if (!progress[iid]) progress[iid] = {};
    progress[iid].pct = p;
    updateProgUI_Minimal(rowOf(iid), p, progress[iid].status);
  };
  const onEnd = () => {
    saveProgress(); render();
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onEnd);
  };
  document.addEventListener('touchmove', onMove, {passive:false});
  document.addEventListener('touchend', onEnd);
};

/* ─── DRAG PROGRESS (MACROS) ─────────────────────────────────────────────── */
window.startMsDrag = function(e, msId) {
  e.preventDefault();
  const track = e.currentTarget;
  const onMove = ev => {
    const rect = track.getBoundingClientRect();
    const p = Math.round(Math.min(100, Math.max(0, (ev.clientX-rect.left)/rect.width*100)));
    if (!progress[`ms_${msId}`]) progress[`ms_${msId}`] = {};
    progress[`ms_${msId}`].pct = p;
    const fill  = track.querySelector('.prog-fill');
    const label = track.querySelector('.prog-label');
    const ms    = internalMilestones.find(m => m.id === msId);
    const color = ms?.color || 'var(--blue)';
    if (fill)  { fill.style.width = p+'%'; fill.style.background = color; }
    if (label) label.textContent = p+'%';
  };
  const onUp = () => {
    saveProgress(); saveToCentralData(); renderMacro();
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  onMove(e);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
};
window.startMsDragTouch = function(e, msId) {
  const track = e.currentTarget;
  const onMove = ev => {
    const t = ev.touches[0];
    const rect = track.getBoundingClientRect();
    const p = Math.round(Math.min(100, Math.max(0, (t.clientX-rect.left)/rect.width*100)));
    if (!progress[`ms_${msId}`]) progress[`ms_${msId}`] = {};
    progress[`ms_${msId}`].pct = p;
    const fill  = track.querySelector('.prog-fill');
    const label = track.querySelector('.prog-label');
    if (fill)  fill.style.width = p+'%';
    if (label) label.textContent = p+'%';
  };
  const onEnd = () => {
    saveProgress(); saveToCentralData(); renderMacro();
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onEnd);
  };
  document.addEventListener('touchmove', onMove, {passive:false});
  document.addEventListener('touchend', onEnd);
};

/* ─── MODAL: MILESTONES ──────────────────────────────────────────────────── */
window.openMsModal = function() {
  editingMsId = null;
  selectedIssueIids = new Set();
  clearMsForm();
  renderMsList();
  populateIssuePicker();
  document.getElementById('msModal').style.display = '';
  document.getElementById('msModalBackdrop').style.display = '';
  document.getElementById('msFormTitle').textContent = 'Nova Milestone';
};
window.closeMsModal = function() {
  document.getElementById('msModal').style.display = 'none';
  document.getElementById('msModalBackdrop').style.display = 'none';
  editingMsId = null;
};

function clearMsForm() {
  document.getElementById('msName').value   = '';
  document.getElementById('msStart').value  = '';
  document.getElementById('msEnd').value    = '';
  document.getElementById('msColor').value  = '#2e6fcc';
  document.getElementById('msStatus').value = 'Não iniciada';
  selectedIssueIids = new Set();
  updatePickerCount();
}

window.cancelMsForm = function() {
  editingMsId = null;
  clearMsForm();
  renderMsList();
};

function renderMsList() {
  const list  = document.getElementById('msList');
  const empty = document.getElementById('msListEmpty');
  if (!internalMilestones.length) {
    empty.style.display = '';
    list.querySelectorAll('.ms-list-item').forEach(el => el.remove());
    return;
  }
  empty.style.display = 'none';
  list.querySelectorAll('.ms-list-item').forEach(el => el.remove());
  internalMilestones.forEach(ms => {
    const div = document.createElement('div');
    div.className = 'ms-list-item';
    div.innerHTML = `
      <span class="ms-list-dot" style="background:${ms.color||'#2e6fcc'}"></span>
      <div class="ms-list-info">
        <span class="ms-list-name">${esc(ms.name)}</span>
        <span class="ms-list-meta">${fmtBR(ms.start)} → ${fmtBR(ms.end)} · ${ms.issueIids?.length||0} issues · <b>${ms.status}</b></span>
      </div>
      <div class="ms-list-actions">
        <button class="btn" onclick="editMilestone('${ms.id}')">✎ Editar</button>
        <button class="btn btn-danger" onclick="deleteMilestone('${ms.id}')">✕</button>
      </div>
    `;
    list.appendChild(div);
  });
}

window.editMilestone = function(id) {
  const ms = internalMilestones.find(m => m.id === id);
  if (!ms) return;
  editingMsId = id;
  document.getElementById('msName').value   = ms.name;
  document.getElementById('msStart').value  = ms.start || '';
  document.getElementById('msEnd').value    = ms.end   || '';
  document.getElementById('msColor').value  = ms.color || '#2e6fcc';
  document.getElementById('msStatus').value = ms.status || 'Não iniciada';
  selectedIssueIids = new Set((ms.issueIids||[]).map(Number));
  document.getElementById('msFormTitle').textContent = 'Editar Milestone';
  populateIssuePicker();
  updatePickerCount();
};

window.deleteMilestone = function(id) {
  if (!confirm('Remover esta milestone?')) return;
  internalMilestones = internalMilestones.filter(m => m.id !== id);
  saveMilestonesLocal(); saveToCentralData();
  renderMsList();
  if (currentView === 'macro') renderMacro();
};

window.saveMilestone = function() {
  const name   = document.getElementById('msName').value.trim();
  const start  = document.getElementById('msStart').value;
  const end    = document.getElementById('msEnd').value;
  const color  = document.getElementById('msColor').value;
  const status = document.getElementById('msStatus').value;

  if (!name)  { alert('Informe o nome da milestone.'); return; }
  if (!start) { alert('Informe a data de início.'); return; }
  if (!end)   { alert('Informe a data de fim.'); return; }
  if (end < start) { alert('A data de fim não pode ser anterior ao início.'); return; }

  const issueIids = [...selectedIssueIids];

  if (editingMsId) {
    const idx = internalMilestones.findIndex(m => m.id === editingMsId);
    if (idx !== -1) {
      internalMilestones[idx] = { ...internalMilestones[idx], name, start, end, color, status, issueIids };
    }
  } else {
    const id = 'ms_' + Date.now();
    internalMilestones.push({ id, name, start, end, color, status, issueIids });
  }

  saveMilestonesLocal(); saveToCentralData();
  editingMsId = null;
  clearMsForm();
  renderMsList();
  setDefaultMacroFilters();
  if (currentView === 'macro') renderMacro();
  document.getElementById('msFormTitle').textContent = 'Nova Milestone';
};

/* ─── ISSUE PICKER ─────────────────────────────────────────────────────── */
function populateIssuePicker() {
  const picker = document.getElementById('issuePicker');
  picker.innerHTML = '';

  if (!allIssues.length) {
    picker.innerHTML = '<p class="picker-empty">Carregue as issues da API primeiro (botão ▶ Carregar).</p>';
    return;
  }

  const search = (document.getElementById('issuePickerSearch')?.value || '').toLowerCase();
  const shown  = allIssues.filter(i =>
    !search || String(i.iid).includes(search) || i.title.toLowerCase().includes(search)
  );

  shown.forEach(issue => {
    const checked = selectedIssueIids.has(Number(issue.iid));
    const row = document.createElement('label');
    row.className = 'picker-row' + (checked ? ' checked' : '');
    row.innerHTML = `
      <input type="checkbox" value="${issue.iid}" ${checked?'checked':''} onchange="toggleIssue(${issue.iid},this)">
      <span class="picker-iid">#${issue.iid}</span>
      <span class="picker-title">${esc(issue.title)}</span>
      <span class="picker-dates">${fmtBR(issue.start)} → ${fmtBR(issue.end)}</span>
    `;
    picker.appendChild(row);
  });

  if (!shown.length) {
    picker.innerHTML = '<p class="picker-empty">Nenhuma issue encontrada.</p>';
  }
}

window.toggleIssue = function(iid, checkbox) {
  if (checkbox.checked) selectedIssueIids.add(Number(iid));
  else                  selectedIssueIids.delete(Number(iid));
  const row = checkbox.closest('.picker-row');
  if (row) row.classList.toggle('checked', checkbox.checked);
  updatePickerCount();
};

function updatePickerCount() {
  const el = document.getElementById('issuePickerCount');
  if (el) el.textContent = `${selectedIssueIids.size} selecionadas`;
}

window.filterIssuePicker = function() {
  populateIssuePicker();
};

/* ─── CREDENTIALS ─────────────────────────────────────────────────────────── */
async function loadCredentials() {
  let apiCfg = window.__API_CONFIG__ || null;
  let fileCfg = null;
  try {
    const resp = await fetch(`config.json?t=${Date.now()}`);
    if (resp.ok) {
      fileCfg = await resp.json();
    }
  } catch(e) { console.error("Erro ao carregar config.json:", e); }

  const cfg = apiCfg || fileCfg || {};
  const fCfg = (fileCfg && fileCfg.firebaseConfig && fileCfg.firebaseConfig.apiKey && fileCfg.firebaseConfig.apiKey !== "SUA_API_KEY") 
    ? fileCfg.firebaseConfig 
    : (apiCfg && apiCfg.firebaseConfig && apiCfg.firebaseConfig.apiKey && apiCfg.firebaseConfig.apiKey !== "SUA_API_KEY")
      ? apiCfg.firebaseConfig
      : null;

  const finalCfg = {
    token:          cfg.token          || '',
    url:            cfg.url            || 'https://gitlab.4mti.com.br',
    group:          cfg.group          || '',
    milestone:      cfg.milestone      || '',
    firebaseConfig: fCfg
  };

  fillCfgUI(finalCfg);
  localStorage.setItem(STORE_CFG, JSON.stringify(finalCfg));
  return finalCfg;
}

/* ─── INIT ──────────────────────────────────────────────────────────────── */
async function inicializarApp() {
  loadProgress();
  loadMilestonesLocal();

  const cfgAtivo = await loadCredentials();
  initFirebase(cfgAtivo);
  await loadCentralData();

  if (cfgAtivo?.token) {
    loadFromAPI();
  } else {
    const localCfg = loadCfg();
    if (localCfg?.token) { fillCfgUI(localCfg); loadFromAPI(); }
  }

  // Inicia na visão macro
  switchView('macro');

  // Listeners de filtros de issues
  ['filterSearch','filterStatus','filterFrom','filterTo'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', render);
  });
  const fState = document.getElementById('filterState');
  if (fState) fState.addEventListener('change', () => { if (allIssues.length) loadFromAPI(); });

  // Listeners de filtros macro
  ['macroFrom','macroTo','macroSearch'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', renderMacro);
  });
}

inicializarApp();
