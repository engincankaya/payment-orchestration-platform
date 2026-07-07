import { NextFunction, Request, Response } from 'express';

export default function internalAuthMiddleware(deps: { env: NodeJS.ProcessEnv }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = req.headers['x-internal-token'];

      if (token !== deps.env.INTERNAL_SERVICE_TOKEN) {
        return res.status(401).json({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Unauthorized internal request',
          },
        });
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
}
