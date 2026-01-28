import type { ResourceType, InfraProvider } from '@fastest/shared';
import {
  getDefaultProviderNameForType as getSharedDefaultProviderNameForType,
} from '@fastest/shared';
import type { ResourceProvider, ProviderCredentials } from './types';
import { ProviderError } from './types';
import { RailwayProvider } from './railway';
import { CloudflareProvider } from './cloudflare';

// Re-export types
export * from './types';
export { RailwayProvider } from './railway';
export { CloudflareProvider } from './cloudflare';

/**
 * Registry of all available providers
 */
const providers = new Map<InfraProvider, ResourceProvider>();
providers.set('railway', new RailwayProvider());
providers.set('cloudflare', new CloudflareProvider());

/**
 * Get a provider by name
 */
export function getProvider(name: InfraProvider): ResourceProvider {
  const provider = providers.get(name);
  if (!provider) {
    throw new ProviderError(name, 'NOT_FOUND', `Provider '${name}' not found`);
  }
  return provider;
}

/**
 * Get the default provider for a resource type
 */
export function getDefaultProviderForType(type: ResourceType): ResourceProvider {
  const providerName = getSharedDefaultProviderNameForType(type);
  if (!providerName) {
    throw new ProviderError(
      'railway', // fallback
      'NO_DEFAULT',
      `No default provider configured for resource type '${type}'`
    );
  }
  return getProvider(providerName);
}

/**
 * Get the default provider name for a resource type
 */
export function getDefaultProviderNameForType(type: ResourceType): InfraProvider {
  const providerName = getSharedDefaultProviderNameForType(type);
  if (!providerName) {
    // Default to railway for unknown types
    return 'railway';
  }
  return providerName;
}

/**
 * Get all available providers
 */
export function getAllProviders(): ResourceProvider[] {
  return Array.from(providers.values());
}

/**
 * Get providers that support a specific resource type
 */
export function getProvidersForType(type: ResourceType): ResourceProvider[] {
  return Array.from(providers.values()).filter((p) =>
    p.supportedTypes.includes(type)
  );
}

/**
 * Check if a provider supports a resource type
 */
export function providerSupportsType(
  provider: InfraProvider,
  type: ResourceType
): boolean {
  const p = providers.get(provider);
  return p ? p.supportedTypes.includes(type) : false;
}

/**
 * Validate credentials for a provider
 */
export async function validateProviderCredentials(
  provider: InfraProvider,
  creds: ProviderCredentials
): Promise<boolean> {
  const p = getProvider(provider);
  return p.validateCredentials(creds);
}
