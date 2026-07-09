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
  it('logs unexpected error diagnostics without exposing stack details to clients', () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const middleware = errorMiddleware({ logger });
    const error = new Error('database unavailable');
    const req = { headers: { 'x-correlation-id': 'correlation-1' } } as unknown as Request;
    const res = createResponseMock();

    middleware(error, req, res, jest.fn());

    expect(logger.error).toHaveBeenCalledWith(
      'Request failed',
      expect.objectContaining({
        code: 'INTERNAL_SERVER_ERROR',
        correlationId: 'correlation-1',
        isOperational: false,
        message: 'database unavailable',
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
      code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
      message: 'Idempotency request is already processing',
      statusCode: 409,
      details: { idempotencyKey: 'idem-1' },
    });
    const req = { headers: { 'x-correlation-id': 'correlation-2' } } as unknown as Request;
    const res = createResponseMock();

    middleware(error, req, res, jest.fn());

    expect(logger.error).toHaveBeenCalledWith(
      'Request failed',
      expect.objectContaining({
        code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
        correlationId: 'correlation-2',
        isOperational: true,
        message: 'Idempotency request is already processing',
      }),
    );
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
        message: 'Idempotency request is already processing',
        details: { idempotencyKey: 'idem-1' },
        correlationId: 'correlation-2',
      },
    });
  });
});
