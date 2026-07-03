'use strict';

/* ─── CONSTANTS & STATE ─────────────────────────────────────────────────── */
const STORE_CFG       = 'gantt_cfg_v2';
const STORE_PROG      = 'gantt_prog_v2';
const STORE_PROJECTS  = 'gantt_projects_v1';
const STORE_ACTIVE    = 'gantt_active_project_v1';
const ADMIN_EMAIL     = 'pisjuliano@gmail.com';

const TODAY = (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })();

const STATUS_COLORS = {
  'Andamento':'var(--blue)','Pausada':'var(--amber)',
  'Concluída':'var(--green)','Aguardando':'var(--gray)','Não iniciada':'var(--gray)',
};
const STATUS_CLASS = {
  'Andamento':'sb-a','Pausada':'sb-p',
  'Concluída':'sb-c','Aguardando':'sb-w','Não iniciada':'sb-w',
};
const SUM_CLASS = {
  'Andamento':'s-a','Pausada':'s-p',
  'Concluída':'s-c','Aguardando':'s-w','Não iniciada':'s-w',
};

const JSONBIN_ID  = "6a17424b21f9ee59d2927ff3";
const JSONBIN_KEY = "$2a$10$3Gy2uaQPtFI5sYWND4e1nOAhKfNcwnqAt/had4F0jmKdWSSItcaGS";
const JSONBIN_API = `https://api.jsonbin.io/v3/b/${JSONBIN_ID}`;

let allIssues         = [];
let progress          = {};
let internalMilestones= [];
let timeline          = null;
let macroTimeline     = null;
let db                = null;

/* Auth state */
let currentUser  = null;  // firebase.User
let userProfile  = null;  // { role, allowedProjects, displayName }

/* ─── MULTI-PROJECT STATE ────────────────────────────────────────────────── */
/*
  projects: [{
    id: 'proj_<ts>',
    name: 'EPC',
    token: '',
    url: 'https://gitlab...',
    group: '94',
    milestone: 'Cliente) Porto Seguro - EPC',
    firebaseConfig: {...} | null,
  }]
  activeProjectId: string | null
*/
let projects         = [];
let activeProjectId  = null;

function getActiveProject() {
  return projects.find(p => p.id === activeProjectId) || null;
}

/* ─── PROJECTS STORE ─────────────────────────────────────────────────────── */
function saveProjectsLocal() {
  localStorage.setItem(STORE_PROJECTS, JSON.stringify(projects));
  localStorage.setItem(STORE_ACTIVE,   activeProjectId || '');
  saveProjectsToCloud();
}
function loadProjectsLocal() {
  try { projects = JSON.parse(localStorage.getItem(STORE_PROJECTS) || '[]'); } catch { projects = []; }
  activeProjectId = localStorage.getItem(STORE_ACTIVE) || null;
  if (activeProjectId && !projects.find(p => p.id === activeProjectId)) activeProjectId = null;
}

/* Documento "raiz" no Firestore que guarda a LISTA de projetos cadastrados.
   Isso é o que permite acessar os mesmos projetos de qualquer dispositivo. */
async function saveProjectsToCloud() {
  if (!db) return;
  try {
    await db.collection('gantt').doc('projects_registry').set({
      projects,
      activeProjectId,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch(e) { console.error('Erro ao salvar lista de projetos no Firestore:', e); }
}

async function loadProjectsFromCloud() {
  if (!db) return false;
  try {
    const doc = await db.collection('gantt').doc('projects_registry').get();
    if (doc.exists) {
      const data = doc.data() || {};
      if (Array.isArray(data.projects) && data.projects.length) {
        projects = data.projects;
        // Só usa o activeProjectId salvo na nuvem se ainda não houver um local
        // (assim cada dispositivo pode estar olhando um projeto diferente)
        if (!activeProjectId || !projects.find(p => p.id === activeProjectId)) {
          activeProjectId = data.activeProjectId && projects.find(p => p.id === data.activeProjectId)
            ? data.activeProjectId
            : projects[0].id;
        }
        saveProjectsLocalRaw(); // espelha no localStorage sem re-disparar save na nuvem
        return true;
      }
    }
  } catch(e) { console.error('Erro ao carregar lista de projetos do Firestore:', e); }
  return false;
}

/* Versão "crua" que só grava local, sem chamar saveProjectsToCloud (evita loop) */
function saveProjectsLocalRaw() {
  localStorage.setItem(STORE_PROJECTS, JSON.stringify(projects));
  localStorage.setItem(STORE_ACTIVE,   activeProjectId || '');
}

/* ─── FIREBASE PER-PROJECT ───────────────────────────────────────────────── */
function initFirebase(fCfg) {
  db = null;
  if (!fCfg || !fCfg.projectId || !fCfg.apiKey || fCfg.apiKey === 'SUA_API_KEY') return;
  try {
    if (!firebase.apps.length) firebase.initializeApp(fCfg);
    db = firebase.firestore();
    console.log('Firebase inicializado:', fCfg.projectId);
  } catch(e) { console.error('Firebase init error:', e); }
}

/* Chave do documento no Firestore — isolada por projeto */
function projectDocId() {
  const proj = getActiveProject();
  if (!proj) return 'database';
  return `project_${proj.id}`;
}

/* ─── AUTH ─────────────────────────────────────────────────────────────────── */

/* Mostra/oculta as telas principais do app */
function showAppUI()     { document.getElementById('loginScreen')?.style && (document.getElementById('loginScreen').style.display = 'none');   document.getElementById('pendingScreen')?.style && (document.getElementById('pendingScreen').style.display = 'none'); }
function showLoginUI()   { document.getElementById('loginScreen').style.display = '';  document.getElementById('pendingScreen').style.display = 'none'; }
function showPendingUI() { document.getElementById('loginScreen').style.display = 'none'; document.getElementById('pendingScreen').style.display = ''; }

/* Alterna entre as abas Entrar / Cadastrar-se */
window.switchLoginTab = function(tab) {
  const isLogin = tab === 'login';
  document.getElementById('formLogin').style.display    = isLogin ? '' : 'none';
  document.getElementById('formRegister').style.display = isLogin ? 'none' : '';
  document.getElementById('tabLogin').classList.toggle('active', isLogin);
  document.getElementById('tabRegister').classList.toggle('active', !isLogin);
  document.getElementById('loginError').textContent    = '';
  document.getElementById('registerError').textContent = '';
};

/* Mensagens de erro inline */
function setLoginError(msg)    { document.getElementById('loginError').textContent    = msg; }
function setRegisterError(msg) { document.getElementById('registerError').textContent = msg; }

/* Traduz códigos de erro do Firebase para português */
function authErrMsg(code) {
  const map = {
    'auth/invalid-email':          'E-mail inválido.',
    'auth/user-not-found':         'Usuário não encontrado.',
    'auth/wrong-password':         'Senha incorreta.',
    'auth/invalid-credential':     'E-mail ou senha incorretos.',
    'auth/email-already-in-use':   'Este e-mail já está cadastrado.',
    'auth/weak-password':          'Senha muito fraca. Use ao menos 6 caracteres.',
    'auth/too-many-requests':      'Muitas tentativas. Tente novamente em alguns minutos.',
    'auth/network-request-failed': 'Erro de conexão. Verifique sua internet.',
  };
  return map[code] || `Erro: ${code}`;
}

/* Seta o estado de loading no botão */
function setBtnLoading(id, loading, originalText) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.disabled = loading;
  btn.textContent = loading ? 'Aguarde…' : originalText;
}

/* Cria o documento do usuário no Firestore com role "pending" */
async function createUserProfile(user, displayName) {
  if (!db) return;
  try {
    const email = user.email.toLowerCase();
    const role  = (email === ADMIN_EMAIL.toLowerCase()) ? 'admin' : 'pending';
    await db.collection('gantt').doc('users').collection('items').doc(email).set({
      displayName: displayName || user.displayName || email.split('@')[0],
      email,
      role,
      allowedProjects: [],
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    console.log('Perfil criado:', email, '| role:', role);
  } catch(e) { console.error('Erro ao criar perfil:', e); }
}

/* Lê o documento do usuário no Firestore */
async function loadUserProfile(user) {
  if (!db || !user) return null;
  try {
    const email = user.email.toLowerCase();
    const snap  = await db.collection('gantt').doc('users').collection('items').doc(email).get();
    if (snap.exists) return snap.data();

    // Documento ainda não existe (primeiro login via link externo ou admin criou direto no Auth)
    // Cria automaticamente como 'pending'
    await createUserProfile(user, user.displayName || '');
    return { role: 'pending', allowedProjects: [], displayName: user.email.split('@')[0] };
  } catch(e) { console.error('Erro ao carregar perfil:', e); return null; }
}

/* Filtra a lista global de projetos pelas permissões do usuário */
function applyUserPermissions(profile) {
  if (!profile || profile.role === 'admin') return; // admin vê tudo
  if (profile.role === 'user' && Array.isArray(profile.allowedProjects)) {
    projects = projects.filter(p => profile.allowedProjects.includes(p.id));
    // Ajusta o projeto ativo se o que estava selecionado não for mais acessível
    if (activeProjectId && !projects.find(p => p.id === activeProjectId)) {
      activeProjectId = projects.length ? projects[0].id : null;
    }
  }
}

/* Atualiza o widget de avatar no header */
function updateUserWidget(user, profile) {
  const widget = document.getElementById('userWidget');
  if (!widget || !user) return;
  const name   = profile?.displayName || user.displayName || user.email.split('@')[0];
  const letter = name.charAt(0).toUpperCase();
  const btn    = document.getElementById('userAvatarBtn');
  if (btn) btn.textContent = letter;
  const nameEl  = document.getElementById('userDropdownName');
  const emailEl = document.getElementById('userDropdownEmail');
  if (nameEl)  nameEl.textContent  = name;
  if (emailEl) emailEl.textContent = user.email;
  widget.style.display = '';
}

/* Abre/fecha o dropdown do usuário */
window.toggleUserDropdown = function() {
  const dd = document.getElementById('userDropdown');
  if (dd) dd.classList.toggle('open');
};

// Fecha dropdown ao clicar fora
document.addEventListener('click', (e) => {
  const widget = document.getElementById('userWidget');
  const dd     = document.getElementById('userDropdown');
  if (dd && widget && !widget.contains(e.target)) dd.classList.remove('open');
});

/* Login com e-mail e senha */
window.doLogin = async function() {
  setLoginError('');
  const email    = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  if (!email || !password) { setLoginError('Preencha todos os campos.'); return; }
  setBtnLoading('loginBtn', true, 'Entrar');
  try {
    await firebase.auth().signInWithEmailAndPassword(email, password);
    // onAuthStateChanged cuida do resto
  } catch(e) {
    setLoginError(authErrMsg(e.code));
    setBtnLoading('loginBtn', false, 'Entrar');
  }
};

/* Cadastro de novo usuário */
window.doRegister = async function() {
  setRegisterError('');
  const name     = document.getElementById('registerName').value.trim();
  const email    = document.getElementById('registerEmail').value.trim();
  const password = document.getElementById('registerPassword').value;
  const confirm  = document.getElementById('registerConfirm').value;
  if (!name || !email || !password || !confirm) { setRegisterError('Preencha todos os campos.'); return; }
  if (password !== confirm) { setRegisterError('As senhas não coincidem.'); return; }
  if (password.length < 6)  { setRegisterError('A senha deve ter ao menos 6 caracteres.'); return; }
  setBtnLoading('registerBtn', true, 'Criar conta');
  try {
    const cred = await firebase.auth().createUserWithEmailAndPassword(email, password);
    await cred.user.updateProfile({ displayName: name });
    await createUserProfile(cred.user, name);
    // onAuthStateChanged cuida do resto
  } catch(e) {
    setRegisterError(authErrMsg(e.code));
    setBtnLoading('registerBtn', false, 'Criar conta');
  }
};

/* Logout */
window.doLogout = async function() {
  const dd = document.getElementById('userDropdown');
  if (dd) dd.classList.remove('open');
  await firebase.auth().signOut();
  // Limpa estado local
  projects = []; activeProjectId = null; progress = {};
  internalMilestones = []; allIssues = []; currentUser = null; userProfile = null;
  document.getElementById('userWidget').style.display = 'none';
  showLoginUI();
};

/* ─── CONFIG (compatibilidade) ───────────────────────────────────────────── */
const DEFAULT_CFG = {
  token:'', url:'https://gitlab.4mti.com.br', group:'94',
  milestone:'Cliente) Porto Seguro - EPC',
};
function loadCfg() {
  const proj = getActiveProject();
  if (proj) return { ...DEFAULT_CFG, ...proj };
  if (window.__API_CONFIG__?.token) return { ...DEFAULT_CFG, ...window.__API_CONFIG__ };
  try {
    const local = JSON.parse(localStorage.getItem(STORE_CFG) || '{}');
    if (local.token) return { ...DEFAULT_CFG, ...local };
  } catch(e) {}
  return { ...DEFAULT_CFG };
}

/* ─── PROGRESS STORE ─────────────────────────────────────────────────────── */
function progressKey() {
  return activeProjectId ? `${STORE_PROG}_${activeProjectId}` : STORE_PROG;
}
function loadProgress() {
  try { progress = JSON.parse(localStorage.getItem(progressKey()) || '{}'); } catch { progress = {}; }
}
function saveProgress() {
  localStorage.setItem(progressKey(), JSON.stringify(progress));
  updateSaveIndicator();
}
function updateSaveIndicator() {
  const n = Object.keys(progress).length;
  const el = document.getElementById('saveIndicator');
  if (el) el.innerHTML = n ? `<span class="save-dot"></span>${n} issue(s) com progresso salvo` : '';
}

/* ─── MILESTONES STORE ───────────────────────────────────────────────────── */
function milestonesKey() {
  return activeProjectId ? `gantt_milestones_v1_${activeProjectId}` : 'gantt_milestones_v1';
}
function saveMilestonesLocal() {
  localStorage.setItem(milestonesKey(), JSON.stringify(internalMilestones));
}
function loadMilestonesLocal() {
  try { internalMilestones = JSON.parse(localStorage.getItem(milestonesKey()) || '[]'); } catch { internalMilestones = []; }
}

/* ─── CLOUD STORE ─────────────────────────────────────────────────────────── */
async function loadCentralData() {
  if (db) {
    try {
      const doc = await db.collection('gantt').doc(projectDocId()).get();
      if (doc.exists) {
        const data = doc.data() || {};
        progress            = data.progress   || {};
        internalMilestones  = data.milestones || internalMilestones;
        if (data.issues) allIssues = data.issues;
        saveMilestonesLocal();
        saveProgress();
      }
      render();
    } catch(e) { console.error('Erro ao carregar do Firestore:', e); }
    return;
  }
  // Fallback JSONBin (sem isolamento por projeto — legado)
  try {
    const resp = await fetch(JSONBIN_API + '/latest', { headers:{ 'X-Master-Key': JSONBIN_KEY } });
    if (resp.ok) {
      const data  = await resp.json();
      const rec   = data.record || {};
      if (rec.progress !== undefined) {
        progress           = rec.progress   || {};
        internalMilestones = rec.milestones || internalMilestones;
        saveMilestonesLocal();
        saveProgress();
      } else { progress = rec; }
      render();
    }
  } catch(e) { console.error('Erro ao carregar JSONBin:', e); }
}

async function saveToCentralData() {
  if (db) {
    try {
      const payload = {
        progress,
        milestones: internalMilestones,
        projectId: activeProjectId,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      };
      if (allIssues.length > 0) {
        payload.issues         = allIssues;
        payload.issuesSyncedAt = new Date().toISOString();
      }
      await db.collection('gantt').doc(projectDocId()).set(payload, { merge: true });
    } catch(e) { console.error('Erro ao salvar no Firestore:', e); }
    return;
  }
  try {
    await fetch(JSONBIN_API, {
      method:'PUT',
      headers:{ 'Content-Type':'application/json', 'X-Master-Key': JSONBIN_KEY },
      body: JSON.stringify({ progress, milestones: internalMilestones }),
    });
  } catch(e) { console.error('Erro ao salvar JSONBin:', e); }
}

/* ─── PROJECT SWITCHING ──────────────────────────────────────────────────── */
async function switchProject(projectId) {
  if (projectId === activeProjectId) return;
  // Persiste estado atual antes de trocar
  saveProgress();
  saveMilestonesLocal();

  activeProjectId = projectId;
  saveProjectsLocal();

  // Carrega estado do novo projeto
  loadProgress();
  loadMilestonesLocal();
  allIssues = [];

  const proj = getActiveProject();
  if (proj) {
    initFirebase(proj.firebaseConfig || null);
    await loadCentralData();
    loadFromAPI();
  }

  updateProjectBadge();
  renderProjectSelector();
  switchView('macro');
}

function updateProjectBadge() {
  const proj = getActiveProject();
  const badge = document.getElementById('msBadge');
  if (badge) badge.textContent = proj ? proj.name : '—';
}

/* ─── VIEW SWITCHER ─────────────────────────────────────────────────────── */
let currentView = 'macro';
let drillMsId   = null;
let editingMsId = null;
let selectedIssueIids = new Set();

window.switchView = function(view) {
  currentView = view;
  drillMsId   = null;
  const macroWrap  = document.getElementById('macroWrap');
  const issuesWrap = document.getElementById('issuesWrap');
  const macroTb    = document.getElementById('macroToolbar');
  const issueTb    = document.getElementById('issueToolbar');
  const breadcrumb = document.getElementById('breadcrumb');
  const btnMs      = document.getElementById('btnMilestones');
  const fabMacro   = document.getElementById('fabMacro');
  const fabIssues  = document.getElementById('fabIssues');
  if (view === 'macro') {
    macroWrap.style.display=''; issuesWrap.style.display='none';
    macroTb.style.display='';  issueTb.style.display='none';
    breadcrumb.style.display='none'; btnMs.style.display='';
    fabMacro.classList.add('active'); fabIssues.classList.remove('active');
    renderMacro();
  } else if (view === 'issues') {
    macroWrap.style.display='none'; issuesWrap.style.display='';
    macroTb.style.display='none';  issueTb.style.display='';
    breadcrumb.style.display='none'; btnMs.style.display='';
    fabMacro.classList.remove('active'); fabIssues.classList.add('active');
    render();
  }
};

window.enterDrill = function(msId) {
  const ms = internalMilestones.find(m => m.id === msId);
  if (!ms) return;
  currentView = 'drill'; drillMsId = msId;
  document.getElementById('macroWrap').style.display='none';
  document.getElementById('issuesWrap').style.display='';
  document.getElementById('macroToolbar').style.display='none';
  document.getElementById('issueToolbar').style.display='';
  document.getElementById('breadcrumb').style.display='flex';
  document.getElementById('breadcrumbLabel').textContent = ms.name;
  document.getElementById('btnMilestones').style.display='none';
  document.getElementById('fabMacro').classList.remove('active');
  document.getElementById('fabIssues').classList.remove('active');
  render();
};

window.exitDrill = function() { switchView('macro'); };

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
  const labels = (issue.labels || []).map(l => l.toLowerCase());
  if (labels.includes('done')) return 'Concluída';
  if (labels.some(l => ['pausada','paused','bloqueada','blocked'].includes(l))) return 'Pausada';
  if (labels.some(l => ['aguardando','waiting','pendente'].includes(l))) return 'Aguardando';
  return 'Andamento';
}
function inferProgress(issue) {
  const desc   = issue.description || '';
  const labels = (issue.labels || []).map(l => l.toLowerCase());
  if (labels.includes('done')) return 100;
  const done  = (desc.match(/-\s*\[x\]/gi) || []).length;
  const total = (desc.match(/-\s*\[[ x]\]/gi) || []).length;
  if (total > 0) return Math.round(done / total * 100);
  const m = desc.match(/(?:progress|progresso)\s*:\s*(\d{1,3})/i);
  if (m) return Math.min(100, parseInt(m[1]));
  return issue.state === 'closed' ? 100 : 0;
}
function mapIssue(raw) {
  const ms    = raw.milestone || {};
  const start = ms.start_date || raw.created_at?.slice(0, 10);
  const end   = raw.due_date  || ms.due_date || null;
  return {
    iid: raw.iid, id: raw.id, title: raw.title || '', url: raw.web_url || '',
    state: raw.state || '', labels: raw.labels || [], start, end,
    apiProgress: inferProgress(raw), apiStatus: inferStatus(raw),
  };
}

async function loadFromAPI() {
  const cfg = loadCfg();
  if (!cfg.token || !cfg.url || !cfg.group) {
    setApiStatus('⚠ Token ou IDs ausentes', 'warn'); return;
  }
  setApiStatus('⏳ Carregando...', 'loading');
  try {
    const stateFilter   = document.getElementById('filterState').value || 'opened';
    const params        = new URLSearchParams({ state: stateFilter, per_page: '100' });
    if (cfg.milestone)  params.append('milestone', cfg.milestone);
    const ignoredLabels = ['Ready', 'Specification'];
    if (ignoredLabels.length) params.append('not[labels]', ignoredLabels.join(','));

    const raw = await fetchAllPages(
      `${cfg.url}/api/v4/groups/${cfg.group}/issues?${params.toString()}`, cfg.token
    );
    allIssues = raw.map(mapIssue).filter(i => !i.labels.some(l => ignoredLabels.includes(l)));
    allIssues.sort((a,b) =>
      (a.end||'9999-12-31').localeCompare(b.end||'9999-12-31') ||
      (a.start||'9999-12-31').localeCompare(b.start||'9999-12-31')
    );

    document.getElementById('msBadge').textContent =
      (getActiveProject()?.name || cfg.milestone || 'Todas');
    document.getElementById('btnReload').style.display = 'inline-block';
    setApiStatus(`✅ ${allIssues.length} issues`, 'ok');
    setDefaultFilters();

    let needsSync = false;
    allIssues.forEach(issue => {
      if (issue.apiStatus === 'Concluída') {
        if (!progress[issue.iid] ||
            progress[issue.iid].status !== 'Concluída' ||
            progress[issue.iid].pct    !== 100) {
          progress[issue.iid] = {
            ...progress[issue.iid],
            pct: 100, status: 'Concluída',
            projectId: activeProjectId,
            updatedAt: new Date().toISOString(),
          };
          needsSync = true;
        }
      } else {
        if (!progress[issue.iid]) {
          progress[issue.iid] = {
            pct: issue.apiProgress, status: issue.apiStatus,
            projectId: activeProjectId,
            updatedAt: new Date().toISOString(),
          };
          needsSync = true;
        } else if (!progress[issue.iid].status) {
          progress[issue.iid].status    = issue.apiStatus;
          progress[issue.iid].projectId = activeProjectId;
          needsSync = true;
        }
      }
    });
    if (needsSync) saveProgress();
    await saveToCentralData();

    if (document.getElementById('msFormModal').style.display !== 'none') populateIssuePicker();
    render();
    if (currentView === 'macro') renderMacro();
  } catch(e) {
    console.error('Erro ao carregar do GitLab, tentando cache...', e);
    if (db) {
      try {
        const doc = await db.collection('gantt').doc(projectDocId()).get();
        if (doc.exists) {
          const data = doc.data() || {};
          if (data.issues?.length > 0) {
            allIssues = data.issues;
            const syncDate = data.issuesSyncedAt ? fmtBR(data.issuesSyncedAt.slice(0,10)) : 'desconhecida';
            setApiStatus(`☁ Cache: ${allIssues.length} issues (Sinc: ${syncDate})`, 'ok');
            document.getElementById('btnReload').style.display = 'inline-block';
            setDefaultFilters();
            if (document.getElementById('msFormModal').style.display !== 'none') populateIssuePicker();
            render();
            if (currentView === 'macro') renderMacro();
            return;
          }
        }
      } catch(dbErr) { console.error('Falha ao recuperar cache:', dbErr); }
    }
    setApiStatus(`❌ Erro: ${e.message}`, 'err');
  }
}

/* ─── FILTERS ─────────────────────────────────────────────────────────────── */
function setDefaultFilters() {
  const now = new Date(TODAY), day = now.getDay();
  const s   = new Date(now); s.setDate(now.getDate() - day);
  const e   = new Date(now); e.setDate(now.getDate() + (6 - day));
  document.getElementById('filterFrom').value = fmt(s);
  document.getElementById('filterTo').value   = fmt(e);
}
function resetFilters() {
  document.getElementById('filterSearch').value = '';
  document.getElementById('filterStatus').value = '';
  setDefaultFilters(); render();
}
function applyFilters() {
  let issues = [...allIssues];
  if (currentView === 'drill' && drillMsId !== null) {
    const ms   = internalMilestones.find(m => m.id === drillMsId);
    const iids = new Set((ms?.issueIids || []).map(Number));
    issues = issues.filter(i => iids.has(Number(i.iid)));
  }
  const from   = document.getElementById('filterFrom').value;
  const to     = document.getElementById('filterTo').value;
  const status = document.getElementById('filterStatus').value;
  const search = document.getElementById('filterSearch').value.toLowerCase();
  return issues.filter(i => {
    if (status && effectiveStatus(i) !== status) return false;
    if (search && !String(i.iid).includes(search) && !i.title.toLowerCase().includes(search)) return false;
    if (from && i.end   && i.end   < from) return false;
    if (to   && i.start && i.start > to)   return false;
    return true;
  }).sort((a,b) =>
    (a.end||'9999-12-31').localeCompare(b.end||'9999-12-31') ||
    (a.start||'9999-12-31').localeCompare(b.start||'9999-12-31') ||
    (a.iid - b.iid)
  );
}

function setDefaultMacroFilters() {
  if (!internalMilestones.length) return;
  const dates = internalMilestones.flatMap(m => [m.start, m.end].filter(Boolean));
  if (!dates.length) return;
  document.getElementById('macroFrom').value = dates.reduce((a,b) => a < b ? a : b);
  document.getElementById('macroTo').value   = dates.reduce((a,b) => a > b ? a : b);
}
window.resetMacroFilters = function() {
  document.getElementById('macroSearch').value = '';
  setDefaultMacroFilters(); renderMacro();
};
window.changeMacroWeek = function(days) {
  const f = document.getElementById('macroFrom');
  const t = document.getElementById('macroTo');
  let d0 = parseD(f.value), d1 = parseD(t.value);
  d0.setDate(d0.getDate()+days); d1.setDate(d1.getDate()+days);
  f.value = fmt(d0); t.value = fmt(d1); renderMacro();
};
function applyMacroFilters() {
  const search = document.getElementById('macroSearch').value.toLowerCase();
  return [...internalMilestones]
    .filter(m => !search || m.name.toLowerCase().includes(search))
    .sort((a,b) =>
      (b.start||'').localeCompare(a.start||'') ||
      (b.end||'').localeCompare(a.end||'') ||
      (a.name||'').localeCompare(b.name||'')
    );
}
window.changeWeek = function(days) {
  const fFrom = document.getElementById('filterFrom');
  const fTo   = document.getElementById('filterTo');
  let d0 = parseD(fFrom.value), d1 = parseD(fTo.value);
  d0.setDate(d0.getDate()+days); d1.setDate(d1.getDate()+days);
  fFrom.value = fmt(d0); fTo.value = fmt(d1); render();
};

/* ─── HELPERS ─────────────────────────────────────────────────────────────── */
function getWeekNumber(d) {
  d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - y) / 86400000) + 1) / 7);
}
function fmt(d) { return d.toISOString().slice(0,10); }
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
function effectivePct(issue) {
  const pct    = progress[issue.iid]?.pct    ?? issue.apiProgress;
  const status = progress[issue.iid]?.status ?? issue.apiStatus;
  if (status === 'Concluída') return 100;
  return pct;
}
function effectiveStatus(issue) {
  const pct = effectivePct(issue);
  if (pct === 100) return 'Concluída';
  const status = progress[issue.iid]?.status ?? issue.apiStatus;
  if (status === 'Concluída' && pct < 100) return 'Andamento';
  return status;
}
function rowOf(iid) { return document.querySelector(`tr[data-iid="${iid}"]`); }
function updateProgUI_Minimal(row, pct, status) {
  if (!row) return;
  const fill  = row.querySelector('.prog-fill');
  const label = row.querySelector('.prog-label');
  const color = STATUS_COLORS[status||'Andamento']||'var(--blue)';
  if (fill)  { fill.style.width = pct+'%'; fill.style.background = color; }
  if (label) label.textContent = pct+'%';
  const select = row.querySelector('select.sbadge');
  if (select) { select.value = status; select.className = 'sbadge '+(STATUS_CLASS[status]||'sb-w'); }
}

/* ─── RENDER (ISSUES) ────────────────────────────────────────────────────── */
function render() {
  if (currentView === 'macro') { renderMacro(); return; }
  const issues  = applyFilters();
  const countEl = document.getElementById('filterCount');
  if (countEl) countEl.textContent = issues.length < allIssues.length
    ? `${issues.length} / ${allIssues.length}` : `${issues.length} issues`;

  const msBadge = document.getElementById('msBadge');
  if (currentView === 'drill' && drillMsId) {
    const ms = internalMilestones.find(m => m.id === drillMsId);
    msBadge.textContent = ms ? ms.name : '—';
  } else {
    const proj = getActiveProject();
    msBadge.textContent = proj ? proj.name : `${loadCfg().milestone||'Geral'} | Semana ${getWeekNumber(TODAY)}`;
  }
  renderSummary(issues);
  buildTimeline('filterFrom','filterTo','tlHeader');
  renderRows(issues);
}

function renderSummary(issues) {
  const counts = {}; let totalPct = 0;
  issues.forEach(i => {
    const s = effectiveStatus(i);
    counts[s] = (counts[s]||0)+1; totalPct += effectivePct(i);
  });
  const avg = issues.length ? Math.round(totalPct/issues.length) : 0;
  const order = ['Andamento','Concluída','Pausada','Aguardando'];
  let html = order.map(s => counts[s]
    ? `<div class="sum-card ${SUM_CLASS[s]}"><span class="val">${counts[s]}</span> ${s}</div>` : '').join('');
  html += `<div class="sum-card s-avg"><span class="val">${avg}%</span> médio</div>`;
  document.getElementById('summary').innerHTML = html;
}
function renderSummaryMacro(mss) {
  const counts = {}; let totalPct = 0;
  mss.forEach(m => {
    const {autoProgress, manualOverride, status} = getMsProgress(m);
    counts[status] = (counts[status]||0)+1;
    totalPct += manualOverride !== null ? manualOverride : autoProgress;
  });
  const avg = mss.length ? Math.round(totalPct/mss.length) : 0;
  const order = ['Andamento','Concluída','Não iniciada','Pausada'];
  let html = order.map(s => counts[s]
    ? `<div class="sum-card ${SUM_CLASS[s]}"><span class="val">${counts[s]}</span> ${s}</div>` : '').join('');
  html += `<div class="sum-card s-avg"><span class="val">${avg}%</span> médio</div>`;
  document.getElementById('summary').innerHTML = html;
}

function buildTimeline(fromId, toId, headerId) {
  const from = document.getElementById(fromId)?.value;
  const to   = document.getElementById(toId)?.value;
  if (!from || !to) { if (fromId==='filterFrom') timeline=null; else macroTimeline=null; return; }
  const t0   = parseD(from), t1 = parseD(to);
  const span = Math.max(1, Math.round((t1-t0)/86400000));
  const tl   = {t0, t1, span};
  if (fromId==='filterFrom') timeline=tl; else macroTimeline=tl;

  const hdr = document.getElementById(headerId);
  if (!hdr) return;
  hdr.innerHTML = '';
  let dayStep = 1;
  if (span>365) dayStep=90; else if (span>180) dayStep=30; else if (span>90) dayStep=14;
  else if (span>45) dayStep=7; else if (span>20) dayStep=5; else if (span>10) dayStep=2;
  for (let i=0; i<=span; i+=dayStep) {
    const cur = new Date(t0); cur.setDate(t0.getDate()+i);
    const pct = (i/span)*100;
    const tick = document.createElement('div');
    tick.className = 'tl-tick'; tick.style.left = pct+'%';
    if (i+dayStep > span) { tick.style.transform='translateX(-100%)'; tick.style.borderLeft='none'; tick.style.textAlign='right'; }
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
  if (status==='Aguardando'||status==='Não iniciada') return 'var(--gray)';
  if (status==='Pausada')  return 'var(--amber)';
  if (status==='Concluída') return 'var(--green)';
  const gap = timePct - progressPct;
  if (gap>35) return 'var(--red)';
  if (gap>15) return 'var(--orange)';
  return 'var(--blue)';
}
function pctPosInTl(dateStr, tl) {
  if (!tl||!dateStr) return null;
  const d = parseD(dateStr);
  return Math.max(0, Math.min(100, (d-tl.t0)/(tl.t1-tl.t0)*100));
}
function buildBarHTML(start, end, status, pct, tl, isOverdue) {
  const L = pctPosInTl(start, tl), R = pctPosInTl(end, tl);
  if (L===null||R===null||R<=L) {
    if (start) {
      const l = pctPosInTl(start, tl);
      if (l!==null) {
        const color = STATUS_COLORS[status]||'var(--gray)';
        return `<div class="bar-ghost" style="left:${l}%;width:2%;min-width:4px;background:${color}"></div>`;
      }
    }
    return '';
  }
  const w = R-L;
  let fillFactor=0, isCritical=false;
  if (isOverdue) { fillFactor=1; isCritical=true; }
  else if (status==='Concluída') { fillFactor=1; }
  else {
    const t0=parseD(start), t1=parseD(end);
    fillFactor = Math.max(0, Math.min(1, (TODAY-t0)/(t1-t0)));
  }
  const timePct   = Math.round(fillFactor*100);
  const barColor  = isCritical ? 'var(--red)' : timeBarColor(status, timePct, pct);
  const critCls   = isCritical ? 'bar-overdue' : '';
  const doneW     = w*fillFactor;
  return `
    <div class="bar-ghost" style="left:${L}%;width:${w}%;background:${barColor}"></div>
    <div class="bar-done ${critCls}" style="left:${L}%;width:${doneW}%;background:${barColor}"></div>
    ${timePct>0 ? `<div class="bar-lbl" style="left:${L+doneW-1}%">${timePct}%</div>` : ''}
  `;
}

function renderRows(issues) {
  const body = document.getElementById('ganttBody');
  if (!issues.length) {
    body.innerHTML='<tr><td colspan="7" class="no-data">Nenhuma issue nos filtros aplicados.</td></tr>'; return;
  }
  const todayStr = fmt(TODAY);
  body.innerHTML = issues.map(issue => {
    const status    = effectiveStatus(issue);
    const pct       = effectivePct(issue);
    const color     = STATUS_COLORS[status]||'var(--gray)';
    const sClass    = STATUS_CLASS[status]||'sb-w';
    const isOverdue = issue.end && issue.end < todayStr && status !== 'Concluída';
    const barHTML   = buildBarHTML(issue.start, issue.end, status, pct, timeline, isOverdue);
    // Show which internal milestone this issue belongs to
    const linkedMs  = internalMilestones.find(m => (m.issueIids||[]).map(Number).includes(Number(issue.iid)));
    const msBadgeHtml = linkedMs
      ? `<span class="issue-ms-tag" style="background:${linkedMs.color||'var(--blue)'}20;color:${linkedMs.color||'var(--blue)'};">${esc(linkedMs.name)}</span>`
      : '';
    return `<tr data-iid="${issue.iid}">
      <td><span class="iid">#${issue.iid}</span></td>
      <td>
        ${issue.url
          ? `<a class="issue-link" href="${esc(issue.url)}" target="_blank">${esc(issue.title)}</a>`
          : `<span>${esc(issue.title)}</span>`}
        ${msBadgeHtml}
      </td>
      <td class="date-cell">${fmtBR(issue.start)}</td>
      <td class="date-cell ${isOverdue?'overdue':''}">${fmtBR(issue.end)}</td>
      <td>
        <select class="sbadge ${sClass}" onchange="changeStatus(${issue.iid},this.value,this)">
          ${['Andamento','Pausada','Concluída','Aguardando'].map(s =>
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
  const mss     = applyMacroFilters();
  const countEl = document.getElementById('macroCount');
  if (countEl) countEl.textContent = `${mss.length} milestones`;
  renderSummaryMacro(mss);
  const body = document.getElementById('macroBody');
  if (!mss.length) {
    body.innerHTML='<tr><td colspan="7" class="no-data">Nenhuma milestone cadastrada. Clique em ⊞ Milestones.</td></tr>'; return;
  }
  const todayStr = fmt(TODAY);
  body.innerHTML = mss.map(ms => {
    const {autoProgress, manualOverride, status} = getMsProgress(ms);
    const displayPct = manualOverride !== null ? manualOverride : autoProgress;
    const color   = ms.color||'var(--blue)';
    const sClass  = STATUS_CLASS[status]||'sb-w';
    const isOverdue = ms.end && ms.end < todayStr && status !== 'Concluída';
    const barHTML = buildBarHTML(ms.start, ms.end, status, displayPct, macroTimeline, isOverdue);
    return `<tr data-ms-id="${ms.id}" class="ms-row" onclick="enterDrill('${ms.id}')">
      <td style="width:32px"><span class="ms-color-dot" style="background:${color}"></span></td>
      <td>
        <span class="ms-name">${esc(ms.name)}</span>
        <span class="ms-issue-count">${ms.issueIids?.length||0} issues</span>
      </td>
      <td class="date-cell">${fmtBR(ms.start)}</td>
      <td class="date-cell ${isOverdue?'overdue':''}">${fmtBR(ms.end)}</td>
      <td onclick="event.stopPropagation()">
        <select class="sbadge ${sClass}" onchange="changeMsStatus('${ms.id}',this.value,this)">
          ${['Não iniciada','Andamento','Pausada','Concluída'].map(s =>
            `<option value="${s}" ${s===status?'selected':''}>${s}</option>`).join('')}
        </select>
      </td>
      <td class="progress-col" onclick="event.stopPropagation()">
        <div class="prog-track macro-prog-track" data-ms-id="${ms.id}"
             onmousedown="startMsDrag(event,'${ms.id}')"
             ontouchstart="startMsDragTouch(event,'${ms.id}')">
          <div class="prog-fill" style="width:${displayPct}%;background:${color}"></div>
          <div class="prog-label">${displayPct}%</div>
        </div>
        ${manualOverride !== null && manualOverride !== autoProgress ? `<div class="auto-prog-hint">auto: ${autoProgress}%</div>` : ''}
      </td>
      <td class="bar-cell-td"><div class="bar-outer">${barHTML}</div></td>
    </tr>`;
  }).join('');
}

/*
  Progresso da milestone:
  - autoProgress: média calculada a partir do progresso das issues vinculadas
    (sempre recalculada, reflete o estado atual das issues).
  - manualOverride: só existe se alguém arrastou manualmente a barra desta
    milestone E essa milestone NÃO TEM issues vinculadas (nesse caso não há
    progresso automático possível, então o valor manual é necessário).
    Se a milestone tem issues vinculadas, o progresso automático sempre
    prevalece e qualquer override manual antigo é ignorado.
  - status: vem do cadastro da milestone (editável agora também na grade).
*/
function getMsProgress(ms) {
  let autoProgress = 0;
  const hasLinkedIssues = !!(ms.issueIids?.length && allIssues.length);
  if (hasLinkedIssues) {
    const linked = allIssues.filter(i => ms.issueIids.map(Number).includes(Number(i.iid)));
    if (linked.length)
      autoProgress = Math.round(linked.reduce((s,i) => s+effectivePct(i), 0) / linked.length);
  }
  const savedManual   = progress[`ms_${ms.id}`]?.pct ?? null;
  const manualOverride = hasLinkedIssues ? null : savedManual;
  const status = ms.status || 'Não iniciada';
  return {autoProgress, manualOverride, status};
}

/* ─── DRAG PROGRESS ──────────────────────────────────────────────────────── */
window.changeStatus = function(iid, val, sel) {
  if (!progress[iid]) progress[iid] = {pct:0};
  progress[iid].status    = val;
  progress[iid].projectId = activeProjectId;
  progress[iid].updatedAt = new Date().toISOString();
  if (val==='Concluída') { progress[iid].pct=100; }
  else if (progress[iid].pct===100) { progress[iid].pct=90; }
  // Atualiza flag de milestone interna
  const linkedMs = internalMilestones.find(m => (m.issueIids||[]).map(Number).includes(Number(iid)));
  if (linkedMs) progress[iid].internalMilestoneId = linkedMs.id;
  saveProgress(); saveToCentralData(); render();
};

/* Altera o status de uma milestone interna diretamente na grade (sem abrir o modal) */
window.changeMsStatus = function(msId, val, sel) {
  const idx = internalMilestones.findIndex(m => m.id === msId);
  if (idx === -1) return;
  internalMilestones[idx] = { ...internalMilestones[idx], status: val };
  if (val === 'Concluída') {
    // Status concluído manualmente também fixa o progresso em 100%,
    // igual ao comportamento já existente para issues individuais.
    if (!progress[`ms_${msId}`]) progress[`ms_${msId}`] = {};
    progress[`ms_${msId}`].pct       = 100;
    progress[`ms_${msId}`].projectId = activeProjectId;
    progress[`ms_${msId}`].updatedAt = new Date().toISOString();
  }
  saveMilestonesLocal(); saveProgress(); saveToCentralData(); renderMacro();
};

function makeDrag(iid, getX, el) {
  const track = el;
  return function onMove(x) {
    const rect = track.getBoundingClientRect();
    const p    = Math.round(Math.min(100, Math.max(0, (x-rect.left)/rect.width*100)));
    if (!progress[iid]) progress[iid] = {};
    progress[iid].pct       = p;
    progress[iid].projectId = activeProjectId;
    let status = progress[iid].status || 'Andamento';
    if (p===100) status='Concluída';
    else if (p<100 && status==='Concluída') status='Andamento';
    progress[iid].status = status;
    // flag milestone interna
    const linkedMs = internalMilestones.find(m => (m.issueIids||[]).map(Number).includes(Number(iid)));
    if (linkedMs) progress[iid].internalMilestoneId = linkedMs.id;
    updateProgUI_Minimal(rowOf(iid), p, status);
  };
}

window.startDrag = function(e, iid) {
  e.preventDefault();
  const onMove = makeDrag(iid, ev => ev.clientX, e.currentTarget);
  const onUp = () => {
    if (progress[iid]) progress[iid].updatedAt = new Date().toISOString();
    saveProgress(); saveToCentralData(); render();
    document.removeEventListener('mousemove', mv);
    document.removeEventListener('mouseup', onUp);
  };
  const mv = ev => onMove(ev.clientX);
  onMove(e.clientX);
  document.addEventListener('mousemove', mv);
  document.addEventListener('mouseup', onUp);
};
window.startDragTouch = function(e, iid) {
  const track = e.currentTarget;
  const onMove = ev => {
    const t = ev.touches[0];
    const rect = track.getBoundingClientRect();
    const p = Math.round(Math.min(100,Math.max(0,(t.clientX-rect.left)/rect.width*100)));
    if (!progress[iid]) progress[iid]={};
    progress[iid].pct=p; progress[iid].projectId=activeProjectId;
    let status=progress[iid].status||'Andamento';
    if (p===100) status='Concluída'; else if (p<100&&status==='Concluída') status='Andamento';
    progress[iid].status=status;
    const linkedMs=internalMilestones.find(m=>(m.issueIids||[]).map(Number).includes(Number(iid)));
    if (linkedMs) progress[iid].internalMilestoneId=linkedMs.id;
    updateProgUI_Minimal(rowOf(iid),p,status);
  };
  const onEnd=()=>{
    if(progress[iid]) progress[iid].updatedAt=new Date().toISOString();
    saveProgress(); saveToCentralData(); render();
    document.removeEventListener('touchmove',onMove);
    document.removeEventListener('touchend',onEnd);
  };
  document.addEventListener('touchmove',onMove,{passive:false});
  document.addEventListener('touchend',onEnd);
};

window.startMsDrag = function(e, msId) {
  e.preventDefault();
  const ms = internalMilestones.find(m=>m.id===msId);
  if (ms?.issueIids?.length) {
    // Progresso é automático (vem das issues) — arrasto manual desabilitado.
    flashAutoProgressHint(msId);
    return;
  }
  const track = e.currentTarget;
  const onMove = ev => {
    const rect = track.getBoundingClientRect();
    const p = Math.round(Math.min(100,Math.max(0,(ev.clientX-rect.left)/rect.width*100)));
    if (!progress[`ms_${msId}`]) progress[`ms_${msId}`]={};
    progress[`ms_${msId}`].pct=p; progress[`ms_${msId}`].projectId=activeProjectId;
    const fill=track.querySelector('.prog-fill'), label=track.querySelector('.prog-label');
    const color=ms?.color||'var(--blue)';
    if(fill){fill.style.width=p+'%';fill.style.background=color;}
    if(label) label.textContent=p+'%';
  };
  const onUp=()=>{ saveProgress(); saveToCentralData(); renderMacro();
    document.removeEventListener('mousemove',onMove); document.removeEventListener('mouseup',onUp); };
  onMove(e);
  document.addEventListener('mousemove',onMove); document.addEventListener('mouseup',onUp);
};
window.startMsDragTouch = function(e, msId) {
  const ms = internalMilestones.find(m=>m.id===msId);
  if (ms?.issueIids?.length) {
    flashAutoProgressHint(msId);
    return;
  }
  const track=e.currentTarget;
  const onMove=ev=>{
    const t=ev.touches[0], rect=track.getBoundingClientRect();
    const p=Math.round(Math.min(100,Math.max(0,(t.clientX-rect.left)/rect.width*100)));
    if(!progress[`ms_${msId}`]) progress[`ms_${msId}`]={};
    progress[`ms_${msId}`].pct=p; progress[`ms_${msId}`].projectId=activeProjectId;
    const fill=track.querySelector('.prog-fill'), label=track.querySelector('.prog-label');
    if(fill) fill.style.width=p+'%'; if(label) label.textContent=p+'%';
  };
  const onEnd=()=>{ saveProgress(); saveToCentralData(); renderMacro();
    document.removeEventListener('touchmove',onMove); document.removeEventListener('touchend',onEnd); };
  document.addEventListener('touchmove',onMove,{passive:false});
  document.addEventListener('touchend',onEnd);
};

/* Pequeno feedback visual quando o usuário tenta arrastar uma barra de
   progresso que é controlada automaticamente pelas issues vinculadas. */
function flashAutoProgressHint(msId) {
  const track = document.querySelector(`.macro-prog-track[data-ms-id="${msId}"]`);
  if (!track) return;
  track.classList.add('prog-locked-flash');
  setTimeout(() => track.classList.remove('prog-locked-flash'), 400);
}

/* ─── MODAL: MILESTONES ──────────────────────────────────────────────────── */
window.openMsModal = function() {
  editingMsId=null; renderMsList();
  document.getElementById('msModal').style.display='';
  document.getElementById('msModalBackdrop').style.display='';
};
window.openMsFormModal = function(id) {
  if (id) {
    const ms=internalMilestones.find(m=>m.id===id); if(!ms) return;
    editingMsId=id;
    document.getElementById('msName').value   = ms.name;
    document.getElementById('msStart').value  = ms.start||'';
    document.getElementById('msEnd').value    = ms.end||'';
    document.getElementById('msColor').value  = ms.color||'#2e6fcc';
    document.getElementById('msStatus').value = ms.status||'Não iniciada';
    selectedIssueIids = new Set((ms.issueIids||[]).map(Number));
    document.getElementById('msFormTitle').textContent='Editar Milestone';
  } else {
    editingMsId=null; clearMsForm();
    document.getElementById('msFormTitle').textContent='Nova Milestone';
  }
  populateIssuePicker(); updatePickerCount();
  document.getElementById('msFormModal').style.display='';
  document.getElementById('msFormModalBackdrop').style.display='';
};
window.closeMsModal = function() {
  document.getElementById('msModal').style.display='none';
  document.getElementById('msModalBackdrop').style.display='none';
  closeMsFormModal(); editingMsId=null;
};
window.closeMsFormModal = function() {
  document.getElementById('msFormModal').style.display='none';
  document.getElementById('msFormModalBackdrop').style.display='none';
  editingMsId=null;
};
function clearMsForm() {
  document.getElementById('msName').value=''; document.getElementById('msStart').value='';
  document.getElementById('msEnd').value=''; document.getElementById('msColor').value='#2e6fcc';
  document.getElementById('msStatus').value='Não iniciada';
  selectedIssueIids=new Set(); updatePickerCount(); populateIssuePicker();
}
function renderMsList() {
  const list=document.getElementById('msList'), empty=document.getElementById('msListEmpty');
  if (!internalMilestones.length) { empty.style.display=''; list.querySelectorAll('.ms-list-item').forEach(el=>el.remove()); return; }
  empty.style.display='none'; list.querySelectorAll('.ms-list-item').forEach(el=>el.remove());
  const sorted=[...internalMilestones].sort((a,b)=>
    (b.start||'').localeCompare(a.start||'')|| (b.end||'').localeCompare(a.end||'')|| (a.name||'').localeCompare(b.name||''));
  sorted.forEach(ms=>{
    const div=document.createElement('div'); div.className='ms-list-item';
    div.innerHTML=`
      <span class="ms-list-dot" style="background:${ms.color||'#2e6fcc'}"></span>
      <div class="ms-list-info">
        <span class="ms-list-name">${esc(ms.name)}</span>
        <span class="ms-list-meta">${fmtBR(ms.start)} → ${fmtBR(ms.end)} · ${ms.issueIids?.length||0} issues · <b>${ms.status}</b></span>
      </div>
      <div class="ms-list-actions">
        <button class="btn" onclick="editMilestone('${ms.id}')">✎ Editar</button>
        <button class="btn btn-danger" onclick="deleteMilestone('${ms.id}')">✕</button>
      </div>`;
    list.appendChild(div);
  });
}
window.editMilestone   = id => openMsFormModal(id);
window.deleteMilestone = function(id) {
  if (!confirm('Remover esta milestone?')) return;
  internalMilestones=internalMilestones.filter(m=>m.id!==id);
  saveMilestonesLocal(); saveToCentralData(); renderMsList();
  if (currentView==='macro') renderMacro();
};
window.saveMilestone = function() {
  const name   = document.getElementById('msName').value.trim();
  const start  = document.getElementById('msStart').value;
  const end    = document.getElementById('msEnd').value;
  const color  = document.getElementById('msColor').value;
  const status = document.getElementById('msStatus').value;
  if (!name)      { alert('Informe o nome da milestone.'); return; }
  if (!start)     { alert('Informe a data de início.'); return; }
  if (!end)       { alert('Informe a data de fim.'); return; }
  if (end<start)  { alert('A data de fim não pode ser anterior ao início.'); return; }
  const issueIids = [...selectedIssueIids];
  if (editingMsId) {
    const idx = internalMilestones.findIndex(m=>m.id===editingMsId);
    if (idx!==-1) internalMilestones[idx]={...internalMilestones[idx],name,start,end,color,status,issueIids};
  } else {
    const id='ms_'+Date.now();
    internalMilestones.push({id,name,start,end,color,status,issueIids,projectId:activeProjectId});
  }
  // Atualiza flag projectId + internalMilestoneId nas issues vinculadas
  issueIids.forEach(iid => {
    if (!progress[iid]) progress[iid]={pct:0,status:'Andamento'};
    progress[iid].projectId          = activeProjectId;
    progress[iid].internalMilestoneId= editingMsId || internalMilestones[internalMilestones.length-1]?.id;
    if (!progress[iid].updatedAt) progress[iid].updatedAt=new Date().toISOString();
  });
  saveMilestonesLocal(); saveProgress(); saveToCentralData();
  closeMsFormModal(); clearMsForm(); renderMsList();
  setDefaultMacroFilters();
  if (currentView==='macro') renderMacro();
};

/* ─── ISSUE PICKER ───────────────────────────────────────────────────────── */
function populateIssuePicker() {
  const picker=document.getElementById('issuePicker'); picker.innerHTML='';
  if (!allIssues.length) {
    picker.innerHTML='<p class="picker-empty">Carregue as issues da API primeiro (botão ▶ Carregar).</p>'; return;
  }
  const search=(document.getElementById('issuePickerSearch')?.value||'').toLowerCase();
  const shown=allIssues.filter(i=>!search||String(i.iid).includes(search)||i.title.toLowerCase().includes(search));
  shown.forEach(issue=>{
    const checked=selectedIssueIids.has(Number(issue.iid));
    const row=document.createElement('label'); row.className='picker-row'+(checked?' checked':'');
    row.innerHTML=`
      <input type="checkbox" value="${issue.iid}" ${checked?'checked':''} onchange="toggleIssue(${issue.iid},this)">
      <span class="picker-iid">#${issue.iid}</span>
      <span class="picker-title">${esc(issue.title)}</span>
      <span class="picker-dates">${fmtBR(issue.start)} → ${fmtBR(issue.end)}</span>`;
    picker.appendChild(row);
  });
  if (!shown.length) picker.innerHTML='<p class="picker-empty">Nenhuma issue encontrada.</p>';
}
window.toggleIssue=function(iid,checkbox){
  if (checkbox.checked) selectedIssueIids.add(Number(iid)); else selectedIssueIids.delete(Number(iid));
  const row=checkbox.closest('.picker-row'); if(row) row.classList.toggle('checked',checkbox.checked);
  updatePickerCount();
};
function updatePickerCount() {
  const el=document.getElementById('issuePickerCount'); if(el) el.textContent=`${selectedIssueIids.size} selecionadas`;
}
window.filterIssuePicker=function(){ populateIssuePicker(); };

/* ─── PROJECT SELECTOR (UI) ──────────────────────────────────────────────── */
function renderProjectSelector() {
  const container = document.getElementById('projectSelectorWrap');
  if (!container) return;

  if (!projects.length) {
    container.innerHTML = `<span class="proj-selector-empty">Nenhum projeto cadastrado</span>`;
    return;
  }
  container.innerHTML = projects.map(p => `
    <button class="proj-tab ${p.id===activeProjectId?'active':''}"
            onclick="switchProject('${p.id}')" title="${esc(p.milestone||'')}">
      ${esc(p.name)}
    </button>`).join('');
}

/* ─── CONFIG MODAL ────────────────────────────────────────────────────────── */
window.openCfgModal = function() {
  // Preenche com projeto ativo ou config global
  const cfg = loadCfg();
  document.getElementById('cfgToken').value     = cfg.token||'';
  document.getElementById('cfgUrl').value       = cfg.url||DEFAULT_CFG.url;
  document.getElementById('cfgGroup').value     = cfg.group||DEFAULT_CFG.group;
  document.getElementById('cfgMilestone').value = cfg.milestone||DEFAULT_CFG.milestone;
  // Lista de projetos no modal
  renderProjectList();
  document.getElementById('cfgModal').style.display='';
  document.getElementById('cfgModalBackdrop').style.display='';
};
window.closeCfgModal = function() {
  document.getElementById('cfgModal').style.display='none';
  document.getElementById('cfgModalBackdrop').style.display='none';
};

function renderProjectList() {
  const list = document.getElementById('cfgProjectList');
  if (!list) return;
  if (!projects.length) {
    list.innerHTML='<p class="modal-cfg-hint">Nenhum projeto cadastrado ainda.</p>'; return;
  }
  list.innerHTML = projects.map(p => `
    <div class="cfg-proj-item ${p.id===activeProjectId?'cfg-proj-active':''}">
      <div class="cfg-proj-info">
        <span class="cfg-proj-name">${esc(p.name)}</span>
        <span class="cfg-proj-ms">${esc(p.milestone||'(sem milestone)')}</span>
      </div>
      <div class="cfg-proj-actions">
        <button class="btn" onclick="editProject('${p.id}')">✎</button>
        ${p.id!==activeProjectId
          ? `<button class="btn btn-danger" onclick="deleteProject('${p.id}')">✕</button>`
          : '<span class="cfg-proj-badge">ativo</span>'}
      </div>
    </div>`).join('');
}

window.editProject = function(id) {
  const p = projects.find(x=>x.id===id); if(!p) return;
  document.getElementById('cfgProjEditId').value   = p.id;
  document.getElementById('cfgToken').value         = p.token||'';
  document.getElementById('cfgUrl').value           = p.url||DEFAULT_CFG.url;
  document.getElementById('cfgGroup').value         = p.group||DEFAULT_CFG.group;
  document.getElementById('cfgMilestone').value     = p.milestone||'';
  document.getElementById('cfgProjName').value      = p.name||'';
  document.getElementById('cfgProjFormTitle').textContent = 'Editar Projeto';
  document.getElementById('cfgProjForm').style.display='';
};

window.deleteProject = function(id) {
  if (!confirm('Remover este projeto e todos os dados associados?')) return;
  projects = projects.filter(p=>p.id!==id);
  // Limpa dados locais do projeto removido
  localStorage.removeItem(`${STORE_PROG}_${id}`);
  localStorage.removeItem(`gantt_milestones_v1_${id}`);
  saveProjectsLocal();
  renderProjectList();
  renderProjectSelector();
};

window.saveCfgOnly = function() {
  const editId = document.getElementById('cfgProjEditId')?.value?.trim();
  const name    = document.getElementById('cfgProjName').value.trim();
  const token   = document.getElementById('cfgToken').value.trim();
  const url     = document.getElementById('cfgUrl').value.trim().replace(/\/$/, '');
  const group   = document.getElementById('cfgGroup').value.trim();
  const milestone = document.getElementById('cfgMilestone').value.trim();

  if (!name)  { alert('Informe o nome do projeto.'); return; }
  if (!token) { alert('Informe o Token do GitLab.'); return; }

  // Pega firebaseConfig do projeto ativo ou do __API_CONFIG__
  const existingFirebase = getActiveProject()?.firebaseConfig ||
    (window.__API_CONFIG__?.firebaseConfig?.apiKey !== 'SUA_API_KEY'
      ? window.__API_CONFIG__?.firebaseConfig : null);

  if (editId) {
    // Editar projeto existente
    const idx = projects.findIndex(p=>p.id===editId);
    if (idx!==-1) {
      projects[idx] = { ...projects[idx], name, token, url, group, milestone };
    }
  } else {
    // Salvar config no projeto ativo (se houver) ou criar novo
    if (activeProjectId) {
      const idx = projects.findIndex(p=>p.id===activeProjectId);
      if (idx!==-1) { projects[idx]={...projects[idx],name,token,url,group,milestone}; }
    } else {
      // Não há projeto ativo — só salva como legado no localStorage
      localStorage.setItem(STORE_CFG, JSON.stringify({token,url,group,milestone}));
      closeCfgModal(); loadFromAPI(); return;
    }
  }
  saveProjectsLocal();
  document.getElementById('cfgProjEditId').value='';
  document.getElementById('cfgProjForm').style.display='none';
  renderProjectList(); renderProjectSelector(); updateProjectBadge();
  closeCfgModal();
  initFirebase(getActiveProject()?.firebaseConfig||null);
  loadFromAPI();
};

window.openNewProjectForm = function() {
  document.getElementById('cfgProjEditId').value='';
  document.getElementById('cfgProjName').value='';
  document.getElementById('cfgToken').value='';
  document.getElementById('cfgUrl').value=DEFAULT_CFG.url;
  document.getElementById('cfgGroup').value=DEFAULT_CFG.group;
  document.getElementById('cfgMilestone').value='';
  document.getElementById('cfgProjFormTitle').textContent='Novo Projeto';
  document.getElementById('cfgProjForm').style.display='';
};

window.saveNewProject = function() {
  const name      = document.getElementById('cfgProjName').value.trim();
  const token     = document.getElementById('cfgToken').value.trim();
  const url       = document.getElementById('cfgUrl').value.trim().replace(/\/$/, '');
  const group     = document.getElementById('cfgGroup').value.trim();
  const milestone = document.getElementById('cfgMilestone').value.trim();
  const editId    = document.getElementById('cfgProjEditId')?.value?.trim();

  if (!name)  { alert('Informe o nome do projeto.'); return; }
  if (!token) { alert('Informe o Token do GitLab.'); return; }

  // Pega firebase do projeto ativo atual para reutilizar
  const existingFirebase = getActiveProject()?.firebaseConfig ||
    (window.__API_CONFIG__?.firebaseConfig?.apiKey !== 'SUA_API_KEY'
      ? window.__API_CONFIG__?.firebaseConfig : null);

  if (editId) {
    const idx=projects.findIndex(p=>p.id===editId);
    if (idx!==-1) projects[idx]={...projects[idx],name,token,url,group,milestone};
  } else {
    const id='proj_'+Date.now();
    projects.push({id,name,token,url,group,milestone,firebaseConfig:existingFirebase});
    // Muda para o novo projeto automaticamente
    activeProjectId=id;
    loadProgress(); loadMilestonesLocal(); allIssues=[];
    initFirebase(existingFirebase);
  }

  saveProjectsLocal();
  document.getElementById('cfgProjEditId').value='';
  document.getElementById('cfgProjForm').style.display='none';
  renderProjectList(); renderProjectSelector(); updateProjectBadge();
  closeCfgModal();
  loadFromAPI();
};

window.cancelProjForm = function() {
  document.getElementById('cfgProjForm').style.display='none';
  document.getElementById('cfgProjEditId').value='';
};

window.newProject = function() {
  openNewProjectForm();
};

/* ─── CREDENTIALS ─────────────────────────────────────────────────────────── */
async function loadCredentials() {
  let apiCfg = window.__API_CONFIG__ || null;
  let fileCfg = null;
  try {
    const resp = await fetch(`config.json?t=${Date.now()}`);
    if (resp.ok) fileCfg = await resp.json();
  } catch(e) {}

  const cfg  = apiCfg || fileCfg || {};
  const fCfg = (fileCfg?.firebaseConfig?.apiKey && fileCfg.firebaseConfig.apiKey!=='SUA_API_KEY')
    ? fileCfg.firebaseConfig
    : (apiCfg?.firebaseConfig?.apiKey && apiCfg.firebaseConfig.apiKey!=='SUA_API_KEY')
      ? apiCfg.firebaseConfig : null;

  const finalCfg = {
    token: cfg.token||'', url: cfg.url||'https://gitlab.4mti.com.br',
    group: cfg.group||'', milestone: cfg.milestone||'', firebaseConfig: fCfg,
  };

  // Se não há projetos ainda (nem local nem na nuvem), cria o projeto padrão
  // com a config do arquivo, herdando o mesmo firebaseConfig "global".
  if (!projects.length && finalCfg.token) {
    const id = 'proj_default';
    projects = [{
      id, name: 'EPC',
      token: finalCfg.token, url: finalCfg.url,
      group: finalCfg.group, milestone: finalCfg.milestone,
      firebaseConfig: fCfg,
    }];
    activeProjectId = id;
    saveProjectsLocal();
  } else if (!activeProjectId && projects.length) {
    activeProjectId = projects[0].id;
    saveProjectsLocal();
  }

  const activeProjCfg = getActiveProject() || finalCfg;
  document.getElementById('cfgToken').value     = activeProjCfg.token||'';
  document.getElementById('cfgUrl').value       = activeProjCfg.url||DEFAULT_CFG.url;
  document.getElementById('cfgGroup').value     = activeProjCfg.group||DEFAULT_CFG.group;
  document.getElementById('cfgMilestone').value = activeProjCfg.milestone||DEFAULT_CFG.milestone;

  return { ...finalCfg, ...activeProjCfg };
}

/* ─── INIT ──────────────────────────────────────────────────────────────── */

/* Registra event listeners dos filtros — chamado uma vez após o auth */
function setupFilterListeners() {
  ['filterSearch','filterStatus','filterFrom','filterTo'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.addEventListener('input',render);
  });
  const fState=document.getElementById('filterState');
  if (fState) fState.addEventListener('change',()=>{ if(allIssues.length) loadFromAPI(); });
  ['macroFrom','macroTo','macroSearch'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.addEventListener('input',renderMacro);
  });
}

/* Inicializa o Firebase (Auth + Firestore) e registra o listener de sessão */
async function inicializarApp() {

  // 1) Descobre a config global do Firebase e inicializa SDK
  let apiCfg = window.__API_CONFIG__ || null;
  let fileCfg = null;
  try {
    const resp = await fetch(`config.json?t=${Date.now()}`);
    if (resp.ok) fileCfg = await resp.json();
  } catch(e) {}
  const globalFirebaseCfg =
    (fileCfg?.firebaseConfig?.apiKey && fileCfg.firebaseConfig.apiKey !== 'SUA_API_KEY')
      ? fileCfg.firebaseConfig
      : (apiCfg?.firebaseConfig?.apiKey && apiCfg.firebaseConfig.apiKey !== 'SUA_API_KEY')
        ? apiCfg.firebaseConfig : null;

  initFirebase(globalFirebaseCfg);

  // 2) Exibe a tela de login enquanto aguarda a verificação de sessão
  showLoginUI();

  // 3) Observa mudanças de autenticação — Firebase mantém a sessão automaticamente
  firebase.auth().onAuthStateChanged(async (user) => {
    if (!user) {
      // Sem sessão ativa — mostra tela de login e limpa estado
      showLoginUI();
      document.getElementById('userWidget').style.display = 'none';
      return;
    }

    // Sessão ativa — carrega perfil do usuário
    currentUser = user;
    userProfile = await loadUserProfile(user);

    if (!userProfile || userProfile.role === 'pending') {
      // Usuário ainda não aprovado
      updateUserWidget(user, userProfile);
      showPendingUI();
      return;
    }

    // Usuário aprovado (role == 'user' ou 'admin') — inicia o app
    showAppUI();
    updateUserWidget(user, userProfile);

    // 4) Carrega projetos (local → nuvem) e aplica permissões
    loadProjectsLocal();
    loadProgress();
    loadMilestonesLocal();

    const gotFromCloud = await loadProjectsFromCloud();

    const cfgAtivo = await loadCredentials();

    const projFirebase = getActiveProject()?.firebaseConfig || globalFirebaseCfg;
    if (projFirebase !== globalFirebaseCfg) initFirebase(projFirebase);

    if (!gotFromCloud && projects.length) await saveProjectsToCloud();

    // 5) Aplica filtro de projetos por permissão do usuário
    applyUserPermissions(userProfile);

    await loadCentralData();

    renderProjectSelector();
    updateProjectBadge();

    if (cfgAtivo?.token) {
      loadFromAPI();
    } else {
      const localCfg = loadCfg();
      if (localCfg?.token) loadFromAPI();
    }

    switchView('macro');
    setupFilterListeners();
  });
}

// Suporte a Enter nos campos de login
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const loginVisible    = document.getElementById('formLogin')?.style.display !== 'none'
                          && document.getElementById('loginScreen')?.style.display !== 'none';
  const registerVisible = document.getElementById('formRegister')?.style.display !== 'none'
                          && document.getElementById('loginScreen')?.style.display !== 'none';
  if (loginVisible)    window.doLogin();
  if (registerVisible) window.doRegister();
});

inicializarApp();

