import React, { useState, useEffect } from 'react';
import { X, ExternalLink, Search, RefreshCw, User, Briefcase, Mail } from 'lucide-react';
import { fetchAssignedClientsForCA } from '../services/api';

export default function CAClientDetailsModal({
  isOpen,
  onClose,
  operator,
  dateStr = '',
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
    if (isOpen && operator?.email) {
      loadClients();
    }
  }, [isOpen, operator?.email, dateStr]);

  if (!isOpen || !operator) return null;

  const filteredClients = clients.filter((c) => {
    const q = search.toLowerCase();
    return (
      !search ||
      c.client_name?.toLowerCase().includes(q) ||
      c.applywizz_id?.toLowerCase().includes(q) ||
      c.client_email?.toLowerCase().includes(q)
    );
  });

  const isOpActive = (operator.status || '').toLowerCase() === 'active';

  return (
    <div className="auth-overlay" style={{ zIndex: 1100 }}>
      <div className="auth-backdrop" onClick={onClose} />
      <div
        className="modal-dialog animate-slide-up"
        style={{
          maxWidth: '850px',
          width: '95%',
          background: '#0f172a',
          border: '1px solid #334155',
          borderRadius: '12px',
          padding: '1.5rem',
          color: '#f8fafc',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5)',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '1px solid #1e293b', paddingBottom: '1rem', marginBottom: '1rem' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <User size={20} color="#38bdf8" />
              <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 'bold', color: '#f8fafc' }}>
                {operator.name}
              </h2>
              <span
                style={{
                  fontSize: '0.72rem',
                  padding: '2px 8px',
                  borderRadius: '12px',
                  fontWeight: 'bold',
                  background: isOpActive ? '#064e3b' : '#334155',
                  color: isOpActive ? '#34d399' : '#94a3b8',
                  border: `1px solid ${isOpActive ? '#059669' : '#475569'}`,
                }}
              >
                {isOpActive ? 'ACTIVE SESSION' : 'INACTIVE'}
              </span>
            </div>
            <div style={{ fontSize: '0.85rem', color: '#94a3b8', display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <span><Mail size={13} style={{ display: 'inline', verticalAlign: 'middle' }} /> {operator.email}</span>
              {operator.manager_name && <span>&bull; Manager: <strong style={{ color: '#38bdf8' }}>{operator.manager_name}</strong></span>}
              <span>&bull; Date: <strong style={{ color: '#f1f5f9' }}>{activeDate}</strong></span>
              {isFallback && (
                <span style={{ color: '#f59e0b', fontWeight: 'bold' }}>
                  (ℹ️ Previous active day fallback)
                </span>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button
              type="button"
              onClick={loadClients}
              disabled={loading}
              title="Refresh live clients from backend"
              style={{
                background: '#1e293b',
                border: '1px solid #334155',
                color: '#cbd5e1',
                padding: '6px 12px',
                borderRadius: '6px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '0.8rem',
              }}
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              <span>{loading ? 'Refreshing...' : 'Live Refresh'}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#94a3b8',
                cursor: 'pointer',
                padding: '4px',
              }}
            >
              <X size={22} />
            </button>
          </div>
        </div>

        {/* Filter / Search Bar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', gap: '1rem' }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <Search size={16} color="#64748b" style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search allotted clients by name or AWL ID..."
              style={{
                width: '100%',
                background: '#1e293b',
                border: '1px solid #334155',
                borderRadius: '6px',
                padding: '8px 12px 8px 34px',
                color: '#f8fafc',
                fontSize: '0.85rem',
              }}
            />
          </div>
          <span style={{ fontSize: '0.85rem', color: '#94a3b8', whiteSpace: 'nowrap' }}>
            Allotted Clients: <strong style={{ color: '#38bdf8' }}>{clients.length}</strong>
          </span>
        </div>

        {/* Clients Table */}
        <div style={{ maxHeight: '420px', overflowY: 'auto', border: '1px solid #1e293b', borderRadius: '6px' }}>
          <table className="video-data-table" style={{ width: '100%', margin: 0 }}>
            <thead>
              <tr style={{ background: '#1e293b' }}>
                <th>CLIENT NAME</th>
                <th>APPLYWIZZ ID</th>
                <th>EMAIL</th>
                <th style={{ textAlign: 'center' }}>APPLIED</th>
                <th style={{ textAlign: 'center' }}>SUBMITTED</th>
                <th>WORK DATE</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: '2rem', color: '#94a3b8' }}>
                    Fetching live allotted clients from CA management backend...
                  </td>
                </tr>
              ) : filteredClients.length > 0 ? (
                filteredClients.map((c) => (
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
                      >
                        <span>{c.applywizz_id}</span>
                        <ExternalLink size={11} />
                      </a>
                    </td>
                    <td>
                      <span style={{ color: '#94a3b8', fontSize: '0.85rem' }}>
                        {c.client_email || '—'}
                      </span>
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
                      <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                        {c.date || activeDate}
                      </span>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: '2.5rem', color: '#64748b' }}>
                    No active clients allotted to {operator.name} for {activeDate}.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem' }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: '#334155',
              border: 'none',
              borderRadius: '6px',
              padding: '8px 18px',
              color: '#f8fafc',
              fontSize: '0.85rem',
              fontWeight: '600',
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
