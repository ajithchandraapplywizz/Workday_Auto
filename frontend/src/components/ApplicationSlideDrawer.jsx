import React, { useState, useEffect, useMemo } from 'react';
import {
  X,
  Sparkles,
  Database,
  FileText,
  User,
  CheckCircle2,
  Clock,
  AlertTriangle,
  ExternalLink,
  ChevronRight,
  ShieldCheck,
  Image as ImageIcon,
  Check,
  Send,
  Save,
  HelpCircle,
  Eye
} from 'lucide-react';
import {
  fetchApplicationFormReviewData,
  saveAnswerToQaBank,
  submitApplicationReview,
  isPersonalInfoField
} from '../services/api';
import './ApplicationSlideDrawer.css';

/**
 * ApplicationSlideDrawer
 * Smooth sliding side drawer for CAs, Admins, and Managers.
 * - Displays ONLY AI/LLM answered questions and missing/unanswered questions (excludes standard personal info).
 * - Allows CA to answer missing questions and save them directly to candidate's qa_bank.
 * - Displays "View Screenshot" button beside status badges.
 * - Allows 1-click CA Approve & Submit to trigger autonomous background submission.
 */
export default function ApplicationSlideDrawer({
  isOpen,
  onClose,
  application,
  onStatusUpdated,
  readOnly = false,
}) {
  const [loading, setLoading] = useState(false);
  const [appDetails, setAppDetails] = useState(null);
  const [fields, setFields] = useState([]);
  const [filterMode, setFilterMode] = useState('ai_only'); // 'ai_only' | 'missing_only' | 'all'
  const [submitting, setSubmitting] = useState(false);
  const [actionMessage, setActionMessage] = useState('');
  const [selectedScreenshot, setSelectedScreenshot] = useState(null);
  const [editValues, setEditValues] = useState({});
  const [savingFieldId, setSavingFieldId] = useState(null);
  const [savedSuccessIds, setSavedSuccessIds] = useState(new Set());

  // Normalize applywizz ID and job URL
  const applywizzId = application?.applywizz_id || application?.applywizzId || '';
  const jobUrl = application?.job_url || application?.jobUrl || '';
  const distributionId = application?.distributionId || application?.id || null;
  const currentStatus = application?.status || 'ready_for_review';

  useEffect(() => {
    if (!isOpen || !applywizzId || (!jobUrl && !distributionId)) return;

    let isMounted = true;
    async function loadFormDetails() {
      setLoading(true);
      setActionMessage('');
      try {
        const res = await fetchApplicationFormReviewData({
          applywizzId,
          jobUrl,
          distributionId,
        });

        if (!isMounted) return;

        if (res.success) {
          setAppDetails(res.application);
          setFields(res.fields || []);
          // Initialize edit values
          const initialEdits = {};
          for (const f of res.fields || []) {
            initialEdits[f.id] = f.value || '';
          }
          setEditValues(initialEdits);
        } else {
          // Fallback to application object properties if direct fetch returned empty
          const fallbackFields = [];
          const answers = application.resolved_answers || application.resolved_answers_json || application.pre_resolved_answers || [];
          if (Array.isArray(answers)) {
            for (const a of answers) {
              const label = a.label || a.question_raw || a.question_normalized || a.question || 'Question';
              if (isPersonalInfoField(label)) continue;
              fallbackFields.push({
                id: a.question_normalized || label || Math.random().toString(),
                label,
                questionNormalized: a.question_normalized,
                value: a.answer || a.value || '',
                source: a.tier === 4 || a.source === 'ai' || a.source === 'llm' ? 'ai' : 'supabase',
                sourceLabel: a.tier === 4 || a.source === 'ai' ? 'AI / LLM' : 'Supabase DB',
                isUnanswered: !a.answer && !a.value,
              });
            }
          }
          // Also append any unanswered questions
          const unans = Array.isArray(application.unanswered_questions) ? application.unanswered_questions : [];
          for (const u of unans) {
            const label = typeof u === 'string' ? u : (u.label || u.question || 'Unanswered');
            if (isPersonalInfoField(label)) continue;
            fallbackFields.unshift({
              id: `unans-${label}`,
              label,
              questionNormalized: label.toLowerCase().replace(/[^a-z0-9]/g, '_'),
              value: '',
              source: 'unanswered',
              sourceLabel: 'Needs CA Answer',
              isUnanswered: true,
            });
          }

          setFields(fallbackFields);
          setAppDetails({
            id: application.id,
            applywizzId,
            company: application.company || 'Workday Employer',
            roleTitle: application.role_title || application.job_title || 'Workday Application',
            jobUrl,
            status: currentStatus,
            screenshotUrl: application.screenshot_url || application.proof_screenshot_url || application.applied_screenshot || null,
          });
        }
      } catch (err) {
        console.error('Failed to load application slide drawer details:', err);
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    loadFormDetails();
    return () => { isMounted = false; };
  }, [isOpen, applywizzId, jobUrl, distributionId, currentStatus]);

  // Live polling for this specific application in job_distributions
  useEffect(() => {
    if (!isOpen || (!distributionId && (!applywizzId || !jobUrl))) return;

    let isMounted = true;
    const interval = setInterval(async () => {
      try {
        let q = supabase.from('job_distributions').select('*');
        if (distributionId) {
          q = q.eq('id', distributionId);
        } else {
          q = q.eq('applywizz_id', applywizzId).eq('job_url', jobUrl);
        }
        const { data } = await q.limit(1);
        if (!isMounted) return;
        if (data && data.length > 0) {
          const updated = data[0];
          setAppDetails((prev) => {
            return {
              ...prev,
              status: updated.status,
              screenshotUrl: updated.application_submitted_screenshot_url || null,
              application_submitted_screenshot_url: updated.application_submitted_screenshot_url || null,
            };
          });
          if (updated.status === 'submitted') {
            setActionMessage('✓ Application successfully submitted on Workday! Mandatory screenshot proof saved.');
          }
        }
      } catch (e) {
        // silent polling catch
      }
    }, 2000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [isOpen, distributionId, applywizzId, jobUrl]);

  // Missing / Unanswered Questions
  const missingFields = useMemo(() => {
    return fields.filter((f) => f.isUnanswered || !editValues[f.id] || editValues[f.id] === '');
  }, [fields, editValues]);

  // AI-answered unique questions
  const aiFields = useMemo(() => {
    return fields.filter((f) => {
      if (f.isPersonal) return false;
      const src = (f.source || '').toLowerCase();
      const label = (f.sourceLabel || '').toLowerCase();
      return src === 'ai' || src === 'llm' || label.includes('ai') || label.includes('llm') || f.tier === 4;
    });
  }, [fields]);

  // Active list of fields to display: default to AI-answered & missing questions only
  const displayedFields = useMemo(() => {
    if (filterMode === 'missing_only') {
      return missingFields;
    }
    if (filterMode === 'all') {
      return fields.filter((f) => !f.isPersonal);
    }
    // Default 'ai_only': ONLY AI-answered and missing questions for this application!
    return fields.filter((f) => {
      if (f.isPersonal) return false;
      const isMiss = f.isUnanswered || !editValues[f.id];
      const src = (f.source || '').toLowerCase();
      const label = (f.sourceLabel || '').toLowerCase();
      const isAi = src === 'ai' || src === 'llm' || label.includes('ai') || label.includes('llm') || f.tier === 4;
      return isMiss || isAi;
    });
  }, [fields, missingFields, filterMode, editValues]);

  // Handle saving an answer directly to qa_bank in Supabase
  const handleSaveToQaBank = async (field) => {
    const val = editValues[field.id];
    if (val === undefined || val === null || String(val).trim() === '') {
      setActionMessage('Please enter an answer before saving.');
      return;
    }

    setSavingFieldId(field.id);
    setActionMessage('');
    try {
      const res = await saveAnswerToQaBank({
        applywizzId,
        question: field.label,
        questionNormalized: field.questionNormalized,
        answer: String(val).trim(),
        fieldType: field.fieldType || 'input',
        source: 'manual',
        jobUrl,
        distributionId: appDetails?.id || distributionId,
      });

      if (res.success) {
        setSavedSuccessIds((prev) => new Set(prev).add(field.id));
        setActionMessage(`✓ Saved "${field.label.slice(0, 30)}..." to candidate QA Bank!`);

        // Mark field as resolved locally
        setFields((prev) =>
          prev.map((f) =>
            f.id === field.id
              ? { ...f, isUnanswered: false, source: 'qa_bank', sourceLabel: 'QA Bank (Saved)', value: val }
              : f
          )
        );

        if (onStatusUpdated) {
          onStatusUpdated({ ...application, answeredOne: true });
        }
      } else {
        setActionMessage('Error saving to QA Bank: ' + (res.error || 'Failed'));
      }
    } catch (err) {
      setActionMessage('Save error: ' + err.message);
    } finally {
      setSavingFieldId(null);
      setTimeout(() => setActionMessage(''), 5000);
    }
  };

  // Handle CA Review & Submit action
  const handleConfirmAndSubmit = async () => {
    if (!applywizzId || (!jobUrl && !distributionId)) return;
    if (missingFields.length > 0) {
      setActionMessage(`⚠️ Please answer all ${missingFields.length} missing question(s) before submitting.`);
      return;
    }
    if (submitting) return;

    setSubmitting(true);
    setActionMessage('Autonomous worker active: Submitting application on Workday...');

    // Set local status immediately so CA sees applying pulse
    setAppDetails((prev) => ({
      ...prev,
      status: 'applying',
    }));

    if (onStatusUpdated) {
      onStatusUpdated({ ...application, status: 'applying' });
    }

    try {
      // Trigger background submission
      submitApplicationReview({
        applywizzId,
        jobUrl,
        distributionId: appDetails?.id || distributionId,
        company: appDetails?.company || application?.company || 'Workday Employer',
        roleTitle: appDetails?.roleTitle || application?.role_title || 'Role',
        fields,
        status: 'approved_for_submission',
      }).catch((err) => {
        console.error('Submit review error:', err);
      });

      // Immediately close the drawer as requested!
      if (onClose) {
        onClose();
      }
    } catch (err) {
      setActionMessage('Submit failed: ' + err.message);
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  // Format Status Badge
  const effectiveStatus = (appDetails?.status || currentStatus || 'ready_for_review').toLowerCase();
  let statusBadgeClass = 'badge-review';
  let statusLabel = 'Ready For Review';
  let StatusIcon = CheckCircle2;

  if (effectiveStatus.includes('submit')) {
    statusBadgeClass = 'badge-submitted';
    statusLabel = 'Submitted';
    StatusIcon = Check;
  } else if (effectiveStatus.includes('queue')) {
    statusBadgeClass = 'badge-queued';
    statusLabel = 'Queued';
    StatusIcon = Clock;
  } else if (effectiveStatus.includes('need') || missingFields.length > 0) {
    statusBadgeClass = 'badge-needs-answers';
    statusLabel = `Needs Answers (${missingFields.length})`;
    StatusIcon = AlertTriangle;
  } else if (effectiveStatus.includes('fail') || effectiveStatus.includes('err')) {
    statusBadgeClass = 'badge-failed';
    statusLabel = 'Failed';
    StatusIcon = AlertTriangle;
  } else if (effectiveStatus.includes('flight') || effectiveStatus.includes('apply')) {
    statusBadgeClass = 'badge-applying';
    statusLabel = 'Applying';
    StatusIcon = Sparkles;
  }

  const proofShot = effectiveStatus === 'submitted'
    ? appDetails?.application_submitted_screenshot_url
      || application?.application_submitted_screenshot_url
      || null
    : null;

  return (
    <div className="slide-drawer-overlay" onClick={onClose}>
      <div className="slide-drawer-panel" onClick={(e) => e.stopPropagation()}>
        {/* Drawer Header */}
        <div className="slide-drawer-header">
          <div className="sd-header-left">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <div className={`sd-status-tag ${statusBadgeClass}`}>
                <StatusIcon size={14} />
                <span>{statusLabel.toUpperCase()}</span>
              </div>

              {/* View Screenshot button directly beside status badge */}
              {proofShot && (
                <button
                  type="button"
                  className="sd-shot-btn-prominent"
                  onClick={() => setSelectedScreenshot(proofShot)}
                  style={{
                    background: 'rgba(16, 185, 129, 0.18)',
                    borderColor: 'rgba(16, 185, 129, 0.4)',
                    color: '#34d399',
                  }}
                  title="View verified post-submission confirmation screenshot"
                >
                  <Eye size={13} />
                  <span>View Submission Proof</span>
                </button>
              )}
            </div>

            <h2 className="sd-company-title">
              {appDetails?.company || application?.company || 'Workday Employer'}
            </h2>
            <p className="sd-role-title">
              {appDetails?.roleTitle || application?.role_title || application?.job_title || 'Workday Application'}
            </p>
          </div>

          <button
            type="button"
            className="sd-close-btn"
            onClick={onClose}
            title="Close Drawer"
          >
            <X size={20} />
          </button>
        </div>

        {/* Application Metadata Strip */}
        <div className="sd-meta-strip">
          <div className="sd-meta-item">
            <span className="sd-meta-label">CANDIDATE</span>
            <span className="sd-meta-value highlight">{applywizzId}</span>
          </div>

          <div className="sd-meta-item">
            <span className="sd-meta-label">JOB LINK</span>
            <a
              href={jobUrl}
              target="_blank"
              rel="noreferrer"
              className="sd-link"
              title="Open Workday Link"
            >
              <span>Open Workday</span>
              <ExternalLink size={12} />
            </a>
          </div>

          {missingFields.length > 0 && (
            <div className="sd-meta-item">
              <span className="sd-unans-badge">
                <AlertTriangle size={12} />
                <span>{missingFields.length} Unresolved Question(s)</span>
              </span>
            </div>
          )}
        </div>

        {/* Prominent Banner for Questions Unresolved by 4-Tier Engine */}
        {missingFields.length > 0 && (
          <div style={{
            background: 'rgba(245, 158, 11, 0.12)',
            border: '1px solid rgba(245, 158, 11, 0.35)',
            borderRadius: '6px',
            padding: '10px 14px',
            margin: '0 1.25rem 0.75rem 1.25rem',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
          }}>
            <AlertTriangle size={18} style={{ color: '#fbbf24', flexShrink: 0 }} />
            <div style={{ fontSize: '0.8rem', color: '#fef3c7' }}>
              <strong>{missingFields.length} Question(s) Unresolved by 4-Tier Engine:</strong> Please enter candidate answers below and click <strong>"Save to QA Bank"</strong>. Once answered, you can approve and submit this application into the queue.
            </div>
          </div>
        )}

        {/* Filter Toggle: AI Answered Questions Only vs Missing Only vs All */}
        <div className="sd-filter-row">
          {!readOnly && (
          <div className="sd-pill-toggle">
            <button
              type="button"
              className={`sd-pill ${filterMode === 'ai_only' ? 'active' : ''}`}
              onClick={() => setFilterMode('ai_only')}
            >
              <Sparkles size={13} />
              <span>AI Answered Questions ({aiFields.length + missingFields.length})</span>
            </button>

            {missingFields.length > 0 && (
              <button
                type="button"
                className={`sd-pill pill-warning ${filterMode === 'missing_only' ? 'active' : ''}`}
                onClick={() => setFilterMode('missing_only')}
              >
                <AlertTriangle size={13} />
                <span>Needs Answer ({missingFields.length})</span>
              </button>
            )}

            <button
              type="button"
              className={`sd-pill ${filterMode === 'all' ? 'active' : ''}`}
              onClick={() => setFilterMode('all')}
            >
              <span>All Non-Personal ({fields.filter((f) => !f.isPersonal).length})</span>
            </button>
          </div>
          )}
          <span className="sd-count-note">
            Personal facts excluded
          </span>
        </div>

        {/* Content Body: Questions & Answers List */}
        <div className="slide-drawer-body">
          {/* Authentic Post-Submission Confirmation Proof Banner inside Slide Drawer */}
          {effectiveStatus === 'submitted' && (
            <div style={{
              background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.12) 0%, rgba(5, 150, 105, 0.08) 100%)',
              border: '1px solid rgba(16, 185, 129, 0.45)',
              borderRadius: '8px',
              padding: '16px',
              marginBottom: '1.25rem',
              boxShadow: '0 4px 16px rgba(16, 185, 129, 0.15)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#34d399', fontWeight: 800, fontSize: '0.88rem' }}>
                  <CheckCircle2 size={18} />
                  <span>WORKDAY SUBMISSION PROOF — MANDATORY VERIFICATION</span>
                </div>
                {proofShot && (
                  <button
                    type="button"
                    className="sd-shot-btn-prominent"
                    onClick={() => setSelectedScreenshot(proofShot)}
                    style={{
                      background: '#10b981',
                      color: '#ffffff',
                      border: 'none',
                      padding: '5px 12px',
                      borderRadius: '4px',
                      fontSize: '0.78rem',
                      fontWeight: 700,
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '5px',
                    }}
                  >
                    <Eye size={13} />
                    <span>View Full Proof</span>
                  </button>
                )}
              </div>
              <p style={{ fontSize: '0.8rem', color: '#cbd5e1', marginBottom: '10px' }}>
                Application successfully submitted on Workday by autonomous bot. The confirmation screen proof below was captured and permanently saved.
              </p>
              {proofShot ? (
                <div
                  style={{
                    borderRadius: '6px',
                    overflow: 'hidden',
                    border: '1px solid #334155',
                    maxHeight: '260px',
                    cursor: 'pointer',
                    position: 'relative',
                  }}
                  onClick={() => setSelectedScreenshot(proofShot)}
                  title="Click to view full high-resolution screenshot proof"
                >
                  <img
                    src={typeof proofShot === 'string' ? proofShot : (proofShot.url || proofShot)}
                    alt="Workday Application Proof"
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                  <div style={{
                    position: 'absolute',
                    bottom: '8px',
                    right: '8px',
                    background: 'rgba(0, 0, 0, 0.75)',
                    color: '#34d399',
                    fontSize: '0.72rem',
                    fontWeight: 700,
                    padding: '3px 8px',
                    borderRadius: '4px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                  }}>
                    <Eye size={12} />
                    <span>Click to Expand</span>
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: '0.8rem', color: '#94a3b8', fontStyle: 'italic' }}>
                  Confirmation recorded in database. Awaiting image upload...
                </div>
              )}
            </div>
          )}

          {loading ? (
            <div className="sd-loading">
              <Sparkles size={24} className="sd-spin" />
              <span>Loading unique AI question answers...</span>
            </div>
          ) : displayedFields.length === 0 ? (
            <div className="sd-empty-state">
              <Sparkles size={32} style={{ color: '#38bdf8' }} />
              <h4>No Unique AI Questions Required</h4>
              <p>All questions for this job were answered from candidate profile facts. Ready to review and submit.</p>
            </div>
          ) : (
            <div className="sd-questions-list">
              {displayedFields.map((field, idx) => {
                const currentVal = editValues[field.id] ?? field.value ?? '';
                const isMissing = field.isUnanswered || !currentVal;
                const isAi = (field.source || '').toLowerCase() === 'ai' || (field.sourceLabel || '').includes('AI') || field.tier === 4;
                const isQaBank = (field.source || '').toLowerCase() === 'qa_bank';
                const isSaved = savedSuccessIds.has(field.id);
                const isSaving = savingFieldId === field.id;

                return (
                  <div
                    key={field.id || idx}
                    className={`sd-question-card ${isMissing ? 'sd-card-unanswered' : (isAi ? 'ai-highlight' : '')}`}
                  >
                    <div className="sd-q-header">
                      <span className="sd-q-num">Q{idx + 1}</span>
                      <span className="sd-q-label">{field.label || field.question || 'Application Question'}</span>
                      {(() => {
                        if (isMissing) {
                          return (
                            <span className="sd-source-badge badge-missing">
                              <AlertTriangle size={12} />
                              <span>Needs CA Answer</span>
                            </span>
                          );
                        }
                        if (field.tier === 2 || (field.source || '').includes('resume')) {
                          return (
                            <span className="sd-source-badge badge-resume" style={{ background: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa', border: '1px solid rgba(59, 130, 246, 0.3)' }}>
                              <FileText size={12} />
                              <span>Tier 2: Resume Extraction</span>
                            </span>
                          );
                        }
                        if (field.tier === 3 || (field.source || '').includes('api')) {
                          return (
                            <span className="sd-source-badge badge-api" style={{ background: 'rgba(168, 85, 247, 0.15)', color: '#c084fc', border: '1px solid rgba(168, 85, 247, 0.3)' }}>
                              <ExternalLink size={12} />
                              <span>Tier 3: CRM API</span>
                            </span>
                          );
                        }
                        if (field.tier === 4 || (field.source || '').includes('ai') || (field.source || '').includes('llm')) {
                          return (
                            <span className="sd-source-badge badge-ai" style={{ background: 'rgba(245, 158, 11, 0.15)', color: '#fbbf24', border: '1px solid rgba(245, 158, 11, 0.3)' }}>
                              <Sparkles size={12} />
                              <span>Tier 4: AI / LLM</span>
                            </span>
                          );
                        }
                        return (
                          <span className="sd-source-badge badge-db" style={{ background: 'rgba(16, 185, 129, 0.15)', color: '#34d399', border: '1px solid rgba(16, 185, 129, 0.3)' }}>
                            <Database size={12} />
                            <span>{field.source === 'qa_bank' ? 'Tier 1: QA Bank' : 'Tier 1: Supabase DB'}</span>
                          </span>
                        );
                      })()}
                    </div>

                    {/* Interactive Answer Box */}
                    <div className="sd-q-answer-box">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span className="sd-ans-label">
                          {isMissing ? 'ENTER CANDIDATE ANSWER (SAVES TO QA BANK):' : 'AI RESOLVED ANSWER (EDITABLE):'}
                        </span>
                        {isSaved && (
                          <span style={{ fontSize: '0.72rem', color: '#34d399', fontWeight: 600 }}>
                            ✓ Saved to QA Bank
                          </span>
                        )}
                      </div>

                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        {(() => {
                          const hasOptions = Array.isArray(field.options) && field.options.length > 0;
                          const isShortOptions = hasOptions && field.options.length <= 3 && field.options.every((o) => typeof o === 'string' && o.length < 20);

                          if (isShortOptions || field.fieldType === 'radio') {
                            return (
                              <div className="sd-radio-group">
                                {hasOptions ? (
                                  field.options.map((opt) => {
                                    const optStr = String(opt);
                                    const isSelected = String(currentVal || '').trim().toLowerCase() === optStr.trim().toLowerCase();
                                    return (
                                      <button
                                        key={optStr}
                                        type="button"
                                        className={`sd-radio-pill ${isSelected ? 'selected' : ''}`}
                                        onClick={() => setEditValues((prev) => ({ ...prev, [field.id]: optStr }))}
                                        disabled
                                      >
                                        {optStr}
                                      </button>
                                    );
                                  })
                                ) : (
                                  ['Yes', 'No'].map((optStr) => {
                                    const isSelected = String(currentVal || '').trim().toLowerCase() === optStr.toLowerCase();
                                    return (
                                      <button
                                        key={optStr}
                                        type="button"
                                        className={`sd-radio-pill ${isSelected ? 'selected' : ''}`}
                                        onClick={() => setEditValues((prev) => ({ ...prev, [field.id]: optStr }))}
                                      >
                                        {optStr}
                                      </button>
                                    );
                                  })
                                )}
                              </div>
                            );
                          }

                          if (hasOptions || field.fieldType === 'dropdown' || field.fieldType === 'select') {
                            return (
                              <select
                                value={currentVal || ''}
                                disabled
                                className={`sd-select-answer ${isMissing ? 'input-missing' : ''}`}
                              >
                                <option value="">-- Select an Option --</option>
                                {(field.options || []).map((opt) => {
                                  const optStr = String(typeof opt === 'string' ? opt : (opt?.text || opt?.value || ''));
                                  return (
                                    <option key={optStr} value={optStr}>
                                      {optStr}
                                    </option>
                                  );
                                })}
                              </select>
                            );
                          }

                          if (field.fieldType === 'textarea') {
                            return (
                              <textarea
                                rows={3}
                                value={currentVal}
                                readOnly
                                placeholder="Type answer details here..."
                                className={`sd-textarea-answer ${isMissing ? 'input-missing' : ''}`}
                              />
                            );
                          }

                          return (
                            <input
                              type="text"
                              value={currentVal}
                              readOnly
                              placeholder="Type answer here (e.g. Yes, 5 years, Authorized)..."
                              className={`sd-input-answer ${isMissing ? 'input-missing' : ''}`}
                            />
                          );
                        })()}

                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Drawer Footer Actions */}
        {!readOnly && <div className="slide-drawer-footer">
          {actionMessage && (
            <div className={`sd-action-toast ${actionMessage.startsWith('✓') ? 'toast-success' : 'toast-error'}`}>
              {actionMessage}
            </div>
          )}

          <div className="sd-footer-buttons">
            <button
              type="button"
              className="sd-btn-secondary"
              onClick={onClose}
            >
              Close
            </button>

            {effectiveStatus !== 'submitted' ? (
              <button
                type="button"
                className="sd-btn-primary"
                onClick={handleConfirmAndSubmit}
                disabled={submitting || missingFields.length > 0 || effectiveStatus === 'applying'}
                style={{
                  background: (submitting || effectiveStatus === 'applying')
                    ? 'linear-gradient(135deg, #a855f7 0%, #7e22ce 100%)'
                    : (missingFields.length > 0
                      ? 'linear-gradient(135deg, #d97706 0%, #b45309 100%)'
                      : 'linear-gradient(135deg, #0284c7 0%, #0369a1 100%)'),
                  boxShadow: missingFields.length > 0
                    ? '0 4px 12px rgba(217, 119, 6, 0.35)'
                    : '0 4px 12px rgba(2, 132, 199, 0.35)',
                  cursor: (missingFields.length > 0 || submitting || effectiveStatus === 'applying') ? 'not-allowed' : 'pointer',
                  opacity: (missingFields.length > 0 || submitting || effectiveStatus === 'applying') ? 0.8 : 1,
                }}
                title={missingFields.length > 0 ? `Please answer all ${missingFields.length} missing question(s) above before submitting` : 'Review & Submit this application'}
              >
                {missingFields.length > 0 ? (
                  <AlertTriangle size={15} />
                ) : (
                  <Send size={15} />
                )}
                <span>
                  {(submitting || effectiveStatus === 'applying')
                    ? 'Applying on Workday...'
                    : (missingFields.length > 0 ? `Needs Answers (${missingFields.length})` : 'Review & Submit')}
                </span>
              </button>
            ) : proofShot ? (
              <button
                type="button"
                className="sd-btn-primary"
                onClick={() => setSelectedScreenshot(proofShot)}
                style={{
                  background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                  border: '1px solid #34d399',
                  boxShadow: '0 4px 14px rgba(16, 185, 129, 0.35)',
                }}
              >
                <ImageIcon size={15} />
                <span>Submission Screenshot</span>
              </button>
            ) : null}
          </div>
        </div>}

        {/* Modal for full screenshot viewer if opened */}
        {selectedScreenshot && (
          <div className="sd-screenshot-modal" onClick={() => setSelectedScreenshot(null)}>
            <div className="sd-modal-content" onClick={(e) => e.stopPropagation()}>
              <div className="sd-modal-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <ImageIcon size={16} style={{ color: '#34d399' }} />
                  <span>Workday Application Proof Screenshot</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  {(selectedScreenshot.url || (typeof selectedScreenshot === 'string' && selectedScreenshot.startsWith('http'))) && (
                    <a
                      href={selectedScreenshot.url || selectedScreenshot}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: '0.75rem', color: '#38bdf8', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                    >
                      <span>Open Full</span>
                      <ExternalLink size={12} />
                    </a>
                  )}
                  <button type="button" onClick={() => setSelectedScreenshot(null)}>
                    <X size={18} />
                  </button>
                </div>
              </div>

              {selectedScreenshot.isPlaceholder ? (
                <div style={{ padding: '2.5rem 1.5rem', textAlign: 'center', color: '#cbd5e1' }}>
                  <Clock size={38} style={{ color: '#f59e0b', marginBottom: '0.75rem' }} />
                  <h4 style={{ fontSize: '1.05rem', color: '#f8fafc', marginBottom: '0.5rem' }}>
                    Application Proof Screenshot Pending
                  </h4>
                  <p style={{ fontSize: '0.82rem', color: '#94a3b8', maxWidth: '440px', margin: '0 auto 1.25rem auto' }}>
                    This application for <strong>{selectedScreenshot.company || appDetails?.company || 'Workday Partner'}</strong> is in status <strong>{selectedScreenshot.status || effectiveStatus}</strong>.
                    The verified confirmation screenshot will automatically appear here once submitted.
                  </p>
                  <button
                    type="button"
                    className="sd-btn-secondary"
                    onClick={() => setSelectedScreenshot(null)}
                    style={{ padding: '6px 14px', fontSize: '0.8rem' }}
                  >
                    Close
                  </button>
                </div>
              ) : (
                <img
                  src={selectedScreenshot.url || selectedScreenshot}
                  alt="Workday Application Proof"
                  className="sd-full-shot"
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
