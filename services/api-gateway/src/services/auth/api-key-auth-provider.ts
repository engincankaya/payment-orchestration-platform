import timingSafeEquals from '../../utils/timing-safe-equals';

// Local API key provider for the MVP; stronger auth can replace this behind ExternalAuthService.
export interface AuthenticatedClient {
  apiKeyId: string;
  scopes: string[];
}

export default class ApiKeyAuthProvider {
  private publicApiKey: string;

  constructor(deps: { env: NodeJS.ProcessEnv }) {
    // Missing public auth config is a deployment error, not a runtime fallback.
    if (!deps.env.PUBLIC_API_KEY) {
      throw new Error('PUBLIC_API_KEY is required');
    }

    this.publicApiKey = deps.env.PUBLIC_API_KEY;
  }

  public authenticate = async (apiKey?: string): Promise<AuthenticatedClient | null> => {
    if (!timingSafeEquals(apiKey, this.publicApiKey)) {
      return null;
    }

    return {
      apiKeyId: 'local-public-api-key',
      scopes: ['payments:create', 'payments:read'],
    };
  };
}
