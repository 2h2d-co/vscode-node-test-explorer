export type JsonPrimitive = boolean | null | number | string;

export type JsonValue = JsonObject | JsonPrimitive | JsonValue[];

export type JsonObject = {
  [key: string]: JsonValue;
};

export function parseJsonObject(contents: string, label: string): JsonObject {
  const parsed: unknown = JSON.parse(contents);
  if (!isJsonObject(parsed)) {
    throw new Error(`Expected a JSON object: ${label}`);
  }
  return parsed;
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    isString(value)
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return typeof value === "object" && Object.values(value).every(isJsonValue);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && isJsonValue(value) && value !== null && !Array.isArray(value);
}
