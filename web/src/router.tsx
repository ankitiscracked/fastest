import { createRouter, createRootRouteWithContext, createRoute, redirect, Outlet } from '@tanstack/react-router';
import { Layout } from './components/Layout';
import { ConversationLayout } from './components/ConversationLayout';
import { Login } from './pages/Login';
import { Device } from './pages/Device';
import { Projects } from './pages/Projects';
import { ProjectDetail } from './pages/ProjectDetail';
import { Workspaces } from './pages/Workspaces';
import { WorkspaceDetail } from './pages/WorkspaceDetail';
import { Home } from './pages/Home';
import { ConversationView } from './pages/ConversationView';
import { Settings } from './pages/Settings';
import { DocsPage } from './pages/DocsPage';

// Router context type
interface RouterContext {
  isAuthenticated: boolean;
  loading: boolean;
}

// Root route
const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
});

// Login route (public)
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: Login,
});

// Device route (public - for CLI auth)
const deviceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/device',
  component: Device,
});

// Conversation-first layout route (main experience)
const conversationLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'conversation',
  beforeLoad: ({ context }) => {
    if (context.loading) {
      return;
    }
    if (!context.isAuthenticated) {
      throw redirect({ to: '/login' });
    }
  },
  component: ConversationLayout,
});

// Home page - the new index
const homeRoute = createRoute({
  getParentRoute: () => conversationLayoutRoute,
  path: '/',
  component: Home,
});

// Conversation view with conversation ID
const conversationRoute = createRoute({
  getParentRoute: () => conversationLayoutRoute,
  path: '/$conversationId',
  component: ConversationView,
});

// Workspace detail route
const workspaceDetailRoute = createRoute({
  getParentRoute: () => conversationLayoutRoute,
  path: '/workspaces/$workspaceId',
  component: WorkspaceDetail,
});

// Authenticated layout route for admin/settings pages
const authenticatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authenticated',
  beforeLoad: ({ context }) => {
    if (context.loading) {
      return;
    }
    if (!context.isAuthenticated) {
      throw redirect({ to: '/login' });
    }
  },
  component: Layout,
});

// Projects route
const projectsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/projects',
  component: Projects,
});

// Project detail route
const projectDetailRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/projects/$projectId',
  component: ProjectDetail,
});

// Workspaces route
const workspacesRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/projects/$projectId/workspaces',
  component: Workspaces,
});

// Settings route
const settingsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/settings',
  component: Settings,
});

// Project docs route
const projectDocsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/projects/$projectId/docs',
  component: DocsPage,
});

// Build route tree
const routeTree = rootRoute.addChildren([
  loginRoute,
  deviceRoute,
  conversationLayoutRoute.addChildren([
    homeRoute,
    conversationRoute,
    workspaceDetailRoute,
  ]),
  authenticatedRoute.addChildren([
    projectsRoute,
    projectDetailRoute,
    workspacesRoute,
    projectDocsRoute,
    settingsRoute,
  ]),
]);

// Create router
export const router = createRouter({
  routeTree,
  context: {
    isAuthenticated: false,
    loading: true,
  },
});

// Type declaration for router
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
