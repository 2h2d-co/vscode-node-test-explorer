import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

import reporter from "../src/reporter.ts";

async function render(...events: readonly unknown[]): Promise<string[]> {
  async function* source(): AsyncGenerator {
    yield* events;
  }

  const lines: string[] = [];
  for await (const line of reporter(source())) {
    lines.push(line);
  }
  return lines;
}

test("serializes errors with stack, cause, enumerable details, and bigint values", async () => {
  const cause = new TypeError("inner");
  const failure = new Error("outer", { cause });
  Object.defineProperty(failure, "attempt", { enumerable: true, value: 3n });

  const [line] = await render({ failure });

  assert.ok(line);
  assert.match(line, /"name":"Error"/u);
  assert.match(line, /"message":"outer"/u);
  assert.match(line, /"stack":"Error: outer/u);
  assert.match(line, /"attempt":"3"/u);
  assert.match(line, /"cause":\{"name":"TypeError","message":"inner"/u);
});

test("uses custom inspection and always emits valid newline-delimited JSON", async () => {
  const inspected = {
    [inspect.custom]() {
      return "diagnostic value";
    },
  };

  assert.deepEqual(await render(inspected, undefined, { count: 7n }), [
    '{"inspect":"diagnostic value"}\n',
    "null\n",
    '{"count":"7"}\n',
  ]);
});
