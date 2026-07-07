export interface AuthenticatedClient {
  apiKeyId: string;
  scopes: string[];
}

export default class ApiKeyAuthProvider {
  private publicApiKey?: string;

  constructor(deps: { env: NodeJS.ProcessEnv }) {
    this.publicApiKey = deps.env.PUBLIC_API_KEY;
  }

  public authenticate = async (apiKey?: string): Promise<AuthenticatedClient | null> => {
    if (!apiKey || !this.publicApiKey || apiKey !== this.publicApiKey) {
      return null;
    }

    return {
      apiKeyId: 'local-public-api-key',
      scopes: ['payments:create', 'payments:read'],
    };
  };
}
