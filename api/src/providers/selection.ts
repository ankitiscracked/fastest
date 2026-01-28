import type { InfraProvider, ResourceType } from '@fastest/shared';
import { getProviderCandidatesForType } from '@fastest/shared';
import type { ProviderCredentials } from './types';

export interface ProviderSelection {
  provider: InfraProvider;
  creds: ProviderCredentials;
}

export function selectProviderForType(
  type: ResourceType,
  candidates: InfraProvider[] | undefined,
  userCreds: Map<InfraProvider, ProviderCredentials>,
  managedCreds: Map<InfraProvider, ProviderCredentials>
): ProviderSelection | null {
  const providerCandidates = candidates && candidates.length > 0
    ? candidates
    : getProviderCandidatesForType(type);

  for (const provider of providerCandidates) {
    const creds = userCreds.get(provider) || managedCreds.get(provider);
    if (creds) {
      return { provider, creds };
    }
  }

  return null;
}
