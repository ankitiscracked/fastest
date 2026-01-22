import { Outlet } from '@tanstack/react-router';
import { Sidebar } from './Sidebar';

export function ConversationLayout() {
  return (
    <div className="h-screen flex bg-gray-50">
      {/* Left sidebar */}
      <Sidebar />

      {/* Main content */}
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
