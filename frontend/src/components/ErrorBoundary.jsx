import React from 'react';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('Uncaught React render error:', error, errorInfo);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh',
          background: '#0b0f17',
          color: '#f8fafc',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem',
          fontFamily: 'Inter, sans-serif'
        }}>
          <div style={{
            maxWidth: '560px',
            width: '100%',
            background: 'rgba(30, 41, 59, 0.7)',
            border: '1px solid rgba(239, 68, 68, 0.4)',
            borderRadius: '12px',
            padding: '2rem',
            boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
            textAlign: 'center'
          }}>
            <div style={{ fontSize: '2.5rem', marginBottom: '1rem' }}>⚠️</div>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 'bold', marginBottom: '0.75rem', color: '#f87171' }}>
              Dashboard Display Recovered
            </h2>
            <p style={{ fontSize: '0.875rem', color: '#94a3b8', marginBottom: '1.25rem', lineHeight: '1.5' }}>
              An unexpected data rendering error occurred. The system protected your view from going black.
            </p>
            {this.state.error?.message && (
              <pre style={{
                background: 'rgba(15, 23, 42, 0.8)',
                border: '1px solid #334155',
                color: '#fca5a5',
                padding: '0.75rem',
                borderRadius: '6px',
                fontSize: '0.75rem',
                textAlign: 'left',
                overflowX: 'auto',
                marginBottom: '1.5rem',
                fontFamily: 'monospace'
              }}>
                {this.state.error.message}
              </pre>
            )}
            <button
              onClick={this.handleReload}
              style={{
                background: 'linear-gradient(135deg, #0284c7 0%, #0369a1 100%)',
                color: '#fff',
                border: 'none',
                padding: '0.65rem 1.5rem',
                borderRadius: '6px',
                fontWeight: 600,
                fontSize: '0.875rem',
                cursor: 'pointer'
              }}
            >
              Reload Dashboard
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
