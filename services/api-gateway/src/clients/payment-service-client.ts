import { CORRELATION_ID_HEADER, BASE_INTERNAL_API_PATH } from '../constants';
import ApiError from '../types/errors/api-error';

export type FetchFn = typeof fetch;

export interface CreatePaymentClientCommand {
  correlationId: string;
  idempotencyKey: string;
  merchantId: string;
  amountMinor: number;
  currency: string;
}

export interface GetPaymentClientQuery {
  correlationId: string;
  paymentId: string;
}

export default class PaymentServiceClient {
  private baseUrl: string;
  private internalToken: string;
  private fetchFn: FetchFn;
  private timeoutMs: number;

  constructor(deps: { env: NodeJS.ProcessEnv; fetchFn?: FetchFn }) {
    this.baseUrl = deps.env.PAYMENT_SERVICE_BASE_URL ?? 'http://payment-service:8080';
    this.internalToken = deps.env.INTERNAL_SERVICE_TOKEN ?? '';
    this.fetchFn = deps.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = Number(deps.env.PAYMENT_SERVICE_TIMEOUT_MS ?? 5000);

    // Gateway must never forward an empty internal token to downstream services.
    if (!this.internalToken) {
      throw new Error('INTERNAL_SERVICE_TOKEN is required');
    }

    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('PAYMENT_SERVICE_TIMEOUT_MS must be a positive number');
    }
  }

  public create = async (command: CreatePaymentClientCommand) => {
    return this.request(`${BASE_INTERNAL_API_PATH}/payments`, {
      method: 'POST',
      correlationId: command.correlationId,
      idempotencyKey: command.idempotencyKey,
      body: {
        merchantId: command.merchantId,
        amountMinor: command.amountMinor,
        currency: command.currency,
      },
    });
  };

  public getById = async (query: GetPaymentClientQuery) => {
    return this.request(`${BASE_INTERNAL_API_PATH}/payments/${query.paymentId}`, {
      method: 'GET',
      correlationId: query.correlationId,
    });
  };

  private request = async (
    path: string,
    options: {
      method: 'GET' | 'POST';
      correlationId: string;
      idempotencyKey?: string;
      body?: unknown;
    },
  ) => {
    const maxAttempts = options.method === 'GET' ? 2 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.send(path, options);
      } catch (error) {
        const mappedError = this.mapTransportError(error);
        const canRetry = options.method === 'GET' && attempt < maxAttempts && mappedError;

        if (canRetry) {
          continue;
        }

        throw mappedError ?? error;
      }
    }
  };

  private send = async (
    path: string,
    options: {
      method: 'GET' | 'POST';
      correlationId: string;
      idempotencyKey?: string;
      body?: unknown;
    },
  ) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-internal-token': this.internalToken,
      [CORRELATION_ID_HEADER]: options.correlationId,
    };

    if (options.idempotencyKey) {
      headers['idempotency-key'] = options.idempotencyKey;
    }

    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: options.method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const responseBody = await response.json().catch(() => null);

    if (!response.ok) {
      const error = responseBody?.error;

      throw new ApiError({
        code: error?.code ?? 'PAYMENT_SERVICE_ERROR',
        message: error?.message ?? 'Payment service request failed',
        statusCode: response.status,
        details: error?.details ?? null,
      });
    }

    return responseBody;
  };

  private mapTransportError(error: unknown) {
    if (error instanceof ApiError) {
      return null;
    }

    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      return new ApiError({
        code: 'PAYMENT_SERVICE_TIMEOUT',
        message: 'Payment service request timed out',
        statusCode: 504,
      });
    }

    return new ApiError({
      code: 'PAYMENT_SERVICE_UNAVAILABLE',
      message: 'Payment service is unavailable',
      statusCode: 502,
    });
  }
}
