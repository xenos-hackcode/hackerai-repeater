# HackerAI Repeater

An HTTP request builder and repeater for VS Code — build a request, fire it at one or more targets, and inspect the response without leaving the editor. Includes an optional local AI assistant for payload suggestions and response analysis.

## Authorized use only

This extension is built for **authorized security testing** — penetration tests, CTFs, and testing on systems you own or have explicit permission to assess. The optional AI assistant can suggest offensive payloads and must be explicitly enabled (one-time authorization checkbox) before it activates. You are responsible for how you use this tool and its output; verify authorization before testing any target.

## Features

- **Command-driven request builder** — type `/url`, `/headers`, or `/body` in the chat-style input to attach targets, headers, or a body to your next request. Each addition becomes a versioned, editable chip (`URL v1`, `v2`, ...) you can revisit and adjust.
- **Batch sending** — attach multiple URLs under one `/url` entry and send the same request to all of them in one go with `@` or the send button.
- **Full-screen results view** — status, timing, byte count, and expandable response headers/body for every request in a batch.
- **Send from the editor** — select raw HTTP text (or a URL) anywhere in VS Code and send it to the Repeater via the right-click menu or `Ctrl+Alt+R` (`Cmd+Alt+R` on Mac).
- **Local AI assistant (optional)** — suggests payload variants for the current request or analyzes the last response for interesting behavior. Runs entirely against a local [Ollama](https://ollama.com) model on `localhost:11434`; nothing is sent anywhere else.

## Requirements

The AI assistant panel is optional and only activates if you enable it. To use it:

1. Install [Ollama](https://ollama.com) and have it running locally.
2. Pull or create a chat-capable model (any Ollama model works — pick whichever is available in the AI panel's model selector).

The request builder and repeater work with no additional setup.

## Usage

1. Open the Repeater: `Ctrl+Alt+R` / `Cmd+Alt+R`, or run **HackerAI: Open Repeater** from the command palette.
2. Type `/url` and add one or more targets, then `OK`.
3. Optionally add `/headers` and `/body` the same way.
4. Type `@` or click send to fire the request(s).
5. Click a result card to open the full-screen response view.

## License

MIT
