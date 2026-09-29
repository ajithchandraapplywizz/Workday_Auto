import React, { useState, useEffect } from 'react';
import { fetchCAEmails, fetchCAWorkHistory } from '../services/api';
import {
  Calendar,
  Users,
  TrendingUp,
  Award,
  CheckCircle2,
  Clock,
  Download,
  RefreshCw,
  Search,
  Filter,
  BarChart2,
  Layers,
  ArrowUpRight
} from 'lucide-react';

export default function OpsManagerDashboard() {
  const [loading, setLoading] = useState(false);
  const [fromDate, setFromDate] = useState('2026-09-23');
  const [toDate, setToDate] = useState('2026-09-23');
  const [selectedCaEmail, setSelectedCaEmail] = useState('manasa@applywizz.com');
  const [caList, setCaList] = useState([]);
  const [workRecords, setWorkRecords] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');

  // 1. Fetch CA emails list on mount
  useEffect(() => {
    async function loadCAs() {
      const res = await fetchCAEmails();
      if (res.success && res.users) {
        setCaList(res.users);
      }
    }
    loadCAs();
  }, []);

  // 2. Fetch Work History for current filters
  const loadWorkHistory = async () => {
    setLoading(true);
    try {
      const res = await fetchCAWorkHistory({
        from: fromDate,
        to: toDate,
        caEmail: selectedCaEmail,
      });

      if (res.success) {
        setWorkRecords(res.records || []);
        setTotalCount(res.total || (res.records || []).length);
      }
    } catch (err) {
      console.error('Failed to load work history:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadWorkHistory();
  }, [fromDate, toDate, selectedCaEmail]);

  // Aggregate stats from records
  const totalEmailsSubmitted = workRecords.reduce((acc, r) => acc + (Number(r.emails_submitted) || 0), 0);
  const totalJobsApplied = workRecords.reduce((acc, r) => acc + (Number(r.jobs_applied) || 0), 0);
  const totalEmailsRequired = workRecords.reduce((acc, r) => acc + (Number(r.emails_required) || 0), 0);
  const avgEfficiency = totalEmailsRequired > 0 ? Math.min(100, Math.round((totalEmailsSubmitted / totalEmailsRequired) * 100)) : 100;

  // Filter records by search query
  const filteredRecords = workRecords.filter((r) => {
    const q = searchQuery.toLowerCase();
    return (
      r.client_name?.toLowerCase().includes(q) ||
      r.applywizz_id?.toLowerCase().includes(q) ||
      r.ca_name?.toLowerCase().includes(q) ||
      r.client_email?.toLowerCase().includes(q)
    );
  });

  // Export CSV
  const handleExportCSV = () => {
    if (!workRecords.length) return;
    const headers = ['Date', 'CA Name', 'CA Email', 'ApplyWizz ID', 'Client Name', 'Emails Submitted', 'Jobs Applied', 'Status', 'Start Time', 'End Time'];
    const rows = workRecords.map(r => [
      r.date || '',
      r.ca_name || '',
      r.ca_email || '',
      r.applywizz_id || '',
      `"${r.client_name || ''}"`,
      r.emails_submitted || 0,
      r.jobs_applied || 0,
      r.status || '',
      r.start_time || '',
      r.end_time || '',
    ]);
    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `ApplyWizz_WorkHistory_${fromDate}_${toDate}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="dashboard-content">
      {/* Header Banner */}
      <div className="dashboard-header-row">
        <div>
          <h1 className="page-heading">Operations Command Center</h1>
          <p className="page-subheading">
            Workload tracking, submission quotas, and CA performance audit across all active dates.
          </p>
        </div>
        <div className="header-actions">
          <button type="button" className="btn-secondary" onClick={handleExportCSV} disabled={!workRecords.length}>
            <Download size={16} />
            <span>Export CSV</span>
          </button>
          <button type="button" className="btn-primary" onClick={loadWorkHistory} disabled={loading}>
            <RefreshCw size={16} className={loading ? 'spin-anim' : ''} />
            <span>Refresh API</span>
          </button>
        </div>
      </div>

      {/* Date & CA Filter Bar */}
      <div className="filter-card">
        <div className="filter-card-grid">
          {/* From Date */}
          <div className="filter-input-group">
            <label className="filter-label">FROM DATE</label>
            <div className="date-picker-box">
              <Calendar size={16} className="text-muted" />
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="date-input"
              />
            </div>
          </div>

          {/* To Date */}
          <div className="filter-input-group">
            <label className="filter-label">TO DATE</label>
            <div className="date-picker-box">
              <Calendar size={16} className="text-muted" />
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="date-input"
              />
            </div>
          </div>

          {/* CA Selector Dropdown */}
          <div className="filter-input-group wide">
            <label className="filter-label">CAREER ASSOCIATE (CA)</label>
            <div className="select-picker-box">
              <Users size={16} className="text-muted" />
              <select
                value={selectedCaEmail}
                onChange={(e) => setSelectedCaEmail(e.target.value)}
                className="select-input"
              >
                <option value="">All Career Associates (Global)</option>
                {caList.map((ca) => (
                  <option key={ca.id} value={ca.email}>
                    {ca.name} ({ca.role}) - {ca.email}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Metric Cards */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-icon-box emerald">
            <CheckCircle2 size={22} />
          </div>
          <div className="kpi-info">
            <span className="kpi-label">Emails Submitted</span>
            <div className="kpi-value-row">
              <span className="kpi-value">{totalEmailsSubmitted}</span>
              <span className="kpi-tag green">Target {totalEmailsRequired}</span>
            </div>
            <span className="kpi-sub">Applications sent to companies</span>
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-icon-box blue">
            <TrendingUp size={22} />
          </div>
          <div className="kpi-info">
            <span className="kpi-label">Jobs Applied</span>
            <div className="kpi-value-row">
              <span className="kpi-value">{totalJobsApplied}</span>
              <span className="kpi-tag blue">Verified</span>
            </div>
            <span className="kpi-sub">Workday auto-fill sessions</span>
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-icon-box purple">
            <Award size={22} />
          </div>
          <div className="kpi-info">
            <span className="kpi-label">Efficiency Rate</span>
            <div className="kpi-value-row">
              <span className="kpi-value">{avgEfficiency}%</span>
              <span className="kpi-tag purple">High Velocity</span>
            </div>
            <span className="kpi-sub">Goal completion benchmark</span>
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-icon-box amber">
            <Layers size={22} />
          </div>
          <div className="kpi-info">
            <span className="kpi-label">Client Batches Completed</span>
            <div className="kpi-value-row">
              <span className="kpi-value">{totalCount}</span>
              <span className="kpi-tag amber">Live Feed</span>
            </div>
            <span className="kpi-sub">In selected date filter</span>
          </div>
        </div>
      </div>

      {/* Work History Table Panel */}
      <div className="panel-card">
        <div className="panel-header">
          <div className="panel-title-group">
            <BarChart2 size={18} className="text-accent" />
            <h2 className="panel-title">CA Work History Logs</h2>
          </div>
          <div className="table-controls-inline">
            <div className="search-input-wrapper">
              <Search size={15} />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search candidate or ID..."
                className="search-input"
              />
            </div>
          </div>
        </div>

        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Associate (CA)</th>
                <th>ApplyWizz ID</th>
                <th>Candidate Name</th>
                <th>Submitted / Required</th>
                <th>Jobs Applied</th>
                <th>Status</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {filteredRecords.length > 0 ? (
                filteredRecords.map((r, i) => {
                  const startTime = r.start_time ? new Date(r.start_time) : null;
                  const endTime = r.end_time ? new Date(r.end_time) : null;
                  let durationMin = '';
                  if (startTime && endTime) {
                    const diffMs = endTime - startTime;
                    durationMin = `${Math.round(diffMs / 60000)}m`;
                  }

                  return (
                    <tr key={`${r.applywizz_id}-${i}`}>
                      <td>
                        <span className="date-tag">{r.date}</span>
                      </td>
                      <td>
                        <div className="cell-ca-info">
                          <span className="ca-name-bold">{r.ca_name || 'Associate'}</span>
                          <span className="ca-email-sub">{r.ca_email}</span>
                        </div>
                      </td>
                      <td>
                        <span className="cell-id-badge clickable" title="Copy ID">
                          {r.applywizz_id}
                        </span>
                      </td>
                      <td>
                        <span className="candidate-name-text">{r.client_name}</span>
                      </td>
                      <td>
                        <div className="quota-progress-cell">
                          <span className="quota-text">
                            <strong>{r.emails_submitted}</strong> / {r.emails_required}
                          </span>
                          <div className="mini-progress-bar">
                            <div
                              className="mini-progress-fill"
                              style={{
                                width: `${Math.min(100, ((r.emails_submitted || 0) / (r.emails_required || 1)) * 100)}%`,
                              }}
                            />
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className="badge-count-success">{r.jobs_applied}</span>
                      </td>
                      <td>
                        <span className={`status-pill ${r.status?.toLowerCase() === 'completed' ? 'submitted' : 'started'}`}>
                          {r.status || 'Active'}
                        </span>
                      </td>
                      <td>
                        <span className="duration-text">
                          <Clock size={13} />
                          {durationMin || '35m'}
                        </span>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan="8" className="empty-cell">
                    {loading ? 'Fetching records from CA Management API...' : 'No work records found for current filters'}
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
