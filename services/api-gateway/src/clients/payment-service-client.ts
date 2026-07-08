import { CORRELATION_ID_HEADER } from '../constants';
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

  constructor(deps: { env: NodeJS.ProcessEnv; fetchFn?: FetchFn }) {
    this.baseUrl = deps.env.PAYMENT_SERVICE_BASE_URL ?? 'http://payment-service:8080';
    this.internalToken = deps.env.INTERNAL_SERVICE_TOKEN ?? '';
    this.fetchFn = deps.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  public create = async (command: CreatePaymentClientCommand) => {
    return this.request('/internal/payments', {
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
    return this.request(`/internal/payments/${query.paymentId}`, {
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
}
