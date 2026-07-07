import Joi from 'joi';

export interface RouteRequestValidation {
  params?: Joi.ObjectSchema | Joi.ArraySchema;
  query?: Joi.ObjectSchema | Joi.ArraySchema;
  body?: Joi.ObjectSchema | Joi.ArraySchema;
  headers?: Joi.ObjectSchema | Joi.ArraySchema;
}

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface RouteResponseContract {
  description: string;
  schema?: Record<string, unknown>;
}

export interface IRouteSettings {
  path: string;
  method: HttpMethod;
  controller: string;
  config: {
    tags: string[];
    description: string;
    validation: RouteRequestValidation;
    middlewares: string[];
    responses: Record<string, RouteResponseContract>;
  };
}
