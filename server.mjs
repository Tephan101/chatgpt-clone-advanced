import express from "express";
import cors from "cors";
import dotenv from "dotenv";

// Load environment variables from .env if present
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from the public directory
app.use(express.static("public"));

// Default model and API configuration. These can be overridden via the .env file.
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/*
 * Helper function to call OpenAI's chat completions endpoint.
 * When stream is true the response body is streamed to the caller via Server-Sent
 * Events (SSE). Otherwise the full JSON response is parsed and the assistant's
 * message is returned as plain JSON.
 */
app.post("/api/chat", async (req, res) => {
  try {
    const { messages, model, systemPrompt, temperature = 0.7, stream = false } = req.body || {};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: "messages[] required" });
    }

    // Compose final message list, injecting a system prompt if supplied
    const finalMessages = [];
    if (systemPrompt && typeof systemPrompt === "string" && systemPrompt.trim()) {
      finalMessages.push({ role: "system", content: systemPrompt.trim() });
    }
    finalMessages.push(...messages);

    const usedModel = model || DEFAULT_MODEL;

    // Prepare request to OpenAI API
    const url = `${OPENAI_API_BASE}/chat/completions`;
    const headers = {
      "Content-Type": "application/json",
    };
    // Only attach the API key if provided. In many hosting environments the key
    // should come from a secure secret store rather than a .env file. The
    // absence of a key will cause the API call to fail gracefully.
    if (OPENAI_API_KEY) {
      headers["Authorization"] = `Bearer ${OPENAI_API_KEY}`;
    }
    const body = JSON.stringify({
      model: usedModel,
      messages: finalMessages,
      temperature: typeof temperature === "number" ? temperature : 0.7,
      stream: !!stream,
    });

    const response = await fetch(url, { method: "POST", headers, body });

    // If the API call returns a non‑OK status, propagate the error back to the client
    if (!response.ok) {
      const text = await response.text();
      if (stream) {
        // When streaming, error information is sent via SSE then the
        // connection is closed.
        res.setHeader("Content-Type", "text/event-stream");
        res.write("data: Error: " + text.replace(/\n/g, " ") + "\n\n");
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        return res.status(response.status).json({ error: text });
      }
      return;
    }

    // Streaming branch: parse the SSE from OpenAI and forward it to the client
    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      // Flush initial headers so the client begins receiving data immediately
      res.flushHeaders();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      let buffer = "";
      while (!done) {
        const { value, done: doneReading } = await reader.read();
        done = doneReading;
        if (value) {
          buffer += decoder.decode(value, { stream: !done });
          // The OpenAI streaming response is comprised of lines separated by
          // newlines. Each line that begins with "data: " is a JSON payload
          // containing a delta with the next piece of content. The string
          // "[DONE]" signals the end of the stream.
          const lines = buffer.split("\n");
          buffer = lines.pop() || ""; // preserve any partial line for the next chunk
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;
            const data = trimmed.substring(6);
            if (data === "[DONE]") {
              // Signal completion to the client
              res.write("data: [DONE]\n\n");
              res.end();
              return;
            }
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                // Write each token as its own SSE event. Clients accumulate tokens
                // to build the final response.
                res.write("data: " + delta.replace(/\n/g, " ") + "\n\n");
              }
            } catch {
              // ignore malformed JSON lines
            }
          }
        }
      }
      return;
    }

    // Non‑streaming branch: wait for the full response and return the assistant's message
    const data = await response.json();
    const reply = data?.choices?.[0]?.message?.content || "";
    res.json({ reply });
  } catch (err) {
    // Catch network or parsing errors
    const message = err?.message || String(err);
    if (req.body?.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.write("data: Error: " + message + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.status(500).json({ error: message });
    }
  }
});

// Start the server on the provided port or default to 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server listening on port " + PORT);
});
