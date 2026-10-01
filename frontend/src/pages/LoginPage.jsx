import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  ShieldCheck,
  Mail,
  KeyRound,
  ArrowRight,
  Zap,
  Users,
  Briefcase,
  AlertCircle,
  CheckCircle2,
  Lock,
  Cpu,
  Layers,
} from 'lucide-react';
import './LoginPage.css';

const SPEED_PRESETS = [
  {
    role: 'dev',
    title: 'Developer',
    email: 'ajithchandranimmala@applywizz.ai',
    subtitle: 'System Health & Pipeline Audit',
    icon: Cpu,
  },
  {
    role: 'admin',
    title: 'Super Admin',
    email: 'admin@applywizz.ai',
    subtitle: 'Full Org & Allocation Control',
    icon: ShieldCheck,
  },
  {
    role: 'manager',
    title: 'Manager (Balaji)',
    email: 'balaji@applywizz.com',
    subtitle: 'Team Isolation & Performance',
    icon: Briefcase,
  },
  {
    role: 'operator',
    title: 'CA (Sana)',
    email: 'sana@applywizz.com',
    subtitle: 'Live Workday Portal & Client Queue',
    icon: Users,
  },
  {
    role: 'operator',
    title: 'CA (Manasa)',
    email: 'manasa@applywizz.com',
    subtitle: 'Live Workday Portal & Client Queue',
    icon: Users,
  },
  {
    role: 'operator',
    title: 'CA (Alekhya)',
    email: 'alekhyaashangari@applywizz.ai',
    subtitle: 'Live Workday Portal & Client Queue',
    icon: Users,
  },
];

export default function LoginPage() {
  const { loginWithAuthenticator, sendVerificationCode } = useAuth();

  const [mode, setMode] = useState('signin'); // 'signin' | 'signup'
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('000000');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Handle Send 2FA Code via Azure
  const handleSendCode = async () => {
    if (!email || !email.includes('@')) {
      setError('Please enter a valid work email address');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const res = await sendVerificationCode({ email: email.trim().toLowerCase() });
      setCode(res.code || '000000');
      setSuccessMsg(`Microsoft 2FA code generated: ${res.code || '000000'}`);
    } catch (err) {
      setError(err?.message || 'Failed to dispatch verification code');
    } finally {
      setLoading(false);
    }
  };

  // Handle Form Submission
  const handleSubmit = async (e) => {
    if (e) e.preventDefault();
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      setError('Please provide a valid ApplyWizz email');
      return;
    }
    if (!code || code.trim().length < 6) {
      setError('Please provide the 6-digit Authenticator code');
      return;
    }

    setError('');
    setLoading(true);

    try {
      await loginWithAuthenticator({ email: cleanEmail, code: code.trim() });
    } catch (err) {
      setError(err?.message || 'Authentication failed. Please check credentials.');
    } finally {
      setLoading(false);
    }
  };

  // Speed Mode 1-Click Fast Login
  const handleSpeedLogin = async (preset) => {
    setEmail(preset.email);
    setCode('000000');
    setError('');
    setLoading(true);
    try {
      await loginWithAuthenticator({ email: preset.email, code: '000000' });
    } catch (err) {
      setError(err?.message || `Failed to sign in as ${preset.title}`);
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
                  <p>Enterprise single sign-on with Azure security standards.</p>
                </div>
              </div>

              <div className="hero-feature-item">
                <div className="hero-feature-icon">
                  <Layers size={18} />
                </div>
                <div className="hero-feature-text">
                  <h4>4-Tier Answer Engine</h4>
                  <p>Supabase Cache &rarr; ApplyWizz CRM &rarr; Resume Facts &rarr; LLM Resolver.</p>
                </div>
              </div>

              <div className="hero-feature-item">
                <div className="hero-feature-icon">
                  <Mail size={18} />
                </div>
                <div className="hero-feature-text">
                  <h4>Zoho Mail Integration</h4>
                  <p>Direct verification & password reset across configured candidate mailboxes.</p>
                </div>
              </div>
            </div>
          </div>

          <div className="hero-footer-status">
            <div className="status-indicator">
              <span className="pulse-dot" />
              <span>Pipeline Daemon Active</span>
            </div>
            <span>v2.4 Enterprise Build</span>
          </div>
        </div>

        {/* Right Form Pane */}
        <div className="login-form-pane">
          <div className="login-form-header">
            <h2 className="form-title">{mode === 'signin' ? 'Sign In' : 'Create Account'}</h2>
            <p className="form-subtitle">
              {mode === 'signin'
                ? 'Access your role dashboard using your official credentials'
                : 'Register a new operator profile with Microsoft 2FA'}
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
            <div className="form-group">
              <label className="form-label" htmlFor="login-email">
                WORK EMAIL ADDRESS
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

            <div className="form-group">
              <label className="form-label" htmlFor="login-code">
                MICROSOFT AUTHENTICATOR 6-DIGIT CODE
              </label>
              <div className="input-with-icon">
                <KeyRound size={16} className="input-icon" />
                <input
                  id="login-code"
                  type="text"
                  maxLength={6}
                  className="form-input"
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
                  Send 2FA Code
                </button>
                <button
                  type="button"
                  className="btn-ghost-sm"
                  onClick={() => setCode('000000')}
                >
                  Demo Bypass (000000)
                </button>
              </div>
            </div>

            <button
              type="submit"
              className="btn-submit-main"
              disabled={loading}
            >
              {loading ? (
                <span>Authenticating Session...</span>
              ) : (
                <>
                  <span>{mode === 'signin' ? 'Enter Workday Suite' : 'Register Profile'}</span>
                  <ArrowRight size={16} />
                </>
              )}
            </button>
          </form>

          {/* Speed Mode / Quick Role Switcher Chips */}
          <div className="quick-switcher-section">
            <div className="quick-switcher-title">
              <span>⚡ Speed Mode: Instant 1-Click Launch</span>
            </div>
            <div className="quick-role-chips">
              {SPEED_PRESETS.map((preset) => (
                <button
                  key={preset.email}
                  type="button"
                  className="role-chip-btn"
                  onClick={() => handleSpeedLogin(preset)}
                  disabled={loading}
                  title={`Sign in immediately as ${preset.title}`}
                >
                  <span className="role-chip-name">{preset.title}</span>
                  <span className="role-chip-desc">{preset.email.split('@')[0]}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
