// Re-export shared types for convenience
export * from '@fastest/shared';

// API-specific types

export interface AuthContext {
  userId: string;
  email: string;
}
