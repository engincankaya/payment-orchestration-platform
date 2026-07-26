import Joi from 'joi';

type JoiDescription = ReturnType<Joi.Schema['describe']>;
type JoiRuleDescription = {
  name: string;
  args?: {
    limit?: number;
    regex?: string;
  };
};

function isRequired(description: JoiDescription) {
  const flags = description.flags as { presence?: string } | undefined;

  return flags?.presence === 'required';
}

function getValidValues(description: JoiDescription) {
  const allowedValues = description.allow as unknown[] | undefined;

  return allowedValues?.filter((value) => value !== '') ?? [];
}

function hasRule(description: JoiDescription, ruleName: string) {
  const rules = description.rules as JoiRuleDescription[] | undefined;

  return rules?.some((rule) => rule.name === ruleName) ?? false;
}

function getRule(description: JoiDescription, ruleName: string) {
  const rules = description.rules as JoiRuleDescription[] | undefined;

  return rules?.find((rule) => rule.name === ruleName);
}

function getPattern(description: JoiDescription) {
  const regex = getRule(description, 'pattern')?.args?.regex;

  if (!regex) {
    return undefined;
  }

  return regex.match(/^\/([\s\S]*)\/[a-z]*$/)?.[1] ?? regex;
}

function convertObjectDescription(description: JoiDescription): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, childDescription] of Object.entries(description.keys ?? {})) {
    const child = childDescription as JoiDescription;

    properties[key] = convertJoiDescription(child);

    if (isRequired(child)) {
      required.push(key);
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

export function convertJoiDescription(description: JoiDescription): Record<string, unknown> {
  const validValues = getValidValues(description);

  if (description.type === 'object') {
    return convertObjectDescription(description);
  }

  if (description.type === 'array') {
    return {
      type: 'array',
      items: description.items?.[0] ? convertJoiDescription(description.items[0] as JoiDescription) : {},
    };
  }

  if (description.type === 'number') {
    return {
      type: hasRule(description, 'integer') ? 'integer' : 'number',
      ...(validValues.length > 0 ? { enum: validValues } : {}),
    };
  }

  if (description.type === 'boolean') {
    return { type: 'boolean' };
  }

  const minLength = getRule(description, 'min')?.args?.limit;
  const maxLength = getRule(description, 'max')?.args?.limit;
  const pattern = getPattern(description);

  return {
    type: 'string',
    ...(validValues.length > 0 ? { enum: validValues } : {}),
    ...(hasRule(description, 'guid') || hasRule(description, 'uuid') ? { format: 'uuid' } : {}),
    ...(minLength !== undefined ? { minLength } : {}),
    ...(maxLength !== undefined ? { maxLength } : {}),
    ...(pattern !== undefined ? { pattern } : {}),
  };
}

export function joiToOpenApiSchema(schema: Joi.Schema): Record<string, unknown> {
  return convertJoiDescription(schema.describe());
}
