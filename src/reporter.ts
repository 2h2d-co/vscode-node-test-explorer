import { inspect } from "node:util";

const customInspect = Symbol.for("nodejs.util.inspect.custom");

interface SerializedError {
  [key: string]: unknown;
  message: string;
  name: string;
  stack: string | undefined;
}

export default async function* reporter(source: AsyncIterable<unknown>): AsyncGenerator<string> {
  for await (const event of source) {
    yield `${JSON.stringify(event, serializeValue) ?? "null"}\n`;
  }
}

function serializeValue(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Error) {
    return serializedError(value);
  }

  if (isObject(value) && customInspect in value) {
    return { inspect: inspect(value, { depth: 10, breakLength: 100 }) };
  }

  return value;
}

function serializedError(value: Error): SerializedError {
  const serialized: SerializedError = {
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
    serialized["cause"] = value.cause;
  }

  return serialized;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
