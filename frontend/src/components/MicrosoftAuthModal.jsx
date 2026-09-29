import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { CheckCircle2, AlertCircle, ArrowRight } from 'lucide-react';
import './MicrosoftAuthModal.css';

export default function MicrosoftAuthModal({ isOpen, onClose }) {
  const { loginWithAuthenticator, sendVerificationCode } = useAuth();
  
  const [mode, setMode] = useState('signin'); // 'signin' | 'signup'
  const [email, setEmail] = useState('ajithchandranimmala@applywizz.ai');
  const [code, setCode] = useState('000000');
  const [sentCode, setSentCode] = useState(null);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  const handleSendCode = async (e) => {
    e?.preventDefault();
    if (!email) {
      setError('Please enter a valid email address');
      return;
    }
    setError('');
    setLoading(true);

    try {
      const res = await sendVerificationCode({ email });
      setSentCode(res.code);
      setCode(res.code);
      setSuccessMsg(`Verification code sent via Azure Communication Services: ${res.code}`);
      setMode('signin'); // Switch to code verification
    } catch (err) {
      setError(err.message || 'Failed to send verification code');
    } finally {
      setLoading(false);
    }
  };

  const handleSignIn = async (e) => {
    e?.preventDefault();
    if (!email) {
      setError('Please enter your email address');
      return;
    }
    if (!code || code.length < 6) {
      setError('Please enter the 6-digit verification code');
      return;
    }
    setError('');
    setLoading(true);

    try {
      await loginWithAuthenticator({ email, code });
      if (onClose) onClose();
    } catch (err) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const handleQuickFill = (fillEmail) => {
    setEmail(fillEmail);
    setCode('000000');
    setError('');
    setSuccessMsg('');
  };

  return (
    <div className="ms-auth-overlay">
      <div className="ms-auth-backdrop" onClick={onClose} />

      <div className="ms-auth-container animate-fade-in">
        <div className="ms-auth-card">
          {/* Logo & Brand Header (Matching Screenshot) */}
          <div className="ms-brand-header">
            <div className="ms-logo-badge">
              <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
                <rect width="32" height="32" rx="8" fill="#000000" />
                <path d="M7 21L12.5 11L16 17.5L19.5 11L25 21" stroke="#00f2fe" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M12.5 21L16 14.5L19.5 21" stroke="#00ff87" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <h1 className="ms-brand-title">APPLYWIZZ</h1>
            <p className="ms-brand-subtitle">Operator Portal</p>
          </div>

          {/* Toggle Pill: Sign In | Sign Up (Matching Screenshot) */}
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

          {/* SIGN UP VIEW (Image 1) */}
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
            /* SIGN IN VIEW (Image 2) */
            <form onSubmit={handleSignIn} className="ms-form">
              <div className="ms-field">
                <label className="ms-label">EMAIL ADDRESS</label>
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
                  <label className="ms-label">MICROSOFT AUTHENTICATOR CODE</label>
                  <span className="ms-badge-digits">6 digits</span>
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
                <p className="ms-helper">
                  Enter the 6-digit code currently shown in your Microsoft Authenticator app.
                </p>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="ms-btn ms-btn-purple"
              >
                {loading ? 'VERIFYING...' : 'SIGN IN WITH AUTHENTICATOR →'}
              </button>
            </form>
          )}

          {/* Quick Select Preset Credentials */}
          <div className="ms-presets">
            <span className="ms-presets-title">QUICK ROLES FOR VERIFICATION:</span>
            <div className="ms-presets-grid">
              <button
                type="button"
                className="ms-preset-btn dev"
                onClick={() => handleQuickFill('ajithchandranimmala@applywizz.ai')}
              >
                Developer (Ajith)
              </button>
              <button
                type="button"
                className="ms-preset-btn manager"
                onClick={() => handleQuickFill('balaji@applywizz.ai')}
              >
                Manager (Balaji)
              </button>
              <button
                type="button"
                className="ms-preset-btn manager"
                onClick={() => handleQuickFill('ramakrishnaa.tejavath@applywizz.ai')}
              >
                Manager (Ramakrishna)
              </button>
              <button
                type="button"
                className="ms-preset-btn admin"
                onClick={() => handleQuickFill('ramakrishna@applywizz.ai')}
              >
                Admin (Ramakrishna)
              </button>
              <button
                type="button"
                className="ms-preset-btn admin"
                onClick={() => handleQuickFill('anushabandreddy@applywizz.ai')}
              >
                Admin (Anusha)
              </button>
              <button
                type="button"
                className="ms-preset-btn ca"
                onClick={() => handleQuickFill('sana@applywizz.com')}
              >
                CA (Sana)
              </button>
              <button
                type="button"
                className="ms-preset-btn ca"
                onClick={() => handleQuickFill('manasa@applywizz.com')}
              >
                CA (Manasa)
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
