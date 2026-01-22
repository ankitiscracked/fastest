import { useState, useEffect, useRef } from 'react';
import { useSearch } from '@tanstack/react-router';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../api/client';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
            auto_select?: boolean;
          }) => void;
          renderButton: (
            element: HTMLElement,
            config: {
              theme?: 'outline' | 'filled_blue' | 'filled_black';
              size?: 'large' | 'medium' | 'small';
              type?: 'standard' | 'icon';
              text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
              width?: number;
            }
          ) => void;
          prompt: () => void;
        };
      };
    };
  }
}

type Step = 'code' | 'authorize' | 'success' | 'error';

export function Device() {
  const search = useSearch({ strict: false }) as { code?: string };
  const { user, isAuthenticated, loading: authLoading } = useAuth();
  const [step, setStep] = useState<Step>('code');
  const [userCode, setUserCode] = useState(search.code || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const googleButtonRef = useRef<HTMLDivElement>(null);
  const googleInitialized = useRef(false);

  // Auto-advance if code is in URL
  useEffect(() => {
    if (search.code) {
      setStep('authorize');
    }
  }, [search.code]);

  // Load Google Identity Services when on authorize step (only if not logged in)
  useEffect(() => {
    if (step === 'authorize' && !isAuthenticated && !googleInitialized.current) {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = initializeGoogle;
      document.body.appendChild(script);

      return () => {
        if (document.body.contains(script)) {
          document.body.removeChild(script);
        }
      };
    } else if (step === 'authorize' && !isAuthenticated && googleInitialized.current && window.google) {
      renderGoogleButton();
    }
  }, [step, isAuthenticated]);

  const initializeGoogle = () => {
    if (!window.google || !GOOGLE_CLIENT_ID) {
      console.error('Google Identity Services not loaded or client ID missing');
      return;
    }

    window.google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: handleGoogleCallback,
    });

    googleInitialized.current = true;
    renderGoogleButton();
  };

  const renderGoogleButton = () => {
    if (googleButtonRef.current && window.google) {
      googleButtonRef.current.innerHTML = '';
      window.google.accounts.id.renderButton(googleButtonRef.current, {
        theme: 'filled_blue',
        size: 'large',
        type: 'standard',
        text: 'continue_with',
        width: 280,
      });
    }
  };

  const handleGoogleCallback = async (response: { credential: string }) => {
    await authorizeDevice(response.credential);
  };

  const handleAuthorizeWithSession = async () => {
    await authorizeDevice();
  };

  const authorizeDevice = async (credential?: string) => {
    setLoading(true);
    setError(null);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      // If logged in, use the session token
      const token = api.getToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const res = await fetch('/v1/oauth/device/authorize', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          user_code: userCode,
          ...(credential && { credential }),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error?.message || 'Authorization failed');
      }

      setStep('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleCodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (userCode.replace(/-/g, '').length >= 8) {
      setStep('authorize');
    }
  };

  const handleDeny = async () => {
    setLoading(true);
    try {
      await fetch('/v1/oauth/device/deny', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_code: userCode }),
      });
      setStep('error');
      setError('Authorization denied. You can close this window.');
    } catch {
      setStep('error');
    } finally {
      setLoading(false);
    }
  };

  const formatCode = (value: string) => {
    const cleaned = value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (cleaned.length <= 4) return cleaned;
    return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}`;
  };

  // Show loading while checking auth state
  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-50">
        <div className="text-surface-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div>
          <h1 className="text-center text-3xl font-bold text-surface-800">
            Fastest
          </h1>
          <h2 className="mt-2 text-center text-xl text-surface-600">
            Authorize CLI
          </h2>
        </div>

        {error && step !== 'success' && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
            {error}
          </div>
        )}

        {step === 'code' && (
          <form onSubmit={handleCodeSubmit} className="mt-8 space-y-6">
            <div>
              <label htmlFor="code" className="block text-sm font-medium text-surface-700 text-center">
                Enter the code shown in your terminal
              </label>
              <input
                id="code"
                type="text"
                value={userCode}
                onChange={(e) => setUserCode(formatCode(e.target.value))}
                className="mt-4 block w-full px-3 py-4 border border-surface-300 rounded-md shadow-sm placeholder-surface-400 focus:outline-none focus:ring-accent-500 focus:border-accent-500 text-center text-2xl tracking-widest font-mono"
                placeholder="ABCD-1234"
                maxLength={9}
                autoFocus
                autoComplete="off"
              />
            </div>

            <button
              type="submit"
              disabled={userCode.replace(/-/g, '').length < 8}
              className="w-full flex justify-center py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-accent-500 hover:bg-accent-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-accent-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Continue
            </button>
          </form>
        )}

        {step === 'authorize' && (
          <div className="mt-8 space-y-6">
            <div className="bg-surface-100 rounded-lg p-4 text-center">
              <p className="text-sm text-surface-600">Authorizing device with code</p>
              <p className="text-xl font-mono font-bold text-surface-800">{userCode}</p>
            </div>

            {isAuthenticated && user ? (
              // User is already logged in - show simple authorize button
              <div className="text-center space-y-4">
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <p className="text-sm text-blue-700">
                    Logged in as <strong>{user.email}</strong>
                  </p>
                </div>

                <button
                  onClick={handleAuthorizeWithSession}
                  disabled={loading}
                  className="w-full py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-accent-500 hover:bg-accent-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-accent-500 disabled:opacity-50"
                >
                  {loading ? 'Authorizing...' : 'Authorize this device'}
                </button>
              </div>
            ) : (
              // User is not logged in - show Google Sign-In
              <div className="text-center">
                <p className="text-sm text-surface-600 mb-4">
                  Sign in with Google to authorize this device
                </p>

                {GOOGLE_CLIENT_ID ? (
                  <div className="flex justify-center">
                    <div ref={googleButtonRef} />
                  </div>
                ) : (
                  <div className="text-sm text-surface-500">
                    <p>Google Sign-In not configured.</p>
                    <p className="mt-1 text-xs">Set VITE_GOOGLE_CLIENT_ID in your environment.</p>
                  </div>
                )}

                {loading && (
                  <p className="mt-4 text-sm text-surface-500">Authorizing...</p>
                )}
              </div>
            )}

            <div className="flex space-x-4">
              <button
                type="button"
                onClick={() => {
                  setStep('code');
                  setUserCode('');
                }}
                className="flex-1 py-2 px-4 border border-surface-300 rounded-md shadow-sm text-sm font-medium text-surface-700 bg-white hover:bg-surface-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-accent-500"
              >
                Back
              </button>
              <button
                type="button"
                onClick={handleDeny}
                disabled={loading}
                className="flex-1 py-2 px-4 border border-red-300 rounded-md shadow-sm text-sm font-medium text-red-700 bg-white hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50"
              >
                Deny
              </button>
            </div>
          </div>
        )}

        {step === 'success' && (
          <div className="mt-8 text-center space-y-4">
            <div className="w-16 h-16 mx-auto bg-green-100 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h3 className="text-lg font-medium text-surface-800">Device Authorized!</h3>
            <p className="text-surface-500">
              You can close this window and return to your terminal.
              <br />
              The CLI should now be logged in.
            </p>
          </div>
        )}

        {step === 'error' && (
          <div className="mt-8 text-center space-y-4">
            <div className="w-16 h-16 mx-auto bg-red-100 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h3 className="text-lg font-medium text-surface-800">Authorization Failed</h3>
            <p className="text-surface-500">{error || 'Something went wrong.'}</p>
            <button
              onClick={() => {
                setStep('code');
                setUserCode('');
                setError(null);
              }}
              className="text-accent-600 hover:text-accent-700"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
