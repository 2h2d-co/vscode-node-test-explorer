export default async function* reporter(source: AsyncIterable<unknown>): AsyncGenerator<string> {
  for await (const event of source) {
    yield `${JSON.stringify(event)}\n`;
  }
}
