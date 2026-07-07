import Joi from 'joi';

import { BASE_INTERNAL_API_PATH } from '../../../constants';
import { IRouteSettings } from '../../../types/server/route-settings';

const BASE_ROUTE = `${BASE_INTERNAL_API_PATH}/payments`;

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
          amountMinor: Joi.number().integer().positive().required(),
          currency: Joi.string().valid('TRY', 'USD', 'EUR').required(),
        }),
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
    },
  },
];
