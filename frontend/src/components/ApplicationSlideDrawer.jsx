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
  Send
} from 'lucide-react';
import { fetchApplicationFormReviewData, submitApplicationReview } from '../services/api';
import './ApplicationSlideDrawer.css';

/**
 * ApplicationSlideDrawer
 * Smooth sliding side drawer for CAs, Admins, and Managers.
 * Replaces cumbersome popup modals with a sleek slide window.
 * Shows:
 * 1. Prominent dynamic status tag at the top (Ready For Review, Queued, Submitted, Failed).
 * 2. Clean, formatted list of unique questions answered by AI / LLM (no raw JSON!).
 * 3. Authentic applied screenshot proof if submitted.
 * 4. Inline action for CA to confirm and execute real Workday submission.
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
  const [filterMode, setFilterMode] = useState('ai_only'); // 'ai_only' | 'all'
  const [submitting, setSubmitting] = useState(false);
  const [actionMessage, setActionMessage] = useState('');
  const [selectedScreenshot, setSelectedScreenshot] = useState(null);

  // Normalize applywizz ID and job URL
  const applywizzId = application?.applywizz_id || application?.applywizzId || '';
  const jobUrl = application?.job_url || application?.jobUrl || '';
  const currentStatus = application?.status || 'ready_for_review';

  useEffect(() => {
    if (!isOpen || !applywizzId || !jobUrl) return;

    let isMounted = true;
    async function loadFormDetails() {
      setLoading(true);
      setActionMessage('');
      try {
        const res = await fetchApplicationFormReviewData({
          applywizzId,
          jobUrl,
        });

        if (!isMounted) return;

        if (res.success) {
          setAppDetails(res.application);
          setFields(res.fields || []);
        } else {
          // Fallback to application object properties if direct fetch returned empty
          const fallbackFields = [];
          const answers = application.resolved_answers || application.resolved_answers_json || application.pre_resolved_answers || [];
          if (Array.isArray(answers)) {
            for (const a of answers) {
              fallbackFields.push({
                id: a.question_normalized || a.label || Math.random().toString(),
                label: a.label || a.question_raw || a.question_normalized || 'Question',
                value: a.answer || a.value || 'Yes',
                source: a.tier === 4 || a.source === 'ai' || a.source === 'llm' ? 'ai' : 'supabase',
                sourceLabel: a.tier === 4 || a.source === 'ai' ? 'AI / LLM' : 'Supabase DB',
              });
            }
          }
          setFields(fallbackFields);
          setAppDetails({
            applywizzId,
            company: application.company || 'Workday Employer',
            roleTitle: application.role_title || application.job_title || 'Workday Application',
            jobUrl,
            status: currentStatus,
            screenshotUrl: application.applied_screenshot || application.screenshot_url || null,
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
  }, [isOpen, applywizzId, jobUrl, currentStatus]);

  // AI-answered unique questions
  const aiFields = useMemo(() => {
    return fields.filter((f) => {
      const src = (f.source || '').toLowerCase();
      const label = (f.sourceLabel || '').toLowerCase();
      return src === 'ai' || src === 'llm' || label.includes('ai') || label.includes('llm') || f.tier === 4;
    });
  }, [fields]);

  // Active list of fields to display
  const displayedFields = useMemo(() => {
    if (filterMode === 'ai_only') {
      return aiFields.length > 0 ? aiFields : fields;
    }
    return fields;
  }, [fields, aiFields, filterMode]);

  // Handle CA Review & Submit action
  const handleConfirmAndSubmit = async () => {
    if (!applywizzId || !jobUrl) return;
    setSubmitting(true);
    setActionMessage('');
    try {
      const res = await submitApplicationReview({
        applywizzId,
        jobUrl,
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
  } else if (effectiveStatus.includes('fail') || effectiveStatus.includes('err')) {
    statusBadgeClass = 'badge-failed';
    statusLabel = 'Failed';
    StatusIcon = AlertTriangle;
  } else if (effectiveStatus.includes('flight') || effectiveStatus.includes('apply')) {
    statusBadgeClass = 'badge-applying';
    statusLabel = 'Applying';
    StatusIcon = Sparkles;
  }

  const proofShot = appDetails?.appliedScreenshotUrl || appDetails?.originalScreenshotUrl || appDetails?.screenshotUrl || application?.applied_screenshot || application?.screenshot_url;

  return (
    <div className="slide-drawer-overlay" onClick={onClose}>
      <div className="slide-drawer-panel" onClick={(e) => e.stopPropagation()}>
        {/* Drawer Header */}
        <div className="slide-drawer-header">
          <div className="sd-header-left">
            <div className={`sd-status-tag ${statusBadgeClass}`}>
              <StatusIcon size={14} />
              <span>{statusLabel.toUpperCase()}</span>
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
              <span>View Job</span>
              <ExternalLink size={12} />
            </a>
          </div>
          {proofShot && (
            <div className="sd-meta-item">
              <span className="sd-meta-label">PROOF SCREENSHOT</span>
              <button
                type="button"
                className="sd-shot-btn"
                onClick={() => setSelectedScreenshot(proofShot)}
              >
                <ImageIcon size={13} />
                <span>View Proof</span>
              </button>
            </div>
          )}
        </div>

        {/* Filter Toggle: AI-Answered vs All Questions */}
        <div className="sd-filter-row">
          <div className="sd-pill-toggle">
            <button
              type="button"
              className={`sd-pill ${filterMode === 'ai_only' ? 'active' : ''}`}
              onClick={() => setFilterMode('ai_only')}
            >
              <Sparkles size={13} />
              <span>AI / LLM Answered ({aiFields.length})</span>
            </button>
            <button
              type="button"
              className={`sd-pill ${filterMode === 'all' ? 'active' : ''}`}
              onClick={() => setFilterMode('all')}
            >
              <span>All Questions ({fields.length})</span>
            </button>
          </div>

          <span className="sd-count-note">
            {displayedFields.length} unique questions resolved
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
              <FileText size={32} className="text-muted" />
              <h4>No resolved questions yet</h4>
              <p>Trigger the 3-worker bot in Developer Dashboard to scrape and resolve questions for this link.</p>
            </div>
          ) : (
            <div className="sd-questions-list">
              {displayedFields.map((field, idx) => {
                const isAi = (field.source || '').toLowerCase() === 'ai' || (field.sourceLabel || '').includes('AI') || field.tier === 4;
                const isDb = (field.source || '').toLowerCase() === 'supabase';
                const isResume = (field.source || '').toLowerCase() === 'resume';

                return (
                  <div key={field.id || idx} className={`sd-question-card ${isAi ? 'ai-highlight' : ''}`}>
                    <div className="sd-q-header">
                      <span className="sd-q-num">Q{idx + 1}</span>
                      <span className="sd-q-label">{field.label || field.question || 'Application Question'}</span>
                      <span className={`sd-source-badge ${isAi ? 'badge-ai' : (isDb ? 'badge-db' : 'badge-resume')}`}>
                        {isAi ? <Sparkles size={12} /> : (isDb ? <Database size={12} /> : <FileText size={12} />)}
                        <span>{field.sourceLabel || (isAi ? 'AI / LLM' : (isDb ? 'Supabase DB' : 'Resume'))}</span>
                      </span>
                    </div>

                    <div className="sd-q-answer-box">
                      <span className="sd-ans-label">RESOLVED ANSWER:</span>
                      <div className="sd-ans-text">
                        {typeof field.value === 'object'
                          ? JSON.stringify(field.value)
                          : String(field.value ?? 'Yes')}
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
            <div className="sd-action-toast">
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
                disabled={submitting || displayedFields.length === 0}
              >
                <Send size={15} />
                <span>{submitting ? 'Submitting...' : 'Approve & Submit'}</span>
              </button>
            )}
          </div>
        </div>

        {/* Modal for full screenshot viewer if opened */}
        {selectedScreenshot && (
          <div className="sd-screenshot-modal" onClick={() => setSelectedScreenshot(null)}>
            <div className="sd-modal-content" onClick={(e) => e.stopPropagation()}>
              <div className="sd-modal-header">
                <span>Proof Confirmation Screenshot</span>
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
