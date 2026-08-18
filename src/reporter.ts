import { inspect } from "node:util";

const customInspect = Symbol.for("nodejs.util.inspect.custom");

type JsonStringifyValue =
  | JsonStringifyObject
  | JsonStringifyValue[]
  | NamedFunction
  | bigint
  | boolean
  | null
  | number
  | string
  | symbol
  | undefined;

interface JsonStringifyObject {
  [key: string]: JsonStringifyValue;
}

interface NamedFunction {
  readonly name: string;
}

interface SerializedError extends JsonStringifyObject {
  message: string;
  name: string;
  stack: string | undefined;
}

interface InspectedValue extends JsonStringifyObject {
  inspect: string;
}

export default async function* reporter(source: AsyncIterable<unknown>): AsyncGenerator<string> {
  for await (const event of source) {
    yield `${JSON.stringify(event, serializeError)}\n`;
  }
}

function serializeError(_key: string, value: unknown): JsonStringifyValue {
  if (value instanceof Error) {
    return serializedError(value);
  }

  if (isJsonStringifyObject(value) && customInspect in value) {
    return inspectedValue(value);
  }

  return jsonStringifyValue(value);
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
      serialized[key] = jsonStringifyValue(descriptor.value);
    }
  }

  if ("cause" in value) {
    serialized["cause"] = jsonStringifyValue(value.cause);
  }

  return serialized;
}

function inspectedValue(value: JsonStringifyObject): InspectedValue {
  return { inspect: inspect(value, { depth: 10, breakLength: 100 }) };
}

function jsonStringifyValue(value: unknown): JsonStringifyValue {
  return isJsonStringifyValue(value) ? value : undefined;
}

function isJsonStringifyValue(value: unknown): value is JsonStringifyValue {
  return (
    value === null ||
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "boolean" ||
    typeof value === "function" ||
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "symbol" ||
    Array.isArray(value) ||
    isJsonStringifyObject(value)
  );
}

function isJsonStringifyObject(value: unknown): value is JsonStringifyObject {
  return typeof value === "object" && value !== null;
}
