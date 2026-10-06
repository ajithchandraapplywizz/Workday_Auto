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
}) {
  const [loading, setLoading] = useState(false);
  const [appDetails, setAppDetails] = useState(null);
  const [fields, setFields] = useState([]);
  const [filterMode, setFilterMode] = useState('ai_and_missing'); // 'ai_and_missing' | 'missing_only' | 'all'
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

  // Missing / Unanswered Questions
  const missingFields = useMemo(() => {
    return fields.filter((f) => f.isUnanswered || !editValues[f.id] || editValues[f.id] === '');
  }, [fields, editValues]);

  // AI-answered unique questions
  const aiFields = useMemo(() => {
    return fields.filter((f) => {
      const src = (f.source || '').toLowerCase();
      const label = (f.sourceLabel || '').toLowerCase();
      return src === 'ai' || src === 'llm' || label.includes('ai') || label.includes('llm') || f.tier === 4;
    });
  }, [fields]);

  // Active list of fields to display based on tab filter
  const displayedFields = useMemo(() => {
    if (filterMode === 'missing_only') {
      return missingFields;
    }
    if (filterMode === 'ai_and_missing') {
      // Show missing questions FIRST, then AI-answered questions
      return fields.filter((f) => {
        const isMiss = f.isUnanswered || !editValues[f.id];
        const isAi = (f.source || '').toLowerCase() === 'ai' || (f.sourceLabel || '').includes('AI') || f.tier === 4;
        return isMiss || isAi;
      });
    }
    return fields;
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
    if (!applywizzId || !jobUrl) return;
    setSubmitting(true);
    setActionMessage('');
    try {
      const res = await submitApplicationReview({
        applywizzId,
        jobUrl,
        distributionId: appDetails?.id || distributionId,
        company: appDetails?.company || application?.company || 'Workday Employer',
        roleTitle: appDetails?.roleTitle || application?.role_title || 'Role',
        fields,
        status: 'approved_for_submission',
      });

      if (res.success) {
        setActionMessage('✓ Approved & Queued for instant 3-worker submission!');
        if (onStatusUpdated) {
          onStatusUpdated({ ...application, status: 'queued' });
        }
      } else {
        setActionMessage('Error: ' + (res.error || 'Failed to submit'));
      }
    } catch (err) {
      setActionMessage('Submit failed: ' + err.message);
    } finally {
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

  const proofShot = appDetails?.screenshotUrl || application?.screenshot_url || application?.proof_screenshot_url || application?.applied_screenshot;

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
                  title="View Verified Application Screenshot"
                >
                  <Eye size={13} />
                  <span>View Screenshot</span>
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
                <span>{missingFields.length} Unanswered Question(s)</span>
              </span>
            </div>
          )}
        </div>

        {/* Filter Toggle: AI & Missing vs Missing Only vs All */}
        <div className="sd-filter-row">
          <div className="sd-pill-toggle">
            <button
              type="button"
              className={`sd-pill ${filterMode === 'ai_and_missing' ? 'active' : ''}`}
              onClick={() => setFilterMode('ai_and_missing')}
            >
              <Sparkles size={13} />
              <span>AI &amp; Missing ({missingFields.length + aiFields.length})</span>
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
              <span>All Non-Personal ({fields.length})</span>
            </button>
          </div>

          <span className="sd-count-note">
            Personal facts excluded
          </span>
        </div>

        {/* Content Body: Questions & Answers List */}
        <div className="slide-drawer-body">
          {loading ? (
            <div className="sd-loading">
              <Sparkles size={24} className="sd-spin" />
              <span>Loading resolved question answers...</span>
            </div>
          ) : displayedFields.length === 0 ? (
            <div className="sd-empty-state">
              <CheckCircle2 size={32} style={{ color: '#34d399' }} />
              <h4>All Questions Complete!</h4>
              <p>No missing or AI questions pending review. Ready for autonomous submission.</p>
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
                      <span className={`sd-source-badge ${isMissing ? 'badge-missing' : (isAi ? 'badge-ai' : 'badge-db')}`}>
                        {isMissing ? <AlertTriangle size={12} /> : (isAi ? <Sparkles size={12} /> : <Database size={12} />)}
                        <span>{isMissing ? 'Needs CA Answer' : (isAi ? 'AI / LLM Answered' : (isQaBank ? 'QA Bank' : 'Supabase DB'))}</span>
                      </span>
                    </div>

                    {/* Interactive Answer Box */}
                    <div className="sd-q-answer-box">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span className="sd-ans-label">
                          {isMissing ? 'ENTER CANDIDATE ANSWER (SAVES TO QA BANK):' : 'RESOLVED ANSWER (EDITABLE):'}
                        </span>
                        {isSaved && (
                          <span style={{ fontSize: '0.72rem', color: '#34d399', fontWeight: 600 }}>
                            ✓ Saved to QA Bank
                          </span>
                        )}
                      </div>

                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <input
                          type="text"
                          value={currentVal}
                          onChange={(e) => {
                            const v = e.target.value;
                            setEditValues((prev) => ({ ...prev, [field.id]: v }));
                          }}
                          placeholder="Type answer here (e.g. Yes, 5 years, Authorized)..."
                          className={`sd-input-answer ${isMissing ? 'input-missing' : ''}`}
                        />

                        <button
                          type="button"
                          className="sd-save-btn"
                          onClick={() => handleSaveToQaBank(field)}
                          disabled={isSaving || !currentVal}
                          title="Save this answer directly to candidate QA Bank in Supabase"
                        >
                          <Save size={13} />
                          <span>{isSaving ? 'Saving...' : 'Save to QA Bank'}</span>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Drawer Footer Actions */}
        <div className="slide-drawer-footer">
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

            {effectiveStatus !== 'submitted' && (
              <button
                type="button"
                className="sd-btn-primary"
                onClick={handleConfirmAndSubmit}
                disabled={submitting || missingFields.length > 0}
                title={missingFields.length > 0 ? 'Please fill missing answers before approving' : 'Approve for 3-worker submission'}
              >
                <Send size={15} />
                <span>
                  {submitting
                    ? 'Submitting...'
                    : (missingFields.length > 0 ? `Fill ${missingFields.length} Missing Answers` : 'Approve & Submit')}
                </span>
              </button>
            )}
          </div>
        </div>

        {/* Modal for full screenshot viewer if opened */}
        {selectedScreenshot && (
          <div className="sd-screenshot-modal" onClick={() => setSelectedScreenshot(null)}>
            <div className="sd-modal-content" onClick={(e) => e.stopPropagation()}>
              <div className="sd-modal-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <ImageIcon size={16} style={{ color: '#34d399' }} />
                  <span>Workday Application Proof Screenshot</span>
                </div>
                <button type="button" onClick={() => setSelectedScreenshot(null)}>
                  <X size={18} />
                </button>
              </div>
              <img src={selectedScreenshot} alt="Workday Application Proof" className="sd-full-shot" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
