import Joi from 'joi';
import { IRouteSettings } from '@payment-orchestration-platform/openapi-kit';

import { BASE_INTERNAL_API_PATH } from '../../../constants';

const BASE_ROUTE = `${BASE_INTERNAL_API_PATH}/payments`;
export const AMOUNT_MINOR_MAX = 1_000_000_000_000;

// Response schemas live with route metadata because the OpenAPI document is generated from this source.
const paymentSchema = {
  type: 'object',
  required: ['id', 'merchantId', 'amountMinor', 'currency', 'status', 'provider', 'createdAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    merchantId: { type: 'string', format: 'uuid' },
    amountMinor: { type: 'integer' },
    currency: { type: 'string', enum: ['TRY', 'USD', 'EUR'] },
    status: { type: 'string', enum: ['AUTHORIZED', 'FAILED'] },
    provider: { type: 'string' },
    providerPaymentId: { type: 'string', nullable: true },
    failureCode: { type: 'string', nullable: true },
    failureMessage: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const errorSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'correlationId'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: { nullable: true },
        correlationId: { type: 'string', nullable: true },
      },
    },
  },
};

export const PaymentRoutes: IRouteSettings[] = [
  {
    path: BASE_ROUTE,
    method: 'post',
    controller: 'paymentsController.create',
    config: {
      description: 'Create and authorize a payment',
      tags: ['payments'],
      middlewares: ['internalAuthMiddleware'],
      validation: {
        headers: Joi.object({
          'x-internal-token': Joi.string().optional(),
          'idempotency-key': Joi.string().min(8).max(128).required(),
          'x-correlation-id': Joi.string().optional(),
        }).unknown(true),
        body: Joi.object({
          merchantId: Joi.string().uuid().required(),
          amountMinor: Joi.number().integer().positive().max(AMOUNT_MINOR_MAX).required(),
          currency: Joi.string().valid('TRY', 'USD', 'EUR').required(),
        }),
      },
      responses: {
        201: {
          description: 'Payment created and authorization attempted',
          schema: paymentSchema,
        },
        400: {
          description: 'VALIDATION_ERROR',
          schema: errorSchema,
        },
        401: {
          description: 'UNAUTHORIZED',
          schema: errorSchema,
        },
        409: {
          description: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST or IDEMPOTENCY_REQUEST_IN_PROGRESS',
          schema: errorSchema,
        },
      },
    },
  },
  {
    path: `${BASE_ROUTE}/:paymentId`,
    method: 'get',
    controller: 'paymentsController.getById',
    config: {
      description: 'Get payment by id',
      tags: ['payments'],
      middlewares: ['internalAuthMiddleware'],
      validation: {
        headers: Joi.object({
          'x-internal-token': Joi.string().optional(),
          'x-correlation-id': Joi.string().optional(),
        }).unknown(true),
        params: Joi.object({
          paymentId: Joi.string().uuid().required(),
        }),
      },
      responses: {
        200: {
          description: 'Payment details',
          schema: paymentSchema,
        },
        400: {
          description: 'VALIDATION_ERROR',
          schema: errorSchema,
        },
        401: {
          description: 'UNAUTHORIZED',
          schema: errorSchema,
        },
        404: {
          description: 'PAYMENT_NOT_FOUND',
          schema: errorSchema,
        },
      },
    },
  },
];
