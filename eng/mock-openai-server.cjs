/**
 * Minimal OpenAI-compatible chat-completions server, for device testing.
 *
 * Purpose: let the app run a *real* agent turn on an emulator without a cloud key, so
 * the conversation-history, permission and workspace paths can be exercised end to end
 * instead of only in unit tests. It answers with a scripted stream, including a tool
 * call on the first turn so the full loop is covered.
 *
 * Deliberately dependency-free and offline.
 *
 * Run:  node eng/mock-openai-server.cjs [port]
 * Then point the app's base URL at http://10.0.2.2:<port>/v1 (Android emulator's alias
 * for the host) and give it any non-empty API key.
 *
 * Logs every request so a test can assert what the app actually sent.
 */
const http = require("node:http");
const fs = require("node:fs");

const PORT = Number(process.argv[2] ?? 8787);
const LOG = process.env.MOCK_LOG ?? null;

const requests = [];

/** One SSE chunk in the shape the OpenAI streaming API uses. */
function chunk(delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "mock-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function respondWithToolCall(res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  res.write(chunk({ role: "assistant", content: "" }));
  res.write(
    chunk({
      tool_calls: [
        {
          index: 0,
          id: "call_mock_1",
          type: "function",
          function: { name: "fs_list", arguments: "" },
        },
      ],
    }),
  );
  // Arguments arrive as a stream of fragments, as a real provider sends them.
  res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }));
  res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: '"/demo/Download"' } }] }));
  res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: "}" } }] }));
  res.write(chunk({}, "tool_calls"));
  res.write("data: [DONE]\n\n");
  res.end();
}

/** Final answer: exercises the Markdown renderer, including a table. */
function respondWithAnswer(res) {
  const answer = [
    "## 已完成的检查",
    "",
    "我把 `/demo/Download` 走了一遍，结果如下：",
    "",
    "| 文件 | 大小 | 类型 |",
    "| :--- | ---: | :---: |",
    "| report-2026-Q1.pdf | 22 B | PDF |",
    "| notes.md | 44 B | 文本 |",
    "| app.log | 52 B | 日志 |",
    "",
    "**结论**：共 3 个文件，其中 1 个是日志。",
    "",
    "- 没有发现异常大的文件",
    "- `app.log` 里有一条 ERROR",
  ].join("\n");

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  res.write(chunk({ role: "assistant", content: "" }));
  // Sent in fragments so the client's streaming path is genuinely exercised.
  for (const part of answer.match(/[\s\S]{1,24}/g) ?? []) {
    res.write(chunk({ content: part }));
  }
  res.write(chunk({}, "stop"));
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname.endsWith("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
    return;
  }

  if (req.method !== "POST" || !url.pathname.includes("chat/completions")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${url.pathname}` } }));
    return;
  }

  let body = "";
  req.on("data", (piece) => {
    body += piece;
  });
  req.on("end", () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      // Reported below rather than thrown, so the server survives a malformed request.
    }
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const hasToolResult = messages.some((message) => message.role === "tool");
    const entry = {
      at: new Date().toISOString(),
      model: parsed.model,
      messageCount: messages.length,
      roles: messages.map((message) => message.role),
      hasToolResult,
      systemPreview: typeof messages[0]?.content === "string" ? messages[0].content.slice(0, 400) : "",
    };
    requests.push(entry);
    console.log(`[mock] turn: messages=${entry.messageCount} roles=${entry.roles.join(",")} toolResult=${hasToolResult}`);
    if (LOG) fs.appendFileSync(LOG, `${JSON.stringify(entry)}\n`, "utf8");

    // First turn asks for a tool; after the tool result, answer.
    if (hasToolResult) respondWithAnswer(res);
    else respondWithToolCall(res);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[mock] listening on 0.0.0.0:${PORT}`);
  console.log(`[mock] Android emulator should use http://10.0.2.2:${PORT}/v1`);
  if (LOG) console.log(`[mock] request log: ${LOG}`);
});
