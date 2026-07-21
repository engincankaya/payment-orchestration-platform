import { NextFunction, Request, Response } from 'express';

import internalAuthMiddleware from '../../src/server/middlewares/internal-auth-middleware';

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

describe('internalAuthMiddleware', () => {
  it('fails fast when INTERNAL_SERVICE_TOKEN is missing', () => {
    expect(() => internalAuthMiddleware({ env: {} })).toThrow('INTERNAL_SERVICE_TOKEN is required');
  });

  it('rejects missing, empty, or different tokens', async () => {
    const middleware = internalAuthMiddleware({
      env: { INTERNAL_SERVICE_TOKEN: 'internal-test-token' },
    });

    for (const token of [undefined, '', 'wrong-token']) {
      const req = { headers: { 'x-internal-token': token } } as unknown as Request;
      const res = createResponseMock();
      const next = jest.fn() as NextFunction;

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it('allows a matching token', async () => {
    const middleware = internalAuthMiddleware({
      env: { INTERNAL_SERVICE_TOKEN: 'internal-test-token' },
    });
    const req = {
      headers: { 'x-internal-token': 'internal-test-token' },
    } as unknown as Request;
    const res = createResponseMock();
    const next = jest.fn() as NextFunction;

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
