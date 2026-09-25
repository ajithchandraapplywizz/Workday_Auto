// Workday Auto-Apply Enterprise Frontend Controller

document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  initDashboardData();
  initLogStream();
  initSearchFilters();
  initQuickActions();
});

// Tab Navigation
function initNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  const panels = document.querySelectorAll('.tab-panel');

  navItems.forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const targetId = item.getAttribute('data-target');

      navItems.forEach((n) => n.classList.remove('active'));
      panels.forEach((p) => p.classList.remove('active'));

      item.classList.add('active');
      const targetPanel = document.getElementById(targetId);
      if (targetPanel) {
        targetPanel.classList.add('active');
      }

      const pageHeading = document.getElementById('page-heading');
      if (pageHeading) {
        pageHeading.textContent = item.querySelector('span').textContent;
      }
    });
  });
}

// Mock & Live Data Integration
const state = {
  stats: {
    totalApplications: 1420,
    successRate: 98.4,
    cacheHitRate: 84.6,
    activeWorkers: 3,
  },
  workers: [
    { id: 'Worker-1', status: 'active', currentAWL: 'AWL-32732', currentJob: 'formulaone (Design Engineer)', speed: '12s / page' },
    { id: 'Worker-2', status: 'active', currentAWL: 'AWL-31385', currentJob: 'formulaone (Design Engineer)', speed: '11s / page' },
    { id: 'Worker-3', status: 'active', currentAWL: 'AWL-35245', currentJob: 'formulaone (Design Engineer)', speed: '14s / page' },
    { id: 'Worker-4', status: 'idle', currentAWL: '—', currentJob: 'Standby', speed: '—' },
    { id: 'Worker-5', status: 'idle', currentAWL: '—', currentJob: 'Standby', speed: '—' },
  ],
  queue: [
    { id: 'Q-901', awl: 'AWL-32732', company: 'Formula One', role: 'Design Quality Engineer', status: 'processing', preResolved: true, time: 'Just now' },
    { id: 'Q-902', awl: 'AWL-31385', company: 'Formula One', role: 'Design Quality Engineer', status: 'processing', preResolved: true, time: '1 min ago' },
    { id: 'Q-903', awl: 'AWL-35245', company: 'Formula One', role: 'Design Quality Engineer', status: 'processing', preResolved: true, time: '2 mins ago' },
    { id: 'Q-904', awl: 'AWL-26828', company: 'Formula One', role: 'Design Quality Engineer', status: 'pre_resolved', preResolved: true, time: '3 mins ago' },
    { id: 'Q-905', awl: 'AWL-34133', company: 'Allied Solutions', role: 'Software Engineer', status: 'submitted', preResolved: true, time: '5 mins ago' },
    { id: 'Q-906', awl: 'AWL-33824', company: 'Adobe Systems', role: 'Backend Developer', status: 'submitted', preResolved: true, time: '8 mins ago' },
    { id: 'Q-907', awl: 'AWL-29576', company: 'Stryker Corp', role: 'QA Automation', status: 'reached_review', preResolved: true, time: '12 mins ago' },
  ],
  schemas: [
    { domain: 'formulaone.wd3.myworkdayjobs.com', role: 'Design Quality Engineer', steps: ['My Information', 'My Experience', 'Application Questions', 'Review'], fieldsCount: 28, lastUpdated: '10 mins ago' },
    { domain: 'alliedsolutions.wd1.myworkdayjobs.com', role: 'Software Engineer', steps: ['Personal Info', 'Experience', 'Voluntary Disclosures', 'Review'], fieldsCount: 34, lastUpdated: '1 hour ago' },
    { domain: 'nvidia.wd5.myworkdayjobs.com', role: 'AI Systems Architect', steps: ['Information', 'Work History', 'Screening', 'Review'], fieldsCount: 42, lastUpdated: '3 hours ago' },
  ],
  clients: [
    { awl: 'AWL-32732', name: 'Yagnesh Kumar Vuyyala', email: 'yagnesh.vuyyala@applywizard.ai', dob: '04/18/1997', visa: 'F1-OPT (STEM)', resume: 'Cached' },
    { awl: 'AWL-31385', name: 'Prabhavathi Pemmasani', email: 'prabhavathi.pemmasani@applywizard.ai', dob: '11/09/1998', visa: 'H1-B Transfer', resume: 'Cached' },
    { awl: 'AWL-35245', name: 'Manisha D', email: 'manisha.derangula@applywizard.ai', dob: '08/27/1996', visa: 'Citizen', resume: 'Cached' },
    { awl: 'AWL-26828', name: 'Nikhila Yadav Lankela', email: 'nikhila.lankela@applywizard.ai', dob: '05/13/1998', visa: 'F1-OPT', resume: 'Cached' },
  ]
};

function initDashboardData() {
  renderStats();
  renderWorkers();
  renderQueueTable();
  renderSchemasTable();
  renderClientsTable();
}

function renderStats() {
  document.getElementById('stat-total-apps').textContent = state.stats.totalApplications.toLocaleString();
  document.getElementById('stat-success-rate').textContent = `${state.stats.successRate}%`;
  document.getElementById('stat-cache-hit').textContent = `${state.stats.cacheHitRate}%`;
  document.getElementById('stat-active-workers').textContent = `${state.state_workers_count || 3} Active`;
}

function renderWorkers() {
  const container = document.getElementById('workers-grid-container');
  if (!container) return;

  container.innerHTML = state.workers.map(w => `
    <div class="worker-node ${w.status === 'active' ? 'busy' : ''}">
      <div class="worker-header">
        <span class="worker-name">${w.id}</span>
        <span class="badge ${w.status === 'active' ? 'badge-active' : 'badge-idle'}">${w.status}</span>
      </div>
      <div style="font-size: 0.8rem; color: var(--text-dim);">
        Target: <strong style="color: var(--text-main);">${w.currentAWL}</strong>
      </div>
      <div style="font-size: 0.8rem; color: var(--text-dim); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">
        Job: ${w.currentJob}
      </div>
      <div style="font-size: 0.75rem; color: var(--accent-green); margin-top: 4px;">
        Speed: ${w.speed}
      </div>
    </div>
  `).join('');
}

function renderQueueTable(filteredQueue = state.queue) {
  const tbody = document.getElementById('queue-table-body');
  if (!tbody) return;

  tbody.innerHTML = filteredQueue.map(item => `
    <tr>
      <td><code>${item.id}</code></td>
      <td><strong>${item.awl}</strong></td>
      <td>${item.company}</td>
      <td>${item.role}</td>
      <td>
        <span class="badge ${
          item.status === 'submitted' ? 'badge-success' :
          item.status === 'processing' ? 'badge-active' :
          item.status === 'pre_resolved' ? 'badge-pending' :
          item.status === 'reached_review' ? 'badge-success' : 'badge-failed'
        }">${item.status}</span>
      </td>
      <td>
        ${item.preResolved ? '<span style="color: var(--accent-green);">⚡ Pre-Resolved</span>' : '<span style="color: var(--text-dim);">Dynamic</span>'}
      </td>
      <td style="color: var(--text-dim);">${item.time}</td>
    </tr>
  `).join('');
}

function renderSchemasTable() {
  const tbody = document.getElementById('schemas-table-body');
  if (!tbody) return;

  tbody.innerHTML = state.schemas.map(s => `
    <tr>
      <td><strong>${s.domain}</strong></td>
      <td>${s.role}</td>
      <td>${s.steps.map(step => `<span class="badge badge-idle" style="margin-right: 4px;">${step}</span>`).join('')}</td>
      <td><strong>${s.fieldsCount}</strong> fields</td>
      <td style="color: var(--text-dim);">${s.lastUpdated}</td>
    </tr>
  `).join('');
}

function renderClientsTable(filteredClients = state.clients) {
  const tbody = document.getElementById('clients-table-body');
  if (!tbody) return;

  tbody.innerHTML = filteredClients.map(c => `
    <tr>
      <td><code>${c.awl}</code></td>
      <td><strong>${c.name}</strong></td>
      <td>${c.email}</td>
      <td><code>${c.dob}</code></td>
      <td><span class="badge badge-active">${c.visa}</span></td>
      <td><span style="color: var(--accent-green);">✓ ${c.resume}</span></td>
    </tr>
  `).join('');
}

function initSearchFilters() {
  const queueSearch = document.getElementById('queue-search-input');
  if (queueSearch) {
    queueSearch.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      const filtered = state.queue.filter(item => 
        item.awl.toLowerCase().includes(q) ||
        item.company.toLowerCase().includes(q) ||
        item.role.toLowerCase().includes(q) ||
        item.status.toLowerCase().includes(q)
      );
      renderQueueTable(filtered);
    });
  }

  const clientSearch = document.getElementById('client-search-input');
  if (clientSearch) {
    clientSearch.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      const filtered = state.clients.filter(c => 
        c.awl.toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q)
      );
      renderClientsTable(filtered);
    });
  }
}

function initQuickActions() {
  const btnTriggerBatch = document.getElementById('btn-trigger-batch');
  if (btnTriggerBatch) {
    btnTriggerBatch.addEventListener('click', () => {
      addLog('info', 'Command received: Starting parallel worker queue dispatch...');
      setTimeout(() => addLog('success', 'Claimed 3 tasks from batch_job_queue (Worker-1, Worker-2, Worker-3)'), 600);
      setTimeout(() => addLog('info', '[Worker-1] Cache Hit: Form schema loaded instantly (0 ms). Pre-resolving answers...'), 1200);
      setTimeout(() => addLog('success', '[Worker-1] DOB formatted to MM/DD/YYYY: "04/18/1997"'), 1800);
    });
  }

  const btnSyncSupabase = document.getElementById('btn-sync-supabase');
  if (btnSyncSupabase) {
    btnSyncSupabase.addEventListener('click', () => {
      addLog('info', 'Connecting to Supabase clients and job_form_schemas tables...');
      setTimeout(() => addLog('success', 'Synchronized 200+ clients, 175 facts/client, and 45 form schemas successfully.'), 800);
    });
  }
}

// Console & Log Stream
function addLog(type, message) {
  const term = document.getElementById('terminal-content');
  if (!term) return;

  const now = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.className = 'log-line';
  line.innerHTML = `<span class="log-time">[${now}]</span> <span class="log-${type}">${message}</span>`;
  term.appendChild(line);
  term.scrollTop = term.scrollHeight;
}

function initLogStream() {
  const initialLogs = [
    { type: 'info', msg: 'Enterprise Workday Auto-Apply Engine initialized' },
    { type: 'success', msg: 'Loaded Supabase schema (clients, client_questions, job_form_schemas, batch_job_queue)' },
    { type: 'info', msg: 'Loaded 3 active workers in pool (Worker-1, Worker-2, Worker-3)' },
    { type: 'success', msg: 'DOB MM/DD/YYYY resolution pipeline active (Tier-0 cache + Tier-1 facts)' },
    { type: 'info', msg: 'Job Form Schema Cache: Ready to bypass form discovery for shared links' },
  ];

  initialLogs.forEach(l => addLog(l.type, l.msg));
}
