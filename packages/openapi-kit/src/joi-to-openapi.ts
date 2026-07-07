import Joi from 'joi';

type JoiDescription = ReturnType<Joi.Schema['describe']>;
type JoiRuleDescription = { name: string };

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

  return {
    type: 'string',
    ...(validValues.length > 0 ? { enum: validValues } : {}),
    ...(hasRule(description, 'guid') || hasRule(description, 'uuid') ? { format: 'uuid' } : {}),
  };
}

export function joiToOpenApiSchema(schema: Joi.Schema): Record<string, unknown> {
  return convertJoiDescription(schema.describe());
}
