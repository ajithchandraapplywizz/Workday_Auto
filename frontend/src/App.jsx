import React, { useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import Header from './components/Header';
import MicrosoftAuthModal from './components/MicrosoftAuthModal';
import DeveloperDashboard from './pages/DeveloperDashboard';
import AdminDashboard from './pages/AdminDashboard';
import ManagerDashboard from './pages/ManagerDashboard';
import OperatorDashboard from './pages/OperatorDashboard';
import CADashboard from './pages/CADashboard';
import LoginPage from './pages/LoginPage';
import './App.css';

function MainLayout() {
  const { user, isAuthModalOpen, setIsAuthModalOpen } = useAuth();
  const [operatorView, setOperatorView] = useState('dashboard'); // 'dashboard' | 'stats' | 'review'

  // If not logged in, render the dedicated professional LoginPage
  if (!user) {
    return <LoginPage />;
  }

  return (
    <div className="video-app-wrapper">
      {/* Top Header matching video */}
      <Header
        operatorView={operatorView}
        onOperatorViewChange={setOperatorView}
      />

      {/* Microsoft Authenticator Sign In / Sign Up Modal */}
      <MicrosoftAuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
      />

      {/* Main Role-Specific View */}
      <main className="video-main-content">
        {user?.role === 'dev' && <DeveloperDashboard />}
        {user?.role === 'admin' && <AdminDashboard />}
        {user?.role === 'manager' && <ManagerDashboard />}
        {user?.role === 'ca' && <CADashboard />}
        {user?.role === 'operator' && (
          operatorView === 'review' ? (
            <CADashboard />
          ) : (
            <OperatorDashboard operatorView={operatorView} />
          )
        )}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <MainLayout />
    </AuthProvider>
  );
}
