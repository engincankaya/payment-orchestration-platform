import ApiKeyAuthProvider, { AuthenticatedClient } from './api-key-auth-provider';

export default class ExternalAuthService {
  private apiKeyAuthProvider: ApiKeyAuthProvider;

  constructor(deps: { apiKeyAuthProvider: ApiKeyAuthProvider }) {
    this.apiKeyAuthProvider = deps.apiKeyAuthProvider;
  }

  // Keep public authentication behind a service boundary so stronger auth can replace API keys later.
  public authenticateApiKey = async (apiKey?: string): Promise<AuthenticatedClient | null> => {
    return this.apiKeyAuthProvider.authenticate(apiKey);
  };
}
