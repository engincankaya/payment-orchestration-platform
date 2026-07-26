import { NextFunction, Request, Response } from 'express';
import Joi from 'joi';
import { RouteRequestValidation } from '@payment-orchestration-platform/openapi-kit';

import { CORRELATION_ID_HEADER } from '../../constants';

type RequestSegment = 'body' | 'params' | 'query' | 'headers';

const validationOrder: RequestSegment[] = ['body', 'params', 'query', 'headers'];

export const correlationIdHeaderSchema = Joi.string()
  .min(1)
  .max(128)
  .pattern(/^[!-~]+$/)
  .optional();

export function getValidCorrelationId(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  return correlationIdHeaderSchema.validate(value).error ? null : value;
}

function formatValidationDetails(error: Joi.ValidationError, segment: RequestSegment) {
  return error.details.map((detail) => ({
    path: [segment, ...detail.path].join('.'),
    message: detail.message,
  }));
}

export function createValidationHandler(validation: RouteRequestValidation = {}) {
  return (req: Request, res: Response, next: NextFunction) => {
    for (const segment of validationOrder) {
      const schema = validation[segment];

      if (!schema) {
        continue;
      }

      const result = schema.validate(req[segment], {
        abortEarly: false,
        stripUnknown: segment !== 'headers',
      });

      if (result.error) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Validation failed',
            details: formatValidationDetails(result.error, segment),
            correlationId: getValidCorrelationId(req.headers[CORRELATION_ID_HEADER]),
          },
        });
      }

      req[segment] = result.value;
    }

    return next();
  };
}
