import ApiKeyAuthProvider, { AuthenticatedClient } from './api-key-auth-provider';

export default class ExternalAuthService {
  private apiKeyAuthProvider: ApiKeyAuthProvider;

  constructor(deps: { apiKeyAuthProvider: ApiKeyAuthProvider }) {
    this.apiKeyAuthProvider = deps.apiKeyAuthProvider;
  }

  public authenticateApiKey = async (apiKey?: string): Promise<AuthenticatedClient | null> => {
    return this.apiKeyAuthProvider.authenticate(apiKey);
  };
}
