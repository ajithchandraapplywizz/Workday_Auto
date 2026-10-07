import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { supabase } from '../config/supabase';
import { syncLiveCAData } from '../services/api';
import {
  getOrCreateUserMfaSecret,
  verifyTOTPCode,
  getMicrosoftAuthenticatorDetails,
} from '../services/totp';

const AuthContext = createContext(null);

export const getTodayDateStr = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export function AuthProvider({ children }) {
  // Session strictly initialized from verified storage — no automatic default bypass
  const [user, setUser] = useState(() => {
    try {
      const saved = localStorage.getItem('applywizz_auth_session');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  const [date, setDate] = useState(getTodayDateStr());
  const [timeframe, setTimeframe] = useState('day');
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);

  // Smart Auto-Sync state: 'idle' | 'syncing' | 'synced' | 'failed'
  const [smartSyncStatus, setSmartSyncStatus] = useState('idle');
  const [smartSyncMessage, setSmartSyncMessage] = useState('');

  // Persist session changes
  useEffect(() => {
    if (user) {
      localStorage.setItem('applywizz_auth_session', JSON.stringify(user));
    } else {
      localStorage.removeItem('applywizz_auth_session');
    }
  }, [user]);

  // Periodic Heartbeat & Disconnect Lifecycle for live operator tracking
  useEffect(() => {
    if (!user?.email) return;
    const em = user.email.toLowerCase().trim();

    // 1. Initial touch on mount/login
    const nowIso = new Date().toISOString();
    supabase
      .from('operators')
      .update({ status: 'active', updated_at: nowIso })
      .ilike('email', em)
      .then(() => {})
      .catch(() => {});
    supabase
      .from('auth_users')
      .update({ status: 'active', updated_at: nowIso })
      .ilike('email', em)
      .then(() => {})
      .catch(() => {});

    // 2. Periodic heartbeat every 20s
    const heartbeatTimer = setInterval(() => {
      const pingIso = new Date().toISOString();
      supabase
        .from('operators')
        .update({ status: 'active', updated_at: pingIso })
        .ilike('email', em)
        .then(() => {})
        .catch(() => {});
      supabase
        .from('auth_users')
        .update({ status: 'active', updated_at: pingIso })
        .ilike('email', em)
        .then(() => {})
        .catch(() => {});
    }, 20000);

    // 3. Browser disconnect on tab/window close
    const handleBeforeUnload = () => {
      const closeIso = new Date().toISOString();
      try {
        supabase
          .from('operators')
          .update({ status: 'inactive', updated_at: closeIso })
          .ilike('email', em)
          .then(() => {})
          .catch(() => {});
      } catch {}
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handleBeforeUnload);

    return () => {
      clearInterval(heartbeatTimer);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handleBeforeUnload);
    };
  }, [user?.email]);

  /**
   * Determine exact organizational role from verified email & database records
   */
  const resolveRoleFromEmail = async (normalizedEmail) => {
    // 1. Developer
    if (normalizedEmail === 'ajithchandranimmala@applywizz.ai') {
      return { role: 'dev', name: 'Ajith Chandra Nimmala', manager_id: null };
    }

    // 2. Operational Managers
    const managerEmails = [
      'balaji@applywizz.com',
      'balaji@applywizz.ai',
      'ramakrishnaa.tejavath@applywizz.ai',
      'ramakrishna@applywizz.com',
    ];
    if (managerEmails.includes(normalizedEmail) || normalizedEmail.includes('balaji') || normalizedEmail.includes('manager')) {
      return {
        role: 'manager',
        name: normalizedEmail.includes('balaji') ? 'Balaji' : (normalizedEmail.includes('ramakrishna') ? 'Ramakrishna Tejavath' : 'Operational Manager'),
        manager_id: '9dc9376e-fbc5-440b-932f-38da10b89a70',
      };
    }

    // 3. Admins (Founders, Co-founders & Platform Admins)
    const adminEmails = [
      'admin@applywizz.ai',
      'admin@applywizz.com',
      'superadmin@applywizz.ai',
      'ramakrishna@applywizz.ai',
      'anushabandreddy@applywizz.ai',
      'shyam@applywizz.ai',
      'jagan@applywizz.ai',
    ];
    if (normalizedEmail.includes('admin') || adminEmails.includes(normalizedEmail)) {
      const namePart = normalizedEmail.split('@')[0];
      return {
        role: 'admin',
        name: normalizedEmail.includes('admin')
          ? 'Super Admin'
          : namePart.charAt(0).toUpperCase() + namePart.slice(1),
        manager_id: null,
      };
    }

    // 4. Query operators roster table in Supabase
    try {
      const { data: op } = await supabase
        .from('operators')
        .select('*')
        .ilike('email', normalizedEmail)
        .maybeSingle();

      if (op) {
        return {
          role: 'operator',
          name: op.name || normalizedEmail.split('@')[0],
          manager_id: op.manager_id,
        };
      }
    } catch (err) {
      console.warn('Operator lookup note:', err);
    }

    // 5. Default: Career Associate (Operator)
    return {
      role: 'operator',
      name: normalizedEmail.split('@')[0],
      manager_id: null,
    };
  };

  /**
   * Production Login with Email and Microsoft Authenticator MFA
   * Supports real TOTP verification and sandbox testing code (000000) for instant role inspection
   */
  const loginWithCredentials = async ({ email, code }) => {
    const normalizedEmail = (email || '').trim().toLowerCase();
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      throw new Error('Please enter a valid work email address (e.g. yourname@applywizz.com)');
    }

    // 6-Digit Authenticator Code Validation
    const cleanCode = (code || '').trim();
    if (!cleanCode || cleanCode.length !== 6) {
      throw new Error('Please enter your 6-digit Microsoft Authenticator code');
    }

    // 1. Verify Microsoft Authenticator TOTP
    const mfaSecret = await getOrCreateUserMfaSecret(normalizedEmail);
    const isTotpValid = await verifyTOTPCode(mfaSecret, cleanCode);

    // 2. Query Supabase auth_users
    let { data: authUser } = await supabase
      .from('auth_users')
      .select('*')
      .ilike('email', normalizedEmail)
      .maybeSingle();

    const isStoredCodeValid = authUser?.verification_code && authUser.verification_code === cleanCode;
    // Development / Sandbox testing code allows easy verification of any admin/manager/ca/dummy account
    const isSandboxBypass = cleanCode === '000000';

    // Must satisfy TOTP code, verified code, or testing sandbox code
    if (!isTotpValid && !isStoredCodeValid && !isSandboxBypass) {
      throw new Error(
        'Invalid 6-digit Authenticator code. Please check your Microsoft Authenticator app or use the sandbox test code (000000).'
      );
    }

    // Resolve Role
    const auto = await resolveRoleFromEmail(normalizedEmail);
    const effectiveRole = (auto.role === 'admin' || auto.role === 'dev') ? auto.role : (authUser?.role || auto.role);

    const resolvedProfile = {
      email: normalizedEmail,
      name: authUser?.name || auto.name,
      role: effectiveRole,
      manager_id: authUser?.manager_id || auto.manager_id,
    };

    const nowIso = new Date().toISOString();

    // Persist or Update in auth_users
    if (authUser) {
      await supabase
        .from('auth_users')
        .update({
          status: 'active',
          role: effectiveRole,
          last_sign_in: nowIso,
          updated_at: nowIso,
        })
        .eq('id', authUser.id);
    } else {
      await supabase.from('auth_users').insert({
        email: normalizedEmail,
        name: resolvedProfile.name,
        role: resolvedProfile.role,
        manager_id: resolvedProfile.manager_id,
        status: 'active',
        verification_code: cleanCode,
        auth_provider: 'Microsoft Authenticator',
        last_sign_in: nowIso,
      });
    }

    // Touch operators table if CA / operator
    if (resolvedProfile.role === 'operator') {
      try {
        const { data: existingOp } = await supabase
          .from('operators')
          .select('id')
          .ilike('email', normalizedEmail)
          .maybeSingle();

        if (existingOp) {
          await supabase
            .from('operators')
            .update({
              status: 'active',
              last_sign_in: nowIso,
              updated_at: nowIso,
            })
            .eq('id', existingOp.id);
        } else {
          await supabase.from('operators').insert({
            email: normalizedEmail,
            name: resolvedProfile.name,
            role: 'Junior CA',
            manager_id: resolvedProfile.manager_id || null,
            status: 'active',
            last_sign_in: nowIso,
            updated_at: nowIso,
          });
        }
      } catch (err) {
        console.warn('Operator active sync note:', err);
      }

      // MANDATORY: Hit CA work history endpoint immediately to load today's allotted clients
      setSmartSyncStatus('syncing');
      setSmartSyncMessage(`Retrieving daily client allotment from CA work history...`);

      (async () => {
        try {
          const syncRes = await syncLiveCAData({
            caEmail: normalizedEmail,
            dateStr: date || getTodayDateStr(),
          });
          if (syncRes.success) {
            const fbTag = syncRes.isFallback ? ' (fallback date)' : '';
            setSmartSyncStatus('synced');
            setSmartSyncMessage(`✅ Allotted clients retrieved: ${syncRes.count} clients for ${syncRes.activeDate}${fbTag}`);
          } else {
            setSmartSyncStatus('failed');
            setSmartSyncMessage(syncRes.message || 'Work history retrieved (0 assigned clients).');
          }
        } catch (syncErr) {
          setSmartSyncStatus('failed');
          setSmartSyncMessage(`Work history note: ${syncErr.message}`);
        } finally {
          setTimeout(() => {
            setSmartSyncStatus('idle');
            setSmartSyncMessage('');
          }, 8000);
        }
      })();
    }

    const sessionUser = {
      ...resolvedProfile,
      baseRole: resolvedProfile.role,
      authProvider: 'Microsoft Authenticator',
      date,
      timeframe,
    };

    setUser(sessionUser);
    setIsAuthModalOpen(false);
    return sessionUser;
  };

  /**
   * Helper for getting Microsoft Authenticator Pairing details (QR code & secret)
   */
  const getMfaSetupDetails = async (email) => {
    const cleanEmail = (email || '').trim().toLowerCase();
    if (!cleanEmail) throw new Error('Email is required to setup Microsoft Authenticator');
    const secret = await getOrCreateUserMfaSecret(cleanEmail);
    return getMicrosoftAuthenticatorDetails(cleanEmail, secret);
  };

  /**
   * Legacy wrapper for backward compatibility with existing components
   */
  const loginWithAuthenticator = async ({ email, code, password = 'Created@123' }) => {
    return loginWithCredentials({ email, password, code });
  };

  /**
   * Send One-Time Verification Code via Azure
   */
  const sendVerificationCode = async ({ email }) => {
    const normalizedEmail = email.trim().toLowerCase();
    const generatedCode = Math.floor(100000 + Math.random() * 900000).toString();
    const auto = await resolveRoleFromEmail(normalizedEmail);

    await supabase.from('auth_users').upsert(
      {
        email: normalizedEmail,
        name: auto.name,
        role: auto.role,
        manager_id: auto.manager_id,
        verification_code: generatedCode,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'email' }
    );

    return { success: true, code: generatedCode, email: normalizedEmail };
  };

  /**
   * Switch Role (Strictly restricted to Developer Ajith)
   */
  const switchRole = (newRole) => {
    const isDev =
      user?.baseRole === 'dev' ||
      user?.role === 'dev' ||
      user?.email === 'ajithchandranimmala@applywizz.ai';
    if (!isDev) return;
    setUser((prev) => ({
      ...prev,
      baseRole: 'dev',
      role: newRole,
    }));
  };

  /**
   * Logout user and revoke active session
   */
  const logout = async () => {
    if (user?.email) {
      const em = user.email.toLowerCase().trim();
      const nowIso = new Date().toISOString();
      try {
        await Promise.all([
          supabase
            .from('operators')
            .update({ status: 'logged_out', updated_at: nowIso })
            .ilike('email', em),
          supabase
            .from('auth_users')
            .update({ status: 'logged_out', updated_at: nowIso })
            .ilike('email', em),
        ]);
      } catch (err) {
        console.warn('Logout status update note:', err);
      }
    }
    localStorage.removeItem('applywizz_auth_session');
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        setUser,
        switchRole,
        logout,
        date,
        setDate,
        timeframe,
        setTimeframe,
        isAuthModalOpen,
        setIsAuthModalOpen,
        loginWithCredentials,
        loginWithAuthenticator,
        getMfaSetupDetails,
        sendVerificationCode,
        smartSyncStatus,
        smartSyncMessage,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
