import React, { useState, useEffect } from 'react';
import { checkAllApiHealth, fetchJobFormSchemas, fetchBatchQueue } from '../services/api';
import {
  Terminal,
  Activity,
  Play,
  Database,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Code2,
  Layers,
  Cpu,
  Zap,
  Globe
} from 'lucide-react';

export default function DevDashboard() {
  const [healthStatus, setHealthStatus] = useState([]);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [selectedEndpoint, setSelectedEndpoint] = useState('ca_emails');
  const [apiParam, setApiParam] = useState('');
  const [testResponse, setTestResponse] = useState(null);
  const [testLoading, setTestLoading] = useState(false);
  const [schemas, setSchemas] = useState([]);
  const [queue, setQueue] = useState([]);

  // Check health on mount
  const runHealthCheck = async () => {
    setCheckingHealth(true);
    try {
      const res = await checkAllApiHealth();
      setHealthStatus(res);
    } catch (e) {
      console.error(e);
    } finally {
      setCheckingHealth(false);
    }
  };

  useEffect(() => {
    runHealthCheck();
    fetchJobFormSchemas().then((r) => setSchemas(r.schemas || []));
    fetchBatchQueue().then((r) => setQueue(r.queue || []));
  }, []);

  // Run Playground Query
  const handleRunPlayground = async () => {
    setTestLoading(true);
    setTestResponse(null);
    const start = performance.now();

    try {
      let url = '';
      if (selectedEndpoint === 'ca_emails') {
        url = 'https://applywizz-ca-management.vercel.app/api/ca/emails';
      } else if (selectedEndpoint === 'ca_history') {
        url = `https://applywizz-ca-management.vercel.app/api/ca/work-history?from=2026-09-23&to=2026-09-23&ca_email=${encodeURIComponent(apiParam || 'manasa@applywizz.com')}`;
      } else if (selectedEndpoint === 'client_details') {
        url = `https://www.apply-wizz.me/api/get-client-details?applywizz_id=${encodeURIComponent(apiParam || 'AWL-34133')}`;
      } else if (selectedEndpoint === 'supabase_schema') {
        url = 'https://rltnrnqqmufeeqaodsif.supabase.co/rest/v1/job_form_schemas?select=*&limit=3';
      }

      const headers = selectedEndpoint === 'supabase_schema'
        ? {
            apikey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJsdG5ybnFxbXVmZWVxYW9kc2lmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODMyOTU1NSwiZXhwIjoyMTAzOTA1NTU1fQ.eNtTpBT0xWtZzySiR_9OnHZVRxSmHgEZJL_pzvyfGwg',
            Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJsdG5ybnFxbXVmZWVxYW9kc2lmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODMyOTU1NSwiZXhwIjoyMTAzOTA1NTU1fQ.eNtTpBT0xWtZzySiR_9OnHZVRxSmHgEZJL_pzvyfGwg',
          }
        : {};

      const res = await fetch(url, { headers });
      const duration = Math.round(performance.now() - start);
      const data = await res.json();

      setTestResponse({
        url,
        status: res.status,
        statusText: res.statusText,
        duration: `${duration}ms`,
        body: data,
      });
    } catch (err) {
      setTestResponse({
        error: err.message,
        duration: `${Math.round(performance.now() - start)}ms`,
      });
    } finally {
      setTestLoading(false);
    }
  };

  return (
    <div className="dashboard-content">
      {/* Header Banner */}
      <div className="dashboard-header-row">
        <div>
          <h1 className="page-heading">Developer Diagnostics & Telemetry Hub</h1>
          <p className="page-subheading">
            Live integration health checks for the 4 core APIs, interactive query runner, and Supabase schema inspectors.
          </p>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={runHealthCheck}
            disabled={checkingHealth}
          >
            <RefreshCw size={16} className={checkingHealth ? 'spin-anim' : ''} />
            <span>Ping All 4 APIs</span>
          </button>
        </div>
      </div>

      {/* 4 APIs Health Status Grid */}
      <div className="kpi-grid">
        {healthStatus.map((item) => (
          <div key={item.id} className="kpi-card dev-health-card">
            <div className="dev-health-top">
              <span className="dev-endpoint-name">{item.name}</span>
              <span className={`status-pill ${item.ok ? 'submitted' : 'failed'}`}>
                {item.ok ? '200 OK' : 'ERROR'}
              </span>
            </div>
            <div className="dev-health-meta">
              <span className="dev-latency">
                <Zap size={14} className="text-accent" />
                {item.time}ms latency
              </span>
              <span className="dev-detail">{item.meta}</span>
            </div>
            <div className="dev-url-code">{item.url}</div>
          </div>
        ))}
      </div>

      {/* Interactive API Playground & Supabase Inspector */}
      <div className="grid-2-col">
        {/* Left: API Request Tester */}
        <div className="panel-card">
          <div className="panel-header">
            <div className="panel-title-group">
              <Play size={18} className="text-accent" />
              <h2 className="panel-title">Interactive API Tester & Playground</h2>
            </div>
          </div>

          <div className="console-form">
            <div className="auth-field-group">
              <label className="auth-label">SELECT TARGET ENDPOINT</label>
              <select
                value={selectedEndpoint}
                onChange={(e) => {
                  setSelectedEndpoint(e.target.value);
                  setApiParam('');
                }}
                className="select-input"
              >
                <option value="ca_emails">1. CA Roster & Emails API (/api/ca/emails)</option>
                <option value="ca_history">2. CA Work History API (/api/ca/work-history)</option>
                <option value="client_details">3. Client Details API (/api/get-client-details)</option>
                <option value="supabase_schema">4. Supabase Job Form Schemas (/job_form_schemas)</option>
              </select>
            </div>

            <div className="auth-field-group">
              <label className="auth-label">
                {selectedEndpoint === 'ca_history'
                  ? 'PARAMETER: CA EMAIL (Default: manasa@applywizz.com)'
                  : selectedEndpoint === 'client_details'
                  ? 'PARAMETER: APPLYWIZZ ID (Default: AWL-34133)'
                  : 'QUERY PARAMETERS (Optional)'}
              </label>
              <input
                type="text"
                value={apiParam}
                onChange={(e) => setApiParam(e.target.value)}
                placeholder={
                  selectedEndpoint === 'ca_history'
                    ? 'e.g. manasa@applywizz.com'
                    : selectedEndpoint === 'client_details'
                    ? 'e.g. AWL-34133'
                    : 'No parameter required'
                }
                className="auth-input"
              />
            </div>

            <button
              type="button"
              className="btn-accent-run"
              onClick={handleRunPlayground}
              disabled={testLoading}
            >
              <Code2 size={16} />
              <span>{testLoading ? 'Executing Request...' : 'Send Live Request'}</span>
            </button>

            {/* Response Viewer */}
            {testResponse && (
              <div className="test-response-box">
                <div className="test-response-header">
                  <span className="response-status">Status: {testResponse.status || 'OK'}</span>
                  <span className="response-time">{testResponse.duration}</span>
                </div>
                <pre className="test-response-code">
                  {JSON.stringify(testResponse.body || testResponse.error, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>

        {/* Right: Job Form Schemas & Batch Queue Cache */}
        <div className="right-stack">
          {/* Cached Job Form Schemas */}
          <div className="panel-card">
            <div className="panel-header">
              <div className="panel-title-group">
                <Layers size={18} className="text-accent" />
                <h2 className="panel-title">Cached Job Form Schemas (Supabase)</h2>
              </div>
              <span className="badge-count">{schemas.length}</span>
            </div>

            <div className="schema-list-wrapper">
              {schemas.length > 0 ? (
                schemas.map((s) => (
                  <div key={s.id} className="schema-card-item">
                    <div className="schema-head-row">
                      <span className="company-text">{s.company || 'Workday Tenant'}</span>
                      <span className="status-pill submitted">{s.ats_type}</span>
                    </div>
                    <div className="schema-url-sub">{s.canonical_job_url}</div>
                    <div className="schema-stats-row">
                      <span>Fields: {s.total_fields || 0}</span>
                      <span>Steps: {Array.isArray(s.step_names) ? s.step_names.join(' &rarr; ') : 'All'}</span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty-state">No schemas cached yet</div>
              )}
            </div>
          </div>

          {/* Batch Job Queue Inspector */}
          <div className="panel-card">
            <div className="panel-header">
              <div className="panel-title-group">
                <Cpu size={18} className="text-accent" />
                <h2 className="panel-title">Batch Job Queue Status</h2>
              </div>
              <span className="badge-count">{queue.length}</span>
            </div>

            <div className="queue-list-wrapper">
              {queue.length > 0 ? (
                queue.map((q) => (
                  <div key={q.id} className="queue-item-box">
                    <div className="queue-head-row">
                      <span className="cell-id-badge">{q.applywizz_id}</span>
                      <span className={`status-pill ${q.status}`}>{q.status}</span>
                    </div>
                    <div className="queue-url-sub">{q.job_url}</div>
                  </div>
                ))
              ) : (
                <div className="empty-state">Queue is clear and idle</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
