import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { CheckCircle2, AlertCircle, ArrowRight, QrCode, Smartphone, X, Sparkles } from 'lucide-react';
import './MicrosoftAuthModal.css';

export default function MicrosoftAuthModal({ isOpen, onClose }) {
  const { loginWithCredentials, sendVerificationCode, getMfaSetupDetails } = useAuth();
  
  const [mode, setMode] = useState('signin'); // 'signin' | 'signup'
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [showQrSetup, setShowQrSetup] = useState(false);
  const [qrDetails, setQrDetails] = useState(null);

  if (!isOpen) return null;

  const handleSendCode = async (e) => {
    e?.preventDefault();
    if (!email) {
      setError('Please enter a valid work email address');
      return;
    }
    setError('');
    setLoading(true);

    try {
      const res = await sendVerificationCode({ email: email.trim().toLowerCase() });
      setCode(res.code);
      setSuccessMsg(`Verification code sent to ${email}: ${res.code}`);
      setMode('signin');
    } catch (err) {
      setError(err.message || 'Failed to send verification code');
    } finally {
      setLoading(false);
    }
  };

  const handleSignIn = async (e) => {
    e?.preventDefault();
    if (!email) {
      setError('Please enter your work email address');
      return;
    }
    if (!code || code.trim().length !== 6) {
      setError('Please enter the 6-digit verification code from Microsoft Authenticator');
      return;
    }
    setError('');
    setLoading(true);

    try {
      await loginWithCredentials({
        email: email.trim().toLowerCase(),
        code: code.trim(),
      });
      if (onClose) onClose();
    } catch (err) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const handleToggleQr = async () => {
    if (!email) {
      setError('Please enter your email address to generate the Authenticator QR code');
      return;
    }
    setError('');
    try {
      const details = await getMfaSetupDetails(email.trim().toLowerCase());
      setQrDetails(details);
      setShowQrSetup(!showQrSetup);
    } catch (err) {
      setError(err.message || 'Failed to generate QR details');
    }
  };

  return (
    <div className="ms-auth-overlay">
      <div className="ms-auth-backdrop" onClick={onClose} />

      <div className="ms-auth-container animate-fade-in">
        <div className="ms-auth-card">
          {/* Logo & Brand Header */}
          <div className="ms-brand-header">
            <div className="ms-logo-badge">
              <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
                <rect width="32" height="32" rx="8" fill="#000000" />
                <path d="M7 21L12.5 11L16 17.5L19.5 11L25 21" stroke="#00f2fe" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M12.5 21L16 14.5L19.5 21" stroke="#00ff87" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <h1 className="ms-brand-title">APPLYWIZZ</h1>
            <p className="ms-brand-subtitle">Production Secure Sign In</p>
          </div>

          {/* Toggle Pill: Sign In | Sign Up */}
          <div className="ms-tab-pill">
            <button
              type="button"
              className={`ms-tab-btn ${mode === 'signin' ? 'active' : ''}`}
              onClick={() => {
                setMode('signin');
                setError('');
              }}
            >
              Sign In
            </button>
            <button
              type="button"
              className={`ms-tab-btn ${mode === 'signup' ? 'active' : ''}`}
              onClick={() => {
                setMode('signup');
                setError('');
              }}
            >
              Sign Up
            </button>
          </div>

          {/* Error & Success Messages */}
          {error && (
            <div className="ms-banner error">
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}
          {successMsg && (
            <div className="ms-banner success">
              <CheckCircle2 size={16} />
              <span>{successMsg}</span>
            </div>
          )}

          {/* SIGN UP VIEW */}
          {mode === 'signup' ? (
            <form onSubmit={handleSendCode} className="ms-form">
              <div className="ms-field">
                <label className="ms-label">SIGN UP EMAIL ADDRESS</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="e.g. operator@applywizz.com"
                  className="ms-input"
                  required
                />
                <p className="ms-helper">
                  We'll send a 6-digit one-time verification code to this address via Azure Communication Services.
                </p>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="ms-btn ms-btn-dark"
              >
                {loading ? 'SENDING CODE...' : 'SEND VERIFICATION CODE →'}
              </button>
            </form>
          ) : (
            /* SIGN IN VIEW */
            <form onSubmit={handleSignIn} className="ms-form">
              <div className="ms-field">
                <label className="ms-label">WORK EMAIL ADDRESS</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="e.g. operator@applywizz.com"
                  className="ms-input"
                  required
                />
              </div>

              <div className="ms-field">
                <div className="ms-label-row">
                  <label className="ms-label">MICROSOFT AUTHENTICATOR 6-DIGIT CODE</label>
                  <button
                    type="button"
                    onClick={handleToggleQr}
                    style={{ background: 'none', border: 'none', color: '#38bdf8', fontSize: '0.72rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}
                  >
                    <QrCode size={13} />
                    <span>{showQrSetup ? 'Hide QR' : 'Show QR'}</span>
                  </button>
                </div>
                <input
                  type="text"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  className="ms-input ms-input-code"
                  required
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px' }}>
                  <p className="ms-helper" style={{ margin: 0 }}>
                    Enter current 6-digit rolling code from Microsoft Authenticator app
                  </p>
                </div>
              </div>

              {/* QR Code Setup Box */}
              {showQrSetup && qrDetails && (
                <div style={{ background: '#0a0f1d', border: '1px solid rgba(56, 189, 248, 0.25)', borderRadius: '10px', padding: '12px', textAlign: 'center', marginBottom: '1rem' }}>
                  <p style={{ fontSize: '0.75rem', color: '#94a3b8', margin: '0 0 8px 0' }}>
                    Scan with Microsoft Authenticator app:
                  </p>
                  <img
                    src={qrDetails.qrCodeUrl}
                    alt="Microsoft Authenticator QR"
                    style={{ width: '140px', height: '140px', background: '#fff', borderRadius: '8px', padding: '6px' }}
                  />
                  <div style={{ marginTop: '8px', fontSize: '0.72rem', color: '#38bdf8', fontFamily: 'monospace' }}>
                    Key: {qrDetails.formattedSecret}
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="ms-btn ms-btn-purple"
              >
                {loading ? 'VERIFYING CREDENTIALS...' : 'SIGN IN WITH AUTHENTICATOR →'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
