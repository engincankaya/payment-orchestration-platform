import { Request, Response } from 'express';

import errorMiddleware from '../../src/server/middlewares/error-middleware';
import ApiError from '../../src/types/errors/api-error';

function createResponseMock() {
  const response = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };

  return response as unknown as Response & {
    status: jest.Mock;
    json: jest.Mock;
  };
}

describe('errorMiddleware', () => {
  it('logs message and stack for unexpected errors without leaking them to the response', () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const middleware = errorMiddleware({ logger });
    const error = new Error('database exploded');
    const req = { headers: { 'x-correlation-id': 'correlation-1' } } as unknown as Request;
    const res = createResponseMock();

    middleware(error, req, res, jest.fn());

    expect(logger.error).toHaveBeenCalledWith(
      'Request failed',
      expect.objectContaining({
        code: 'INTERNAL_SERVER_ERROR',
        correlationId: 'correlation-1',
        isOperational: false,
        message: 'database exploded',
        stack: expect.any(String),
      }),
    );
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error',
        details: null,
        correlationId: 'correlation-1',
      },
    });
  });

  it('logs operational ApiError diagnostics and returns the safe client response', () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const middleware = errorMiddleware({ logger });
    const error = new ApiError({
      code: 'PAYMENT_SERVICE_TIMEOUT',
      message: 'Payment service timed out',
      statusCode: 504,
      details: { retryable: true },
    });
    const req = { headers: { 'x-correlation-id': 'correlation-2' } } as unknown as Request;
    const res = createResponseMock();

    middleware(error, req, res, jest.fn());

    expect(logger.error).toHaveBeenCalledWith(
      'Request failed',
      expect.objectContaining({
        code: 'PAYMENT_SERVICE_TIMEOUT',
        correlationId: 'correlation-2',
        isOperational: true,
        message: 'Payment service timed out',
      }),
    );
    expect(res.status).toHaveBeenCalledWith(504);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'PAYMENT_SERVICE_TIMEOUT',
        message: 'Payment service timed out',
        details: { retryable: true },
        correlationId: 'correlation-2',
      },
    });
  });
});
