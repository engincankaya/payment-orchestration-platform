import Joi from 'joi';

export interface RouteRequestValidation {
  params?: Joi.ObjectSchema | Joi.ArraySchema;
  query?: Joi.ObjectSchema | Joi.ArraySchema;
  body?: Joi.ObjectSchema | Joi.ArraySchema;
  headers?: Joi.ObjectSchema | Joi.ArraySchema;
}
