import { RouterProvider } from '@tanstack/react-router';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { router } from './router';

function InnerApp() {
  const { isAuthenticated, loading } = useAuth();

  // Update router context when auth state changes
  router.update({
    context: {
      isAuthenticated,
      loading,
    },
  });

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  return <RouterProvider router={router} />;
}

function App() {
  return (
    <AuthProvider>
      <InnerApp />
    </AuthProvider>
  );
}

export default App;
