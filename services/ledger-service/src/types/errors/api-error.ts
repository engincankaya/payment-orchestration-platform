export default class ApiError extends Error {
  public statusCode: number;
  public code: string;
  public details?: unknown;
  public isOperational: boolean;

  constructor(params: {
    code: string;
    message: string;
    statusCode: number;
    details?: unknown;
    isOperational?: boolean;
  }) {
    super(params.message);

    this.name = 'ApiError';
    this.code = params.code;
    this.statusCode = params.statusCode;
    this.details = params.details;
    this.isOperational = params.isOperational ?? true;
  }
}
