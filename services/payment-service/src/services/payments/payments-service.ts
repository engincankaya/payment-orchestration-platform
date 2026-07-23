import { randomUUID } from 'crypto';

import PaymentsDataAccess, { PaymentRecord } from '../../data-access/payments/payments-data-access';
import type {
  TransactionContext,
  TransactionManagerPort,
} from '../../data-access/transaction-manager';
import ApiError from '../../types/errors/api-error';
import { Logger } from '../../utils/logger';
import IdempotencyService from '../idempotency/idempotency-service';
import ProviderRegistryService from '../providers/provider-registry-service';
import PaymentStateService, { PaymentStatus } from './payment-state-service';

export type PaymentsDataAccessPort = Pick<
  PaymentsDataAccess,
  'insert' | 'findById' | 'findByIdForUpdate' | 'updateStatusIfAuthorized'
>;
export type IdempotencyServicePort = Pick<
  IdempotencyService,
  'buildRequestHash' | 'getExistingOrStart' | 'markCompleted' | 'markFailed'
>;
export type ProviderRegistryServicePort = Pick<
  ProviderRegistryService,
  'getDefaultProvider' | 'getProvider'
>;
export type PaymentStateServicePort = Pick<
  PaymentStateService,
  'ensureCanCapture' | 'ensureTransition'
>;

export interface OutboxServicePort {
  recordPaymentAuthorized(
    input: {
      correlationId: string;
      payment: PaymentRecord;
    },
    trx: TransactionContext,
  ): Promise<unknown>;
  recordPaymentCaptured(
    input: {
      correlationId: string;
      payment: PaymentRecord;
    },
    trx: TransactionContext,
  ): Promise<unknown>;
  recordPaymentFailed(
    input: {
      correlationId: string;
      operation: 'AUTHORIZE' | 'CAPTURE';
      payment: PaymentRecord;
    },
    trx: TransactionContext,
  ): Promise<unknown>;
}

export interface CreatePaymentCommand {
  correlationId: string;
  idempotencyKey: string;
  merchantId: string;
  amountMinor: number;
  currency: string;
}

export interface GetPaymentQuery {
  paymentId: string;
}

export interface CapturePaymentCommand {
  correlationId: string;
  idempotencyKey: string;
  paymentId: string;
}

export interface PaymentDto {
  id: string;
  merchantId: string;
  amountMinor: number;
  currency: string;
  status: string;
  provider: string;
  providerPaymentId?: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  createdAt: string;
}

export interface CreatePaymentResult {
  statusCode: number;
  body: PaymentDto;
}

export interface CapturePaymentResult {
  statusCode: number;
  body: PaymentDto;
}

export default class PaymentsService {
  private paymentsDataAccess: PaymentsDataAccessPort;
  private idempotencyService: IdempotencyServicePort;
  private providerRegistryService: ProviderRegistryServicePort;
  private paymentStateService: PaymentStateServicePort;
  private outboxService: OutboxServicePort;
  private transactionManager: TransactionManagerPort;
  private logger: Logger;

  constructor(deps: {
    paymentsDataAccess: PaymentsDataAccessPort;
    idempotencyService: IdempotencyServicePort;
    providerRegistryService: ProviderRegistryServicePort;
    paymentStateService: PaymentStateServicePort;
    outboxService: OutboxServicePort;
    transactionManager: TransactionManagerPort;
    logger: Logger;
  }) {
    this.paymentsDataAccess = deps.paymentsDataAccess;
    this.idempotencyService = deps.idempotencyService;
    this.providerRegistryService = deps.providerRegistryService;
    this.paymentStateService = deps.paymentStateService;
    this.outboxService = deps.outboxService;
    this.transactionManager = deps.transactionManager;
    this.logger = deps.logger;
  }

  public create = async (command: CreatePaymentCommand): Promise<CreatePaymentResult> => {
    const requestHash = this.idempotencyService.buildRequestHash({
      merchantId: command.merchantId,
      amountMinor: command.amountMinor,
      currency: command.currency,
    });
    const reservedPaymentId = randomUUID();
    const idempotencyDecision = await this.idempotencyService.getExistingOrStart({
      scope: `payments:create:${command.merchantId}`,
      idempotencyKey: command.idempotencyKey,
      requestHash,
      resource: {
        type: 'payment',
        id: reservedPaymentId,
      },
    });

    if (idempotencyDecision.type === 'COMPLETED') {
      return {
        statusCode: idempotencyDecision.responseStatusCode,
        body: idempotencyDecision.responseBody as PaymentDto,
      };
    }

    const paymentId = idempotencyDecision.resourceId;

    try {
      const provider = this.providerRegistryService.getDefaultProvider();
      const authorization = await provider.authorize({
        paymentId,
        merchantId: command.merchantId,
        amountMinor: command.amountMinor,
        currency: command.currency,
      });

      const now = new Date();
      const status = authorization.success ? PaymentStatus.AUTHORIZED : PaymentStatus.FAILED;

      this.paymentStateService.ensureTransition(PaymentStatus.CREATED, status);

      const body = await this.transactionManager.run(async (trx) => {
        const payment = await this.paymentsDataAccess.insert({
          id: paymentId,
          merchant_id: command.merchantId,
          amount_minor: command.amountMinor,
          currency: command.currency,
          status,
          provider: authorization.provider,
          provider_payment_id: authorization.providerPaymentId ?? null,
          failure_code: authorization.failureCode ?? null,
          failure_message: authorization.failureMessage ?? null,
          authorized_at: authorization.success ? now : null,
          failed_at: authorization.success ? null : now,
        }, trx);

        if (authorization.success) {
          await this.outboxService.recordPaymentAuthorized({
            correlationId: command.correlationId,
            payment,
          }, trx);
        } else {
          await this.outboxService.recordPaymentFailed({
            correlationId: command.correlationId,
            operation: 'AUTHORIZE',
            payment,
          }, trx);
        }

        const responseBody = this.toDto(payment);

        await this.idempotencyService.markCompleted({
          idempotencyRecordId: idempotencyDecision.recordId,
          responseStatusCode: 201,
          responseBody,
          resourceType: 'payment',
          resourceId: responseBody.id,
          processingToken: idempotencyDecision.processingToken,
          trx,
        });

        return responseBody;
      });

      return { statusCode: 201, body };
    } catch (error) {
      await this.idempotencyService
        .markFailed({
          idempotencyRecordId: idempotencyDecision.recordId,
          processingToken: idempotencyDecision.processingToken,
        })
        .catch((markFailedError) => {
          if (this.isOwnershipLost(markFailedError)) {
            throw markFailedError;
          }

          this.logger.error('Failed to mark idempotency record as failed', {
            idempotencyRecordId: idempotencyDecision.recordId,
            message:
              markFailedError instanceof Error ? markFailedError.message : String(markFailedError),
            stack: markFailedError instanceof Error ? markFailedError.stack : undefined,
          });
        });

      throw error;
    }
  };

  public capture = async (command: CapturePaymentCommand): Promise<CapturePaymentResult> => {
    const requestHash = this.idempotencyService.buildRequestHash({
      paymentId: command.paymentId,
    });
    const idempotencyDecision = await this.idempotencyService.getExistingOrStart({
      scope: `payments:capture:${command.paymentId}`,
      idempotencyKey: command.idempotencyKey,
      requestHash,
      resource: {
        type: 'payment',
        id: command.paymentId,
      },
    });

    if (idempotencyDecision.type === 'COMPLETED') {
      return {
        statusCode: idempotencyDecision.responseStatusCode,
        body: idempotencyDecision.responseBody as PaymentDto,
      };
    }

    try {
      const body = await this.transactionManager.run(async (trx) => {
        const payment = await this.paymentsDataAccess.findByIdForUpdate(command.paymentId, trx);

        if (!payment) {
          throw new ApiError({
            code: 'PAYMENT_NOT_FOUND',
            message: 'Payment not found',
            statusCode: 404,
          });
        }

        this.paymentStateService.ensureCanCapture(payment);

        const provider = this.providerRegistryService.getProvider(payment.provider);

        if (!payment.provider_payment_id) {
          throw new ApiError({
            code: 'PAYMENT_PROVIDER_REFERENCE_MISSING',
            message: 'Payment provider reference is missing',
            statusCode: 500,
            isOperational: false,
          });
        }

        const captureResult = await provider.capture({
          paymentId: payment.id,
          providerPaymentId: payment.provider_payment_id,
          amountMinor: Number(payment.amount_minor),
          currency: payment.currency,
        });
        const now = new Date();
        const targetStatus = captureResult.success
          ? PaymentStatus.CAPTURED
          : PaymentStatus.CAPTURE_FAILED;

        this.paymentStateService.ensureTransition(PaymentStatus.AUTHORIZED, targetStatus);

        const updatedPayment = await this.paymentsDataAccess.updateStatusIfAuthorized({
          id: payment.id,
          status: targetStatus,
          captured_at: captureResult.success ? now : null,
          failed_at: captureResult.success ? null : now,
          failure_code: captureResult.failureCode ?? null,
          failure_message: captureResult.failureMessage ?? null,
        }, trx);

        if (!updatedPayment) {
          throw new ApiError({
            code: 'PAYMENT_NOT_CAPTURABLE',
            message: 'Payment is not capturable',
            statusCode: 409,
          });
        }

        if (captureResult.success) {
          await this.outboxService.recordPaymentCaptured({
            correlationId: command.correlationId,
            payment: updatedPayment,
          }, trx);
        } else {
          await this.outboxService.recordPaymentFailed({
            correlationId: command.correlationId,
            operation: 'CAPTURE',
            payment: updatedPayment,
          }, trx);
        }

        const responseBody = this.toDto(updatedPayment);

        await this.idempotencyService.markCompleted({
          idempotencyRecordId: idempotencyDecision.recordId,
          processingToken: idempotencyDecision.processingToken,
          responseStatusCode: 200,
          responseBody,
          resourceType: 'payment',
          resourceId: updatedPayment.id,
          trx,
        });

        return responseBody;
      });

      return { statusCode: 200, body };
    } catch (error) {
      try {
        await this.idempotencyService.markFailed({
          idempotencyRecordId: idempotencyDecision.recordId,
          processingToken: idempotencyDecision.processingToken,
        });
      } catch (markFailedError) {
        if (this.isOwnershipLost(markFailedError)) {
          throw markFailedError;
        }

        this.logger.error('Failed to mark idempotency record as failed', {
          idempotencyRecordId: idempotencyDecision.recordId,
          message:
            markFailedError instanceof Error ? markFailedError.message : String(markFailedError),
          stack: markFailedError instanceof Error ? markFailedError.stack : undefined,
        });
      }

      throw error;
    }
  };

  public getById = async (query: GetPaymentQuery): Promise<PaymentDto> => {
    const payment = await this.paymentsDataAccess.findById(query.paymentId);

    if (!payment) {
      throw new ApiError({
        code: 'PAYMENT_NOT_FOUND',
        message: 'Payment not found',
        statusCode: 404,
      });
    }

    return this.toDto(payment);
  };

  private toDto(payment: PaymentRecord): PaymentDto {
    return {
      id: payment.id,
      merchantId: payment.merchant_id,
      amountMinor: Number(payment.amount_minor),
      currency: payment.currency,
      status: payment.status,
      provider: payment.provider,
      providerPaymentId: payment.provider_payment_id,
      failureCode: payment.failure_code,
      failureMessage: payment.failure_message,
      createdAt: new Date(payment.created_at).toISOString(),
    };
  }

  private isOwnershipLost(error: unknown) {
    return error instanceof ApiError && error.code === 'IDEMPOTENCY_OWNERSHIP_LOST';
  }
}
