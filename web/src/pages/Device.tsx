import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';

type Step = 'code' | 'email' | 'success' | 'error';

export function Device() {
  const [searchParams] = useSearchParams();
  const [step, setStep] = useState<Step>('code');
  const [userCode, setUserCode] = useState(searchParams.get('code') || '');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-advance if code is in URL
  useEffect(() => {
    if (searchParams.get('code')) {
      setStep('email');
    }
  }, [searchParams]);

  const handleCodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (userCode.length >= 8) {
      setStep('email');
    }
  };

  const handleAuthorize = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/v1/oauth/device/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_code: userCode,
          email: email,
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
      // Ignore errors on deny
      setStep('error');
    } finally {
      setLoading(false);
    }
  };

  // Format code as user types (ABCD-1234)
  const formatCode = (value: string) => {
    const cleaned = value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (cleaned.length <= 4) return cleaned;
    return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}`;
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div>
          <h1 className="text-center text-3xl font-bold text-gray-900">
            Fastest
          </h1>
          <h2 className="mt-2 text-center text-xl text-gray-600">
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
              <label htmlFor="code" className="block text-sm font-medium text-gray-700 text-center">
                Enter the code shown in your terminal
              </label>
              <input
                id="code"
                type="text"
                value={userCode}
                onChange={(e) => setUserCode(formatCode(e.target.value))}
                className="mt-4 block w-full px-3 py-4 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-primary-500 focus:border-primary-500 text-center text-2xl tracking-widest font-mono"
                placeholder="ABCD-1234"
                maxLength={9}
                autoFocus
                autoComplete="off"
              />
            </div>

            <button
              type="submit"
              disabled={userCode.replace(/-/g, '').length < 8}
              className="w-full flex justify-center py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Continue
            </button>
          </form>
        )}

        {step === 'email' && (
          <form onSubmit={handleAuthorize} className="mt-8 space-y-6">
            <div className="bg-gray-100 rounded-lg p-4 text-center">
              <p className="text-sm text-gray-600">Authorizing code</p>
              <p className="text-xl font-mono font-bold text-gray-900">{userCode}</p>
            </div>

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700">
                Enter your email to continue
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-primary-500 focus:border-primary-500"
                placeholder="you@example.com"
                autoFocus
                required
              />
            </div>

            <div className="flex space-x-4">
              <button
                type="button"
                onClick={handleDeny}
                disabled={loading}
                className="flex-1 py-2 px-4 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50"
              >
                Deny
              </button>
              <button
                type="submit"
                disabled={loading || !email}
                className="flex-1 py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50"
              >
                {loading ? 'Authorizing...' : 'Authorize'}
              </button>
            </div>

            <button
              type="button"
              onClick={() => setStep('code')}
              className="w-full text-sm text-gray-500 hover:text-gray-700"
            >
              ← Enter a different code
            </button>
          </form>
        )}

        {step === 'success' && (
          <div className="mt-8 text-center space-y-4">
            <div className="w-16 h-16 mx-auto bg-green-100 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h3 className="text-lg font-medium text-gray-900">Device Authorized!</h3>
            <p className="text-gray-500">
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
            <h3 className="text-lg font-medium text-gray-900">Authorization Failed</h3>
            <p className="text-gray-500">{error || 'Something went wrong.'}</p>
            <button
              onClick={() => {
                setStep('code');
                setUserCode('');
                setError(null);
              }}
              className="text-primary-600 hover:text-primary-700"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
