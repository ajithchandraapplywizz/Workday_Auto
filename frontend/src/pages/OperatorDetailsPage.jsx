import React, { useState, useEffect } from 'react';
import { ArrowLeft, ExternalLink, Search, RefreshCw, User, Mail, Briefcase, Calendar, ShieldCheck, CheckCircle2 } from 'lucide-react';
import { fetchAssignedClientsForCA, formatClientCompanyEmail } from '../services/api';

export default function OperatorDetailsPage({
  operator,
  onBack,
  dateStr = '',
  sourceDashboard = 'admin', // 'admin' | 'manager'
}) {
  const [loading, setLoading] = useState(false);
  const [clients, setClients] = useState([]);
  const [activeDate, setActiveDate] = useState(dateStr);
  const [isFallback, setIsFallback] = useState(false);
  const [search, setSearch] = useState('');

  const loadClients = async () => {
    if (!operator?.email) return;
    setLoading(true);
    try {
      const res = await fetchAssignedClientsForCA({
        caEmail: operator.email,
        atDate: dateStr,
      });
      if (res.success) {
        setClients(res.assignments || []);
        setActiveDate(res.activeDate || dateStr);
        setIsFallback(Boolean(res.isFallback));
      } else {
        setClients([]);
      }
    } catch (err) {
      console.error('Failed to load CA client details:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (operator?.email) {
      loadClients();
    }
  }, [operator?.email, dateStr]);

  // Support browser Back button via history / popstate
  useEffect(() => {
    const handlePopState = () => {
      if (onBack) onBack();
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [onBack]);

  if (!operator) {
    return (
      <div className="tab-body-fade" style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8' }}>
        <p>No operator selected.</p>
        <button
          type="button"
          onClick={onBack}
          style={{
            marginTop: '1rem',
            padding: '8px 16px',
            background: '#0284c7',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
          }}
        >
          ← Return to Operators
        </button>
      </div>
    );
  }

  const isOpActive = (operator.status || '').toLowerCase() === 'active';

  const filteredClients = clients.filter((c) => {
    const q = search.toLowerCase();
    return (
      !search ||
      c.client_name?.toLowerCase().includes(q) ||
      c.applywizz_id?.toLowerCase().includes(q) ||
      c.client_email?.toLowerCase().includes(q)
    );
  });

  const totalApplied = clients.reduce((acc, c) => acc + (c.jobs_applied || 0), 0);
  const totalSubmitted = clients.reduce((acc, c) => acc + (c.emails_submitted || 0), 0);
  const completionRate = clients.length > 0 ? Math.round((totalSubmitted / (clients.length * 10)) * 100) : 0;

  return (
    <div className="tab-body-fade" style={{ padding: '1rem 0', minHeight: '80vh' }}>
      {/* Top Navigation & Breadcrumbs Bar */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1.5rem',
          flexWrap: 'wrap',
          gap: '1rem',
          background: '#0f172a',
          padding: '1rem 1.25rem',
          borderRadius: '10px',
          border: '1px solid #1e293b',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <button
            type="button"
            onClick={onBack}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              background: '#1e293b',
              color: '#38bdf8',
              border: '1px solid #334155',
              borderRadius: '6px',
              padding: '7px 14px',
              fontSize: '0.85rem',
              fontWeight: '600',
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
            title="Return to Operators Directory"
          >
            <ArrowLeft size={16} />
            <span>Back to Operators</span>
          </button>

          <div style={{ fontSize: '0.85rem', color: '#94a3b8' }}>
            <span>{sourceDashboard === 'manager' ? 'Manager Dashboard' : 'Admin Dashboard'}</span>
            <span style={{ margin: '0 6px', color: '#475569' }}>/</span>
            <span>Operators Directory</span>
            <span style={{ margin: '0 6px', color: '#475569' }}>/</span>
            <strong style={{ color: '#f8fafc' }}>{operator.name}</strong>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div
            style={{
              fontSize: '0.82rem',
              color: '#94a3b8',
              background: '#1e293b',
              padding: '6px 12px',
              borderRadius: '6px',
              border: '1px solid #334155',
            }}
          >
            <Calendar size={13} style={{ display: 'inline', verticalAlign: 'middle', marginRight: '6px' }} />
            Work Date: <strong style={{ color: '#f8fafc' }}>{activeDate}</strong>
            {isFallback && (
              <span style={{ color: '#f59e0b', marginLeft: '6px', fontWeight: 'bold' }}>
                (Fallback)
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={loadClients}
            disabled={loading}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              background: '#0284c7',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              padding: '7px 14px',
              fontSize: '0.82rem',
              fontWeight: '600',
              cursor: 'pointer',
            }}
            title="Refresh live data from backend"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            <span>{loading ? 'Refreshing...' : 'Live Refresh'}</span>
          </button>
        </div>
      </div>

      {/* Operator Profile Banner */}
      <div
        style={{
          background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
          borderRadius: '12px',
          border: '1px solid #334155',
          padding: '1.5rem',
          marginBottom: '1.5rem',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1.25rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
          <div
            style={{
              width: '60px',
              height: '60px',
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #0284c7 0%, #38bdf8 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '1.5rem',
              fontWeight: 'bold',
              color: '#ffffff',
              boxShadow: '0 4px 12px rgba(2, 132, 199, 0.4)',
            }}
          >
            {(operator.name || 'CA').substring(0, 2).toUpperCase()}
          </div>

          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
              <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 'bold', color: '#f8fafc' }}>
                {operator.name}
              </h1>
              <span
                style={{
                  fontSize: '0.75rem',
                  padding: '3px 10px',
                  borderRadius: '12px',
                  fontWeight: 'bold',
                  background: isOpActive ? 'rgba(16, 185, 129, 0.2)' : 'rgba(148, 163, 184, 0.15)',
                  color: isOpActive ? '#34d399' : '#94a3b8',
                  border: `1px solid ${isOpActive ? '#059669' : '#475569'}`,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                }}
              >
                <span
                  style={{
                    width: '7px',
                    height: '7px',
                    borderRadius: '50%',
                    background: isOpActive ? '#10b981' : '#64748b',
                  }}
                />
                {isOpActive ? 'ACTIVE SESSION' : 'INACTIVE'}
              </span>
            </div>

            <div style={{ fontSize: '0.88rem', color: '#94a3b8', display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
              <span>
                <Mail size={13} style={{ display: 'inline', verticalAlign: 'middle', marginRight: '4px' }} />
                <strong style={{ color: '#cbd5e1' }}>{operator.email}</strong>
              </span>
              <span>
                <Briefcase size={13} style={{ display: 'inline', verticalAlign: 'middle', marginRight: '4px' }} />
                Role: <strong style={{ color: '#cbd5e1' }}>{operator.role || 'Career Associate'}</strong>
              </span>
              {operator.manager_name && (
                <span>
                  <ShieldCheck size={13} style={{ display: 'inline', verticalAlign: 'middle', marginRight: '4px' }} />
                  Manager: <strong style={{ color: '#38bdf8' }}>{operator.manager_name}</strong>
                </span>
              )}
              <span>
                Last Sign-In:{' '}
                <strong style={{ color: '#cbd5e1' }}>
                  {operator.last_sign_in ? new Date(operator.last_sign_in).toLocaleString() : 'Never'}
                </strong>
              </span>
            </div>
          </div>
        </div>

        {/* Live Fallback Badge */}
        {isFallback && (
          <div
            style={{
              background: 'rgba(245, 158, 11, 0.12)',
              border: '1px solid rgba(245, 158, 11, 0.3)',
              borderRadius: '8px',
              padding: '8px 14px',
              fontSize: '0.82rem',
              color: '#fbbf24',
              maxWidth: '300px',
            }}
          >
            <strong>ℹ️ Previous Active Day Data</strong>
            <p style={{ margin: '4px 0 0', fontSize: '0.78rem', color: '#cbd5e1' }}>
              Showing client assignments and metrics rolled back to <strong>{activeDate}</strong>.
            </p>
          </div>
        )}
      </div>

      {/* KPI Cards Row */}
      <div className="video-admin-kpi-grid" style={{ marginBottom: '1.5rem' }}>
        <div className="video-kpi-box highlighted">
          <span className="vkpi-label">TOTAL ALLOTTED CLIENTS</span>
          <span className="vkpi-val">{clients.length}</span>
          <span style={{ fontSize: '0.75rem', color: '#38bdf8', marginTop: '4px' }}>
            Active candidate quota
          </span>
        </div>

        <div className="video-kpi-box">
          <span className="vkpi-label">JOBS APPLIED</span>
          <span className="vkpi-val" style={{ color: '#38bdf8' }}>
            {totalApplied}
          </span>
          <span style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '4px' }}>
            Across all allotted candidates
          </span>
        </div>

        <div className="video-kpi-box">
          <span className="vkpi-label">EMAILS SUBMITTED</span>
          <span className="vkpi-val" style={{ color: '#10b981' }}>
            {totalSubmitted}
          </span>
          <span style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '4px' }}>
            Confirmed job submissions
          </span>
        </div>

        <div className="video-kpi-box">
          <span className="vkpi-label">QUOTA COMPLETION</span>
          <span className="vkpi-val" style={{ color: completionRate > 70 ? '#10b981' : '#f59e0b' }}>
            {completionRate}%
          </span>
          <span style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '4px' }}>
            Daily progress rollup
          </span>
        </div>
      </div>

      {/* Search & Allotted Clients Table */}
      <div className="video-card-section" style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: '12px', padding: '1.25rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 'bold', color: '#f8fafc' }}>
              Allotted Clients Roster ({filteredClients.length})
            </h3>
            <span style={{ fontSize: '0.82rem', color: '#94a3b8' }}>
              Active candidates allotted to {operator.name} for {activeDate}
            </span>
          </div>

          <div style={{ position: 'relative', width: '320px' }}>
            <Search size={16} color="#64748b" style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by client name, AWL ID, or email..."
              className="video-input-search"
              style={{ width: '100%', paddingLeft: '32px', fontSize: '0.82rem' }}
            />
          </div>
        </div>

        <div className="video-table-container">
          <table className="video-data-table">
            <thead>
              <tr>
                <th>CLIENT NAME</th>
                <th>APPLYWIZZ ID</th>
                <th>OFFICIAL COMPANY EMAIL</th>
                <th style={{ textAlign: 'center' }}>ZOHO STATUS</th>
                <th style={{ textAlign: 'center' }}>JOBS APPLIED</th>
                <th style={{ textAlign: 'center' }}>EMAILS SUBMITTED</th>
                <th>WORK DATE</th>
                <th style={{ textAlign: 'center' }}>PROFILE LINK</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: '2.5rem', color: '#94a3b8' }}>
                    <RefreshCw size={20} className="animate-spin" style={{ margin: '0 auto 8px', display: 'block' }} />
                    Loading live candidate allocations from CA management backend...
                  </td>
                </tr>
              ) : filteredClients.length > 0 ? (
                filteredClients.map((c) => {
                  const companyMail = formatClientCompanyEmail(c.client_name, c.client_email);
                  return (
                    <tr key={c.applywizz_id}>
                      <td>
                        <strong style={{ color: '#f8fafc' }}>{c.client_name || c.applywizz_id}</strong>
                      </td>
                      <td>
                        <a
                          href={`https://www.apply-wizz.me/api/get-client-details?applywizz_id=${encodeURIComponent(c.applywizz_id)}`}
                          target="_blank"
                          rel="noreferrer"
                          className="app-id-tag"
                          style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                          title="View CRM profile"
                        >
                          <span>{c.applywizz_id}</span>
                          <ExternalLink size={11} />
                        </a>
                      </td>
                      <td>
                        <span style={{ color: '#38bdf8', fontSize: '0.85rem', fontWeight: '500' }}>
                          {companyMail}
                        </span>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {c.zoho_status === 'not_connected' ? (
                          <span style={{ padding: '3px 8px', borderRadius: '4px', fontSize: '0.72rem', fontWeight: '600', background: 'rgba(239, 68, 68, 0.15)', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.3)' }}>
                            ⚠️ Not Connected
                          </span>
                        ) : (
                          <span style={{ padding: '3px 8px', borderRadius: '4px', fontSize: '0.72rem', fontWeight: '600', background: 'rgba(16, 185, 129, 0.15)', color: '#34d399', border: '1px solid rgba(16, 185, 129, 0.3)' }}>
                            ✓ Connected
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <span style={{ color: (c.jobs_applied || 0) > 0 ? '#38bdf8' : '#64748b', fontWeight: 'bold' }}>
                          {c.jobs_applied || 0}
                        </span>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <span style={{ color: (c.emails_submitted || 0) > 0 ? '#10b981' : '#64748b', fontWeight: 'bold' }}>
                          {c.emails_submitted || 0}
                        </span>
                      </td>
                      <td>
                        <span style={{ fontSize: '0.82rem', color: '#94a3b8' }}>
                          {c.date || activeDate}
                        </span>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <a
                          href={`https://www.apply-wizz.me/api/get-client-details?applywizz_id=${encodeURIComponent(c.applywizz_id)}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            background: '#1e293b',
                            border: '1px solid #334155',
                            color: '#38bdf8',
                            padding: '4px 10px',
                            borderRadius: '4px',
                            fontSize: '0.78rem',
                            fontWeight: '600',
                            textDecoration: 'none',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                          }}
                        >
                          <span>CRM View</span>
                          <ExternalLink size={10} />
                        </a>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: '3rem', color: '#64748b' }}>
                    No active clients allotted to {operator.name} for {activeDate}.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
