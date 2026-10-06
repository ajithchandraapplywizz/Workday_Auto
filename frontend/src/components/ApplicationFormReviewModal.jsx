import React, { useState, useEffect, useMemo } from 'react';
import {
  X,
  CheckCircle,
  ExternalLink,
  Search,
  RotateCcw,
  Sparkles,
  Database,
  FileText,
  User,
  AlertCircle,
  Edit3
} from 'lucide-react';
import {
  fetchApplicationFormReviewData,
  submitApplicationReview
} from '../services/api';
import './ApplicationFormReviewModal.css';

/**
 * ApplicationFormReviewModal
 * Allows Career Associates (CAs) and Operators to review complete pre-filled form fields,
 * inspect exact resolution source badges in the top-right corner of each question
 * ([AI / LLM 🤖], [Supabase DB 💾], [Resume Facts 📄], [Identity / Profile 👤]),
 * edit answers inline, and confirm & submit directly to Supabase.
 */
export default function ApplicationFormReviewModal({
  isOpen,
  onClose,
  applywizzId,
  jobUrl,
  companyName = '',
  roleTitle = '',
  onSubmitted,
}) {
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [applicationData, setApplicationData] = useState(null);
  const [fields, setFields] = useState([]);
  const [originalFields, setOriginalFields] = useState([]);
  const [selectedStep, setSelectedStep] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [onlyRequired, setOnlyRequired] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Load form review data whenever modal is opened
  useEffect(() => {
    if (!isOpen || !applywizzId) return;

    let isMounted = true;
    async function loadData() {
      setLoading(true);
      setErrorMsg('');
      setSuccessMsg('');
      try {
        const res = await fetchApplicationFormReviewData({
          applywizzId,
          jobUrl,
        });

        if (!isMounted) return;

        if (res.success) {
          setApplicationData(res.application);
          setFields(res.fields || []);
          setOriginalFields(JSON.parse(JSON.stringify(res.fields || [])));
        } else {
          setErrorMsg(res.error || 'Failed to load form review data');
        }
      } catch (err) {
        if (isMounted) setErrorMsg(err.message || 'Error fetching application form');
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    loadData();
    return () => {
      isMounted = false;
    };
  }, [isOpen, applywizzId, jobUrl]);

  // Field edit handler
  const handleFieldChange = (fieldId, newValue) => {
    setFields((prev) =>
      prev.map((f) => {
        if (f.id === fieldId) {
          const original = originalFields.find((o) => o.id === fieldId);
          const isModified = original ? original.value !== newValue : true;
          return {
            ...f,
            value: newValue,
            isModified,
          };
        }
        return f;
      })
    );
  };

  // Revert all edits back to original
  const handleResetAll = () => {
    setFields(JSON.parse(JSON.stringify(originalFields)));
  };

  // Confirm and Submit to Supabase
  const handleConfirmSubmit = async () => {
    if (!applywizzId) return;
    setSubmitting(true);
    setErrorMsg('');
    try {
      const res = await submitApplicationReview({
        applywizzId,
        jobUrl: applicationData?.jobUrl || jobUrl,
        company: applicationData?.company || companyName,
        roleTitle: applicationData?.roleTitle || roleTitle,
        fields,
        status: 'approved_for_submission',
      });

      if (res.success) {
        setSuccessMsg('Review approved! Bot is performing final submission & capturing proof screenshot...');
        if (onSubmitted) {
          onSubmitted({
            applywizzId,
            jobUrl: applicationData?.jobUrl || jobUrl,
            fields,
            status: 'in_progress',
          });
        }
        setTimeout(() => {
          onClose();
        }, 1200);
      } else {
        setErrorMsg(res.error || 'Failed to submit application review');
      }
    } catch (err) {
      setErrorMsg(err.message || 'Error during submission');
    } finally {
      setSubmitting(false);
    }
  };

  // Available unique steps for tabs
  const stepList = useMemo(() => {
    const steps = new Set(['ALL']);
    fields.forEach((f) => {
      if (f.step) steps.add(f.step);
    });
    return Array.from(steps);
  }, [fields]);

  // Count source resolution breakdown
  const sourceStats = useMemo(() => {
    const stats = { ai: 0, supabase: 0, resume: 0, identity: 0, total: fields.length };
    fields.forEach((f) => {
      const src = f.source || 'ai';
      if (stats[src] !== undefined) {
        stats[src] += 1;
      } else {
        stats.ai += 1;
      }
    });
    return stats;
  }, [fields]);

  // Count of modified fields
  const modifiedCount = useMemo(() => {
    return fields.filter((f) => f.isModified).length;
  }, [fields]);

  // Filtered fields
  const visibleFields = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return fields.filter((f) => {
      // Step match
      if (selectedStep !== 'ALL' && f.step !== selectedStep) return false;
      // Required match
      if (onlyRequired && !f.required) return false;
      // Search match
      if (q) {
        const label = (f.label || '').toLowerCase();
        const val = String(f.value || '').toLowerCase();
        return label.includes(q) || val.includes(q);
      }
      return true;
    });
  }, [fields, selectedStep, onlyRequired, searchQuery]);

  if (!isOpen) return null;

  return (
    <div className="form-review-overlay" onClick={onClose}>
      <div className="form-review-container" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <header className="form-review-header">
          <div className="fr-header-left">
            <div className="fr-badge-row">
              <span className="fr-pill-id">{applywizzId}</span>
              <span className="fr-pill-company">
                {applicationData?.company || companyName || 'Workday Application'}
              </span>
              <span className={`fr-pill-status ${applicationData?.status || 'ready_for_review'}`}>
                {applicationData?.status || 'READY FOR REVIEW'}
              </span>
            </div>
            <h2 className="fr-modal-title">
              {applicationData?.roleTitle || roleTitle || 'Workday Application Form Review'}
            </h2>
            {(applicationData?.jobUrl || jobUrl) && (
              <a
                href={applicationData?.jobUrl || jobUrl}
                target="_blank"
                rel="noreferrer"
                className="fr-job-url-link"
                title={applicationData?.jobUrl || jobUrl}
              >
                <span>{applicationData?.jobUrl || jobUrl}</span>
                <ExternalLink size={12} />
              </a>
            )}
          </div>
          <button
            type="button"
            className="fr-close-btn"
            onClick={onClose}
            aria-label="Close modal"
          >
            <X size={20} />
          </button>
        </header>

        {/* Legend Bar with Source Resolution Breakdown */}
        <div className="fr-source-legend-bar">
          <span className="fr-legend-title">Resolution Sources:</span>
          <div className="fr-source-pills-row">
            <span className="fr-source-badge ai" title="Resolved using LLM AI Inference (Gemini/OpenRouter)">
              <Sparkles size={13} />
              <span>AI / LLM 🤖 ({sourceStats.ai})</span>
            </span>
            <span className="fr-source-badge supabase" title="Matched from verified Supabase database answers">
              <Database size={13} />
              <span>Supabase DB 💾 ({sourceStats.supabase})</span>
            </span>
            <span className="fr-source-badge resume" title="Parsed directly from candidate resume">
              <FileText size={13} />
              <span>Resume Facts 📄 ({sourceStats.resume})</span>
            </span>
            <span className="fr-source-badge identity" title="Direct from ApplyWizz candidate identity facts">
              <User size={13} />
              <span>Identity Profile 👤 ({sourceStats.identity})</span>
            </span>
          </div>
        </div>

        {/* Filter Toolbar */}
        <div className="fr-filter-bar">
          <div className="fr-step-tabs">
            {stepList.map((step) => (
              <button
                key={step}
                type="button"
                className={`fr-step-tab ${selectedStep === step ? 'active' : ''}`}
                onClick={() => setSelectedStep(step)}
              >
                {step === 'ALL' ? `All Fields (${fields.length})` : step}
              </button>
            ))}
          </div>

          <div className="fr-search-group">
            <div className="fr-search-input-wrap">
              <Search size={14} className="fr-search-icon" />
              <input
                type="text"
                placeholder="Search questions or answers..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="fr-search-input"
              />
            </div>
            <label className="fr-checkbox-label">
              <input
                type="checkbox"
                checked={onlyRequired}
                onChange={(e) => setOnlyRequired(e.target.checked)}
              />
              <span>Required Only</span>
            </label>
          </div>
        </div>

        {/* Messages */}
        {errorMsg && (
          <div style={{ padding: '0.75rem 1.75rem', background: '#4c0519', color: '#fecdd3', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <AlertCircle size={16} />
            <span>{errorMsg}</span>
          </div>
        )}
        {successMsg && (
          <div style={{ padding: '0.75rem 1.75rem', background: '#064e3b', color: '#a7f3d0', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <CheckCircle size={16} />
            <span>{successMsg}</span>
          </div>
        )}

        {/* Scrollable Form Body */}
        <div className="fr-modal-body">
          {loading ? (
            <div className="fr-state-box">
              <div className="fr-spinner" />
              <p>Hydrating pre-filled questions and answers from Supabase...</p>
            </div>
          ) : fields.length === 0 ? (
            <div className="fr-state-box" style={{ padding: '3rem 2rem', textAlign: 'center', background: '#090d16', border: '1px solid #1e293b', borderRadius: '8px', margin: '1rem' }}>
              <div style={{ fontSize: '2.5rem', marginBottom: '1rem' }}>⚡</div>
              <h3 style={{ color: '#38bdf8', marginBottom: '0.5rem', fontSize: '1.15rem' }}>Bot Filling Application in Background</h3>
              <p style={{ color: '#94a3b8', maxWidth: '520px', margin: '0 auto', fontSize: '0.88rem', lineHeight: '1.6' }}>
                Worker-1 is currently processing this application and filling Steps 1 through 4. Genuine scraped questions and answers will appear here as soon as the bot arrives at <strong>Step 5: Review & Submit</strong>.
              </p>
              <div style={{ marginTop: '1.25rem', display: 'inline-flex', alignItems: 'center', gap: '8px', background: 'rgba(56, 189, 248, 0.1)', border: '1px solid rgba(56, 189, 248, 0.25)', padding: '6px 14px', borderRadius: '20px', color: '#38bdf8', fontSize: '0.8rem' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#38bdf8', display: 'inline-block', animation: 'pulse 1.5s infinite' }} />
                <span>Execution status: {applicationData?.status ? applicationData.status.toUpperCase() : 'IN PROGRESS'}</span>
              </div>
            </div>
          ) : visibleFields.length === 0 ? (
            <div className="fr-state-box">
              <p>No questions matched your current filter.</p>
            </div>
          ) : (
            visibleFields.map((field) => (
              <div
                key={field.id}
                className={`fr-question-card ${field.isModified ? 'modified' : ''}`}
              >
                {/* Card Header: Label on Left, Source Badge in TOP RIGHT CORNER */}
                <div className="fr-card-header">
                  <div className="fr-label-group">
                    <span className="fr-step-indicator">{field.step}</span>
                    <h4 className="fr-question-label">
                      {field.label}
                      {field.required && <span className="fr-required-star">*</span>}
                    </h4>
                  </div>

                  {/* TOP-RIGHT CORNER SOURCE BADGE */}
                  <div className="fr-top-right-source">
                    {field.isModified && (
                      <span className="fr-modified-pill" title="Edited by CA in this session">
                        <Edit3 size={11} style={{ display: 'inline', marginRight: '3px' }} />
                        Modified
                      </span>
                    )}

                    {field.source === 'ai' && (
                      <span className="fr-source-tag ai" title="Answered by AI/LLM model">
                        <Sparkles size={12} />
                        <span>AI / LLM 🤖</span>
                      </span>
                    )}
                    {field.source === 'supabase' && (
                      <span className="fr-source-tag supabase" title="Answered from Supabase DB knowledge">
                        <Database size={12} />
                        <span>Supabase DB 💾</span>
                      </span>
                    )}
                    {field.source === 'resume' && (
                      <span className="fr-source-tag resume" title="Extracted from candidate resume facts">
                        <FileText size={12} />
                        <span>Resume Facts 📄</span>
                      </span>
                    )}
                    {field.source === 'identity' && (
                      <span className="fr-source-tag identity" title="Extracted from ApplyWizz identity profile">
                        <User size={12} />
                        <span>Identity Profile 👤</span>
                      </span>
                    )}
                    {field.source === 'manual' && (
                      <span className="fr-source-tag manual" title="Answered manually by Career Associate">
                        <Edit3 size={12} />
                        <span>Manual CA ✍️</span>
                      </span>
                    )}
                  </div>
                </div>

                {/* Input Field / Inline Editing */}
                <div className="fr-input-container">
                  {/* Select options if available */}
                  {field.options && field.options.length > 0 ? (
                    field.options.length <= 3 && field.options.every((o) => typeof o === 'string' && o.length < 15) ? (
                      <div className="fr-quick-options">
                        {field.options.map((opt) => (
                          <button
                            key={opt}
                            type="button"
                            className={`fr-option-btn ${String(field.value).toLowerCase() === String(opt).toLowerCase() ? 'selected' : ''}`}
                            onClick={() => handleFieldChange(field.id, opt)}
                          >
                            {opt}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <select
                        className="fr-select-input"
                        value={field.value || ''}
                        onChange={(e) => handleFieldChange(field.id, e.target.value)}
                      >
                        <option value="">-- Select an option --</option>
                        {field.options.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    )
                  ) : field.fieldType === 'textarea' || (field.value && String(field.value).length > 80) ? (
                    <textarea
                      className="fr-text-input fr-textarea-input"
                      value={field.value || ''}
                      onChange={(e) => handleFieldChange(field.id, e.target.value)}
                      placeholder="Enter answer..."
                    />
                  ) : (
                    <input
                      type="text"
                      className="fr-text-input"
                      value={field.value || ''}
                      onChange={(e) => handleFieldChange(field.id, e.target.value)}
                      placeholder="Enter answer..."
                    />
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Sticky Footer */}
        <footer className="fr-modal-footer">
          <div className="fr-footer-left">
            <span>
              Total Questions: <strong>{fields.length}</strong>
            </span>
            {modifiedCount > 0 && (
              <span className="fr-modified-count">
                <Edit3 size={13} />
                <span>{modifiedCount} answer(s) modified by CA</span>
              </span>
            )}
          </div>

          <div className="fr-footer-actions">
            {modifiedCount > 0 && (
              <button
                type="button"
                className="fr-btn-secondary"
                onClick={handleResetAll}
                disabled={submitting}
              >
                <RotateCcw size={14} style={{ display: 'inline', marginRight: '5px' }} />
                Reset Changes
              </button>
            )}

            <button
              type="button"
              className="fr-btn-secondary"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>

            <button
              type="button"
              className="fr-btn-confirm-submit"
              onClick={handleConfirmSubmit}
              disabled={submitting || loading || fields.length === 0}
            >
              <CheckCircle size={16} />
              <span>{submitting ? 'Submitting to Supabase...' : 'Confirm & Submit Application'}</span>
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
