import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { supabase } from '../config/supabase';
import { syncLiveCAData } from '../services/api';

const AuthContext = createContext(null);

const getTodayDateStr = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const DEFAULT_USER = {
  email: 'ajithchandranimmala@applywizz.ai',
  name: 'Ajith Chandra Nimmala',
  role: 'dev', // 'dev' | 'admin' | 'manager' | 'operator'
  manager_id: null,
  authProvider: 'Microsoft Authenticator',
  date: getTodayDateStr(),
  timeframe: 'day', // 'day' | 'week' | 'month'
};

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try {
      const saved = localStorage.getItem('applywizz_auth_session');
      return saved ? JSON.parse(saved) : DEFAULT_USER;
    } catch {
      return DEFAULT_USER;
    }
  });

  const [date, setDate] = useState(getTodayDateStr());
  const [timeframe, setTimeframe] = useState('day');
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  // Smart Auto-Sync state: 'idle' | 'syncing' | 'synced' | 'failed'
  const [smartSyncStatus, setSmartSyncStatus] = useState('idle');
  const [smartSyncMessage, setSmartSyncMessage] = useState('');

  useEffect(() => {
    if (user) {
      localStorage.setItem('applywizz_auth_session', JSON.stringify(user));
    }
  }, [user]);

  // 30s Heartbeat & Browser Disconnect Lifecycle
  useEffect(() => {
    if (!user?.email) return;
    const em = user.email.toLowerCase().trim();

    // 1. Initial touch on mount/login
    supabase
      .from('operators')
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .ilike('email', em)
      .then(() => {})
      .catch(() => {});

    // 2. Periodic heartbeat every 30s
    const heartbeatTimer = setInterval(() => {
      supabase
        .from('operators')
        .update({ status: 'active', updated_at: new Date().toISOString() })
        .ilike('email', em)
        .then(() => {})
        .catch(() => {});
    }, 30000);

    // 3. Browser disconnect on tab/window close
    const handleBeforeUnload = () => {
      const nowIso = new Date().toISOString();
      const payload = JSON.stringify({ updated_at: nowIso });
      try {
        const url = `${supabase.supabaseUrl}/rest/v1/operators?email=ilike.${encodeURIComponent(em)}`;
        if (navigator.sendBeacon) {
          navigator.sendBeacon(url, payload);
        }
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
   * Determine role from email if not already in DB
   */
  const resolveRoleFromEmail = (normalizedEmail) => {
    // 1. Developer
    if (normalizedEmail === 'ajithchandranimmala@applywizz.ai') {
      return { role: 'dev', name: 'Ajith Chandra Nimmala', manager_id: null };
    }
    // 2. Managers
    if (normalizedEmail === 'balaji@applywizz.ai' || normalizedEmail.includes('balaji')) {
      return { role: 'manager', name: 'Balaji', manager_id: '9dc9376e-fbc5-440b-932f-38da10b89a70' };
    }
    if (normalizedEmail === 'ramakrishnaa.tejavath@applywizz.ai') {
      return { role: 'manager', name: 'Ramakrishna Tejavath', manager_id: 'bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca744' };
    }
    // 3. Admins (Super Admin & Platform Admins)
    const adminEmails = [
      'admin@applywizz.ai',
      'admin@applywizz.com',
      'superadmin@applywizz.ai',
      'ramakrishna@applywizz.ai',
      'anushabandreddy@applywizz.ai',
      'shyam@applywizz.ai',
      'jagan@applywizz.ai'
    ];
    if (normalizedEmail.includes('admin') || adminEmails.includes(normalizedEmail)) {
      const namePart = normalizedEmail.split('@')[0];
      return {
        role: 'admin',
        name: normalizedEmail.includes('admin') ? 'Super Admin' : (namePart.charAt(0).toUpperCase() + namePart.slice(1)),
        manager_id: null
      };
    }
    // 4. Default: Operator (CA)
    return {
      role: 'operator',
      name: normalizedEmail.split('@')[0],
      manager_id: null
    };
  };

  /**
   * Sign In with Microsoft Authenticator Code
   */
  const loginWithAuthenticator = async ({ email, code }) => {
    const normalizedEmail = email.trim().toLowerCase();
    const auto = resolveRoleFromEmail(normalizedEmail);

    // 1. Query Supabase auth_users table
    let { data: authUser, error } = await supabase
      .from('auth_users')
      .select('*')
      .ilike('email', normalizedEmail)
      .maybeSingle();

    let resolvedProfile;

    if (authUser) {
      // Ensure admin or dev emails are never demoted to operator by stale DB records
      const effectiveRole = (auto.role === 'admin' || auto.role === 'dev') ? auto.role : (authUser.role || auto.role);
      resolvedProfile = {
        email: authUser.email,
        name: authUser.name || auto.name,
        role: effectiveRole,
        manager_id: authUser.manager_id,
      };

      // Update last sign in and active status on auth_users
      await supabase
        .from('auth_users')
        .update({
          status: 'active',
          role: effectiveRole,
          last_sign_in: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', authUser.id);
    } else {
      // Auto-resolve role based on system rules
      const auto = resolveRoleFromEmail(normalizedEmail);
      resolvedProfile = {
        email: normalizedEmail,
        name: auto.name,
        role: auto.role,
        manager_id: auto.manager_id,
      };

      // Persist new user in auth_users with active status
      await supabase.from('auth_users').insert({
        email: normalizedEmail,
        name: auto.name,
        role: auto.role,
        manager_id: auto.manager_id,
        status: 'active',
        verification_code: code || '000000',
        last_sign_in: new Date().toISOString(),
      });
    }

    // Update or insert operators table to reflect active session
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
            last_sign_in: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', existingOp.id);
      } else {
        await supabase
          .from('operators')
          .insert({
            email: normalizedEmail,
            name: resolvedProfile.name || normalizedEmail.split('@')[0],
            role: resolvedProfile.role || 'operator',
            manager_id: resolvedProfile.manager_id || null,
            status: 'active',
            last_sign_in: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
      }
    } catch (err) {
      console.warn('Failed to update operator active status:', err);
    }

    const sessionUser = {
      ...resolvedProfile,
      authProvider: 'Microsoft Authenticator',
      date,
      timeframe,
    };

    setUser(sessionUser);
    setIsAuthModalOpen(false);

    // ── Smart Auto-Sync on Login (only for CA / operator role) ──────────
    // Runs fully in background — CA sees their portal immediately.
    if (resolvedProfile.role === 'operator') {
      const syncEmail = resolvedProfile.email;
      const syncDate = date || getTodayDateStr();
      setSmartSyncStatus('syncing');
      setSmartSyncMessage(`Auto-syncing clients for ${syncEmail}...`);

      (async () => {
        try {
          const syncRes = await syncLiveCAData({ caEmail: syncEmail, dateStr: syncDate });
          if (syncRes.success) {
            const fbTag = syncRes.isFallback ? ' (fallback date)' : '';
            setSmartSyncStatus('synced');
            setSmartSyncMessage(`✅ Auto-synced ${syncRes.count} clients for ${syncRes.activeDate}${fbTag}`);
          } else {
            setSmartSyncStatus('failed');
            setSmartSyncMessage(syncRes.message || 'Auto-sync completed with no records.');
          }
        } catch (err) {
          setSmartSyncStatus('failed');
          setSmartSyncMessage(`Auto-sync error: ${err.message}`);
        } finally {
          // Clear the status banner after 8 seconds
          setTimeout(() => {
            setSmartSyncStatus('idle');
            setSmartSyncMessage('');
          }, 8000);
        }
      })();
    }
    // ────────────────────────────────────────────────────────────────────

    return sessionUser;
  };

  /**
   * Send One-Time Verification Code for Sign Up
   */
  const sendVerificationCode = async ({ email }) => {
    const normalizedEmail = email.trim().toLowerCase();
    const generatedCode = Math.floor(100000 + Math.random() * 900000).toString();

    const auto = resolveRoleFromEmail(normalizedEmail);

    await supabase.from('auth_users').upsert({
      email: normalizedEmail,
      name: auto.name,
      role: auto.role,
      manager_id: auto.manager_id,
      verification_code: generatedCode,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'email' });

    return { success: true, code: generatedCode, email: normalizedEmail };
  };

  const switchRole = (newRole) => {
    // Only Developer can switch roles globally
    if (user?.role !== 'dev' && newRole !== user?.role) return;
    setUser((prev) => ({
      ...prev,
      role: newRole,
    }));
  };

  const logout = async () => {
    if (user?.email) {
      const em = user.email.toLowerCase().trim();
      try {
        await Promise.all([
          supabase
            .from('operators')
            .update({
              status: 'logged_out',
              updated_at: new Date().toISOString(),
            })
            .ilike('email', em),
          supabase
            .from('auth_users')
            .update({
              status: 'logged_out',
              updated_at: new Date().toISOString(),
            })
            .ilike('email', em),
        ]);
      } catch (err) {
        console.warn('Failed to set operator logged_out:', err);
      }
    }
    localStorage.removeItem('applywizz_auth_session');
    setUser(null);
    setIsAuthModalOpen(true);
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
        loginWithAuthenticator,
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
