import { ErrorRequestHandler } from 'express';

import { CORRELATION_ID_HEADER } from '../../constants';
import ApiError from '../../types/errors/api-error';
import { Logger } from '../../utils/logger';

export default function errorMiddleware(deps: { logger: Logger }): ErrorRequestHandler {
  return (error, req, res, _next) => {
    const correlationId = req.headers[CORRELATION_ID_HEADER] ?? null;
    const isApiError = error instanceof ApiError;
    const statusCode = isApiError ? error.statusCode : 500;
    const code = isApiError ? error.code : 'INTERNAL_SERVER_ERROR';
    const message = isApiError ? error.message : 'Internal server error';
    const details = isApiError ? error.details ?? null : null;

    deps.logger.error('Request failed', {
      code,
      correlationId,
      isOperational: isApiError ? error.isOperational : false,
    });

    return res.status(statusCode).json({
      error: {
        code,
        message,
        details,
        correlationId,
      },
    });
  };
}
