import React, { createContext, useContext, useState, useEffect } from 'react';
import { supabase } from '../config/supabase';

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

  useEffect(() => {
    if (user) {
      localStorage.setItem('applywizz_auth_session', JSON.stringify(user));
    }
  }, [user]);

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
    // 3. Admins
    const adminEmails = [
      'ramakrishna@applywizz.ai',
      'anushabandreddy@applywizz.ai',
      'shyam@applywizz.ai',
      'jagan@applywizz.ai'
    ];
    if (adminEmails.includes(normalizedEmail)) {
      const namePart = normalizedEmail.split('@')[0];
      return {
        role: 'admin',
        name: namePart.charAt(0).toUpperCase() + namePart.slice(1),
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

    // 1. Query Supabase auth_users table
    let { data: authUser, error } = await supabase
      .from('auth_users')
      .select('*')
      .ilike('email', normalizedEmail)
      .maybeSingle();

    let resolvedProfile;

    if (authUser) {
      resolvedProfile = {
        email: authUser.email,
        name: authUser.name,
        role: authUser.role,
        manager_id: authUser.manager_id,
      };

      // Update last sign in on auth_users
      await supabase
        .from('auth_users')
        .update({ last_sign_in: new Date().toISOString() })
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

      // Persist new user in auth_users
      await supabase.from('auth_users').insert({
        email: normalizedEmail,
        name: auto.name,
        role: auto.role,
        manager_id: auto.manager_id,
        verification_code: code || '000000',
        last_sign_in: new Date().toISOString(),
      });
    }

    // Update operators table to reflect active session
    try {
      await supabase
        .from('operators')
        .update({
          status: 'active',
          last_sign_in: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .ilike('email', normalizedEmail);
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
      try {
        await supabase
          .from('operators')
          .update({
            status: 'offline',
            updated_at: new Date().toISOString(),
          })
          .ilike('email', user.email.toLowerCase().trim());
      } catch (err) {
        console.warn('Failed to set operator offline:', err);
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
