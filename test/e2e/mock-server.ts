import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  provider: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

type Reply = { status: number; body: unknown; headers?: Record<string, string> };
export type Handler = (req: RecordedRequest) => Reply;

const draft = {
  type: "feat",
  scope: "math",
  gitmoji: ":sparkles:",
  description: "add sum helper",
  body: "Adds a helper for adding two numbers.",
  breaking: false,
  breakingDescription: "",
  footers: [],
};

/** Success responses in each provider's documented response shape. */
export const ok = {
  openai: (text = JSON.stringify(draft)): Reply => ({
    status: 200,
    headers: { "x-request-id": "req_mock_openai" },
    body: {
      status: "completed",
      model: "gpt-5.6-luna",
      output: [{ type: "message", content: [{ type: "output_text", text }] }],
      usage: { input_tokens: 321, output_tokens: 45 },
    },
  }),
  anthropic: (text = JSON.stringify(draft)): Reply => ({
    status: 200,
    headers: { "request-id": "req_mock_anthropic" },
    body: {
      model: "claude-haiku-5-5",
      stop_reason: "end_turn",
      content: [{ type: "text", text }],
      usage: { input_tokens: 300, output_tokens: 40 },
    },
  }),
  gemini: (text = JSON.stringify(draft)): Reply => ({
    status: 200,
    body: {
      status: "completed",
      model: "gemini-3.5-flash-lite",
      steps: [{ type: "model_output", content: [{ type: "text", text }] }],
      usage: { total_input_tokens: 280, total_output_tokens: 30 },
    },
  }),
  xai: (text = JSON.stringify(draft)): Reply => ({
    status: 200,
    body: {
      status: "completed",
      model: "grok-4.7",
      output: [{ type: "message", content: [{ type: "output_text", text }] }],
    },
  }),
};

export class MockProviders {
  readonly requests: RecordedRequest[] = [];
  private server: Server | null = null;
  private handlers: Record<string, Handler> = {};
  port = 0;

  on(provider: string, handler: Handler): this {
    this.handlers[provider] = handler;
    return this;
  }

  baseUrl(provider: string): string {
    return `http://127.0.0.1:${this.port}/${provider}`;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const [, provider = "", ...rest] = (req.url ?? "").split("/");
        const record: RecordedRequest = {
          provider,
          path: `/${rest.join("/")}`,
          headers: req.headers,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
        };
        this.requests.push(record);
        const handler = this.handlers[provider];
        const reply = handler
          ? handler(record)
          : { status: 404, body: { error: { message: "no handler" } } };
        res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
        res.end(JSON.stringify(reply.body));
      });
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.port = (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
