import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../api/client';

// Google Client ID - should be moved to env var in production
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

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const googleButtonRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Load Google Identity Services script
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = initializeGoogle;
    document.body.appendChild(script);

    return () => {
      document.body.removeChild(script);
    };
  }, []);

  const initializeGoogle = () => {
    if (!window.google || !GOOGLE_CLIENT_ID) {
      console.error('Google Identity Services not loaded or client ID missing');
      return;
    }

    window.google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: handleGoogleCallback,
    });

    if (googleButtonRef.current) {
      window.google.accounts.id.renderButton(googleButtonRef.current, {
        theme: 'filled_blue',
        size: 'large',
        type: 'standard',
        text: 'signin_with',
        width: 280,
      });
    }
  };

  const handleGoogleCallback = async (response: { credential: string }) => {
    try {
      const data = await api.googleAuth(response.credential);
      login(data.access_token);
      navigate('/projects');
    } catch (error) {
      console.error('Google auth failed:', error);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div>
          <h1 className="text-center text-3xl font-bold text-gray-900">
            Fastest
          </h1>
          <h2 className="mt-2 text-center text-xl text-gray-600">
            Sign in to your account
          </h2>
        </div>

        <div className="mt-8 space-y-6">
          {/* Google Sign-In Button */}
          <div className="flex justify-center">
            {GOOGLE_CLIENT_ID ? (
              <div ref={googleButtonRef} />
            ) : (
              <div className="text-sm text-gray-500 text-center">
                <p>Google Sign-In not configured.</p>
                <p className="mt-1 text-xs">Set VITE_GOOGLE_CLIENT_ID in your environment.</p>
              </div>
            )}
          </div>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-300" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-2 bg-gray-50 text-gray-500">or</span>
            </div>
          </div>

          <div className="text-center">
            <p className="text-sm text-gray-500">
              CLI users: run <code className="bg-gray-100 px-1 py-0.5 rounded">fst login</code> to authenticate
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
