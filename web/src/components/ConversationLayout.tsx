import { Outlet, Link } from '@tanstack/react-router';
import { useAuth } from '../contexts/AuthContext';

export function ConversationLayout() {
  const { user, logout } = useAuth();

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Minimal header */}
      <header className="flex-shrink-0 bg-white border-b border-gray-200">
        <div className="px-4 h-12 flex items-center justify-between">
          <Link to="/" className="text-lg font-bold text-primary-600">
            Fastest
          </Link>

          <div className="flex items-center gap-4">
            {user && (
              <div className="flex items-center gap-3">
                {user.picture ? (
                  <img
                    src={user.picture}
                    alt={user.name || user.email}
                    className="w-7 h-7 rounded-full"
                  />
                ) : (
                  <div className="w-7 h-7 rounded-full bg-primary-100 flex items-center justify-center text-xs font-medium text-primary-700">
                    {(user.name || user.email).charAt(0).toUpperCase()}
                  </div>
                )}
                <button
                  onClick={logout}
                  className="text-xs text-gray-500 hover:text-gray-700"
                >
                  Logout
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main content - full height */}
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
