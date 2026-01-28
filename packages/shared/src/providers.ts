import type { InfraProvider, ResourceType } from './index';

// Provider config - what each provider supports
export interface ProviderInfo {
  name: InfraProvider;
  displayName: string;
  supportedTypes: ResourceType[];
  description: string;
}

export const INFRA_PROVIDERS: Record<InfraProvider, ProviderInfo> = {
  railway: {
    name: 'railway',
    displayName: 'Railway',
    supportedTypes: ['compute', 'database:postgres', 'database:redis'],
    description: 'Full-stack deployment platform with managed databases',
  },
  cloudflare: {
    name: 'cloudflare',
    displayName: 'Cloudflare',
    supportedTypes: ['compute:edge', 'storage:blob'],
    description: 'Edge computing and serverless workers',
  },
};

// Default provider for each resource type
export const DEFAULT_PROVIDER_FOR_TYPE: Partial<Record<ResourceType, InfraProvider>> = {
  'compute': 'railway',
  'compute:edge': 'cloudflare',
  'database:postgres': 'railway',
  'database:redis': 'railway',
  'storage:blob': 'cloudflare',
};

// Optional fallback providers by resource type (ordered)
export const PROVIDER_FALLBACKS_FOR_TYPE: Partial<Record<ResourceType, InfraProvider[]>> = {
  'compute': [],
  'compute:edge': [],
  'database:postgres': [],
  'database:redis': [],
  'storage:blob': [],
};

// Managed default provider for greenfield deploys
export const MANAGED_DEFAULT_PROVIDER: InfraProvider = 'railway';

export function getProviderInfo(provider: InfraProvider): ProviderInfo {
  return INFRA_PROVIDERS[provider];
}

export function listProviders(): ProviderInfo[] {
  return Object.values(INFRA_PROVIDERS);
}

export function providerSupportsType(
  provider: InfraProvider,
  type: ResourceType
): boolean {
  return INFRA_PROVIDERS[provider]?.supportedTypes.includes(type) ?? false;
}

export function getDefaultProviderNameForType(type: ResourceType): InfraProvider | null {
  const provider = DEFAULT_PROVIDER_FOR_TYPE[type];
  if (!provider) return null;
  return providerSupportsType(provider, type) ? provider : null;
}

export function getProviderCandidatesForType(type: ResourceType): InfraProvider[] {
  const candidates: InfraProvider[] = [];
  const defaultProvider = getDefaultProviderNameForType(type);
  if (defaultProvider) {
    candidates.push(defaultProvider);
  }

  const fallbacks = PROVIDER_FALLBACKS_FOR_TYPE[type] || [];
  for (const provider of fallbacks) {
    if (!candidates.includes(provider) && providerSupportsType(provider, type)) {
      candidates.push(provider);
    }
  }

  for (const provider of Object.keys(INFRA_PROVIDERS) as InfraProvider[]) {
    if (!candidates.includes(provider) && providerSupportsType(provider, type)) {
      candidates.push(provider);
    }
  }

  return candidates;
}
