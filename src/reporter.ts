export default async function* reporter(source: AsyncIterable<unknown>): AsyncGenerator<string> {
  for await (const event of source) {
    yield `${JSON.stringify(event, serializeError)}\n`;
  }
}

function serializeError(_key: string, value: unknown): unknown {
  if (!(value instanceof Error)) {
    return value;
  }

  const serialized: Record<string, unknown> = {
    name: value.name,
    message: value.message,
    stack: value.stack,
  };

  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) {
      serialized[key] = descriptor.value;
    }
  }

  if ("cause" in value) {
    serialized.cause = value.cause;
  }

  return serialized;
}
