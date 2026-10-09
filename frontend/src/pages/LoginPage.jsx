import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  ShieldCheck,
  Mail,
  KeyRound,
  ArrowRight,
  Zap,
  CheckCircle2,
  AlertCircle,
  QrCode,
  Smartphone,
  Copy,
  Check,
  X,
  Layers,
  Sparkles,
} from 'lucide-react';
import './LoginPage.css';

export default function LoginPage() {
  const { loginWithCredentials, sendVerificationCode, getMfaSetupDetails } = useAuth();

  const [mode, setMode] = useState('signin'); // 'signin' | 'signup'
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Microsoft Authenticator QR Code Setup Modal state
  const [showMfaModal, setShowMfaModal] = useState(false);
  const [mfaDetails, setMfaDetails] = useState(null);
  const [mfaLoading, setMfaLoading] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);

  // Handle Send 2FA Code via Azure/Email
  const handleSendCode = async () => {
    if (!email || !email.includes('@')) {
      setError('Please enter a valid work email address first');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const res = await sendVerificationCode({ email: email.trim().toLowerCase() });
      setCode(res.code || '');
      setSuccessMsg(`Verification code dispatched to ${email}: ${res.code}`);
    } catch (err) {
      setError(err?.message || 'Failed to dispatch verification code');
    } finally {
      setLoading(false);
    }
  };

  // Open Microsoft Authenticator Setup Modal
  const handleOpenMfaSetup = async () => {
    if (!email || !email.includes('@')) {
      setError('Please enter your work email address first to generate your Microsoft Authenticator QR code');
      return;
    }
    setError('');
    setMfaLoading(true);
    try {
      const details = await getMfaSetupDetails(email.trim().toLowerCase());
      setMfaDetails(details);
      setShowMfaModal(true);
    } catch (err) {
      setError(err?.message || 'Failed to generate Microsoft Authenticator details');
    } finally {
      setMfaLoading(false);
    }
  };

  // Copy secret key
  const handleCopySecret = () => {
    if (mfaDetails?.secret) {
      navigator.clipboard.writeText(mfaDetails.secret);
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 3000);
    }
  };

  // Handle Form Submission
  const handleSubmit = async (e) => {
    if (e) e.preventDefault();
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      setError('Please provide a valid ApplyWizz work email');
      return;
    }
    if (!code || code.trim().length !== 6) {
      setError('Please provide the 6-digit Microsoft Authenticator code');
      return;
    }

    setError('');
    setLoading(true);

    try {
      await loginWithCredentials({
        email: cleanEmail,
        code: code.trim(),
      });
    } catch (err) {
      setError(err?.message || 'Authentication failed. Please verify credentials.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page-root">
      <div className="login-ambient-glow top-left" />
      <div className="login-ambient-glow bottom-right" />

      <div className="login-container">
        {/* Left Hero Pane */}
        <div className="login-hero-pane">
          <div>
            <div className="hero-brand-badge">
              <Zap size={14} />
              <span>ApplyWizz Autonomous Engine</span>
            </div>

            <h1 className="hero-title">
              Workday <span className="hero-gradient-text">Auto-Apply</span> Suite
            </h1>

            <p className="hero-description">
              Enterprise automation portal orchestrating link-clustered fair-share job applications,
              real-time DOM self-healing, and multi-tier candidate answer resolution.
            </p>

            <div className="hero-features-list">
              <div className="hero-feature-item">
                <div className="hero-feature-icon">
                  <ShieldCheck size={18} />
                </div>
                <div className="hero-feature-text">
                  <h4>Microsoft Authenticator 2FA</h4>
                  <p>Azure RFC 6238 time-based one-time password security.</p>
                </div>
              </div>

              <div className="hero-feature-item">
                <div className="hero-feature-icon">
                  <Layers size={18} />
                </div>
                <div className="hero-feature-text">
                  <h4>Role-Based Access Control</h4>
                  <p>Automatic identity routing for Developer, Admin, Manager, and Career Associates.</p>
                </div>
              </div>

              <div className="hero-feature-item">
                <div className="hero-feature-icon">
                  <Mail size={18} />
                </div>
                <div className="hero-feature-text">
                  <h4>Live Daily Work History</h4>
                  <p>Immediate retrieval and allotment display of assigned client queues on login.</p>
                </div>
              </div>
            </div>
          </div>

          <div className="hero-footer-status">
            <div className="status-indicator">
              <span className="pulse-dot" />
              <span>Pipeline Daemon Active</span>
            </div>
            <span>v2.4 Enterprise Production Build</span>
          </div>
        </div>

        {/* Right Form Pane */}
        <div className="login-form-pane">
          <div className="login-form-header">
            <h2 className="form-title">{mode === 'signin' ? 'Sign In' : 'Create Account'}</h2>
            <p className="form-subtitle">
              {mode === 'signin'
                ? 'Sign in with your official ApplyWizz email and Microsoft Authenticator'
                : 'Register a new user profile with Microsoft 2FA security'}
            </p>
          </div>

          {/* Mode Switcher */}
          <div className="auth-mode-switcher">
            <button
              type="button"
              className={`auth-tab-btn ${mode === 'signin' ? 'active' : ''}`}
              onClick={() => {
                setMode('signin');
                setError('');
                setSuccessMsg('');
              }}
            >
              Sign In
            </button>
            <button
              type="button"
              className={`auth-tab-btn ${mode === 'signup' ? 'active' : ''}`}
              onClick={() => {
                setMode('signup');
                setError('');
                setSuccessMsg('');
              }}
            >
              Sign Up
            </button>
          </div>

          {/* Error / Success Alerts */}
          {error && (
            <div className="auth-msg-box error">
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}

          {successMsg && (
            <div className="auth-msg-box success">
              <CheckCircle2 size={16} />
              <span>{successMsg}</span>
            </div>
          )}

          {/* Main Form */}
          <form onSubmit={handleSubmit}>
            {/* 1. Work Email */}
            <div className="form-group">
              <label className="form-label" htmlFor="login-email">
                WORK EMAIL ADDRESS / USERNAME
              </label>
              <div className="input-with-icon">
                <Mail size={16} className="input-icon" />
                <input
                  id="login-email"
                  type="email"
                  className="form-input"
                  placeholder="name@applywizz.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={loading}
                  autoComplete="email"
                  required
                />
              </div>
            </div>

            {/* 2. Microsoft Authenticator 6-Digit Code */}
            <div className="form-group">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <label className="form-label" htmlFor="login-code" style={{ marginBottom: 0 }}>
                  MICROSOFT AUTHENTICATOR 6-DIGIT CODE
                </label>
                <button
                  type="button"
                  className="setup-mfa-link-btn"
                  onClick={handleOpenMfaSetup}
                  disabled={loading || mfaLoading}
                  title="Scan QR Code in Microsoft Authenticator app"
                >
                  <QrCode size={13} />
                  <span>Set Up Authenticator (QR)</span>
                </button>
              </div>
              <div className="input-with-icon">
                <KeyRound size={16} className="input-icon" />
                <input
                  id="login-code"
                  type="text"
                  maxLength={6}
                  className="form-input code-input"
                  placeholder="000000"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  disabled={loading}
                  required
                />
              </div>
              <div className="code-action-row">
                <button
                  type="button"
                  className="btn-ghost-sm"
                  onClick={handleSendCode}
                  disabled={loading || !email}
                >
                  Send One-Time Email Code
                </button>
                <button
                  type="button"
                  className="btn-ghost-sm"
                  style={{ color: '#38bdf8', borderColor: 'rgba(56, 189, 248, 0.3)' }}
                  onClick={handleOpenMfaSetup}
                  disabled={mfaLoading || !email}
                  title="Scan QR Code in Microsoft Authenticator app on your phone"
                >
                  <QrCode size={12} style={{ display: 'inline', marginRight: '4px' }} />
                  Setup Microsoft Authenticator
                </button>
              </div>
            </div>

            <button
              type="submit"
              className="btn-submit-main"
              disabled={loading}
            >
              {loading ? (
                <span>Verifying & Synchronizing Session...</span>
              ) : (
                <>
                  <span>{mode === 'signin' ? 'Enter Workday Suite' : 'Register Profile'}</span>
                  <ArrowRight size={16} />
                </>
              )}
            </button>
          </form>
        </div>
      </div>

      {/* Microsoft Authenticator QR Code Modal */}
      {showMfaModal && mfaDetails && (
        <div className="mfa-modal-overlay">
          <div className="mfa-modal-backdrop" onClick={() => setShowMfaModal(false)} />
          <div className="mfa-modal-card animate-fade-in">
            <div className="mfa-modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Smartphone size={20} color="#38bdf8" />
                <h3 className="mfa-modal-title">Set Up Microsoft Authenticator</h3>
              </div>
              <button
                type="button"
                className="mfa-modal-close"
                onClick={() => setShowMfaModal(false)}
              >
                <X size={18} />
              </button>
            </div>

            <div className="mfa-modal-body">
              <p className="mfa-modal-instructions">
                1. Open <strong>Microsoft Authenticator</strong> on your phone.<br />
                2. Tap <strong>+</strong> &rarr; <strong>Work or school account</strong> &rarr; <strong>Scan QR code</strong>.<br />
                3. Scan this QR code:
              </p>

              <div className="mfa-qr-container">
                <img
                  src={mfaDetails.qrCodeUrl}
                  alt="Microsoft Authenticator QR Code"
                  className="mfa-qr-image"
                />
              </div>

              <div className="mfa-manual-key-box">
                <span className="mfa-manual-label">MANUAL ENTRY KEY:</span>
                <div className="mfa-key-display">
                  <code>{mfaDetails.formattedSecret}</code>
                  <button
                    type="button"
                    className="mfa-copy-btn"
                    onClick={handleCopySecret}
                    title="Copy Secret Key"
                  >
                    {copiedKey ? <Check size={14} color="#10b981" /> : <Copy size={14} />}
                    <span>{copiedKey ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
              </div>

              <p className="mfa-modal-instructions" style={{ marginTop: '12px' }}>
                4. Enter the 6-digit code shown in Microsoft Authenticator into the login form.
              </p>
            </div>

            <div className="mfa-modal-footer">
              <button
                type="button"
                className="btn-submit-main"
                style={{ width: '100%' }}
                onClick={() => setShowMfaModal(false)}
              >
                Done Scanning &rarr; Enter 6-Digit Code
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
