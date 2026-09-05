const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { exec } = require('child_process');
const net = require('net');
const tls = require('tls');

let activeView = null; // the current webviewView (docked panel tab), if resolved
const pendingLLMRequests = {};       // requestId -> http.ClientRequest, so Stop can actually kill an in-flight generation
const pendingTerminalProcesses = {}; // requestId -> ChildProcess, so Stop can actually kill a running command

class RepeaterViewProvider {
    constructor(extensionPath) {
        this.extensionPath = extensionPath;
    }

    resolveWebviewView(webviewView) {
        activeView = webviewView;
        webviewView.webview.options = { enableScripts: true };

        const htmlPath = path.join(this.extensionPath, 'media', 'repeater.html');
        webviewView.webview.html = fs.readFileSync(htmlPath, 'utf8');

        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'sendRequest':
                    await handleSendRequest(message, webviewView);
                    break;
                case 'llmCall':
                    await handleLLMCall(message, webviewView);
                    break;
                case 'pluginCall':
                    await handlePluginCall(message, webviewView);
                    break;
                case 'apiValidate':
                    await handleApiValidate(message, webviewView);
                    break;
                case 'fsCall':
                    await handleFsCall(message, webviewView);
                    break;
                case 'terminalCall':
                    await handleTerminalCall(message, webviewView);
                    break;
                case 'listDevicesCall':
                    await handleListDevices(message, webviewView);
                    break;
                case 'webSearchCall':
                    await handleWebSearch(message, webviewView);
                    break;
                case 'torFetchCall':
                    await handleTorFetch(message, webviewView);
                    break;
                case 'apiFetchCall':
                    await handleApiFetch(message, webviewView);
                    break;
                case 'wikipediaCall':
                    await handleWikipediaSearch(message, webviewView);
                    break;
                case 'cancelLLM':
                    handleCancelLLM(message);
                    break;
                case 'cancelTerminal':
                    handleCancelTerminal(message);
                    break;
                case 'log':
                    console.log('[Repeater]', message.text);
                    break;
            }
        });

        webviewView.onDidDispose(() => {
            if (activeView === webviewView) activeView = null;
        });
    }
}

function activate(context) {
    console.log('HackerAI Repeater activated');

    const provider = new RepeaterViewProvider(context.extensionPath);
    const providerRegistration = vscode.window.registerWebviewViewProvider(
        'hackeraiRepeater.view',
        provider,
        { webviewOptions: { retainContextWhenHidden: true } }
    );

    const openCommand = vscode.commands.registerCommand('hackeraiRepeater.openRepeater', async (initialRequest) => {
        await vscode.commands.executeCommand('hackeraiRepeater.view.focus');
        if (initialRequest && activeView) {
            activeView.webview.postMessage({ type: 'loadRequest', data: initialRequest });
        }
    });

    const sendCommand = vscode.commands.registerCommand('hackeraiRepeater.sendToRepeater', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const selection = editor.document.getText(editor.selection);
        if (!selection) {
            vscode.window.showWarningMessage('No text selected');
            return;
        }
        await vscode.commands.executeCommand('hackeraiRepeater.view.focus');
        if (activeView) {
            activeView.webview.postMessage({ type: 'loadRequest', data: selection });
        }
    });

    context.subscriptions.push(providerRegistration, openCommand, sendCommand);
}

function getWorkspaceRoot() {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders[0] ? folders[0].uri.fsPath : null;
}

// Resolves a relative path against the open workspace folder, rejecting anything
// that would escape it (basic guard against path traversal, accidental or otherwise).
function resolveSafePath(relPath) {
    const root = getWorkspaceRoot();
    if (!root) throw new Error('No workspace folder is open.');
    const resolvedRoot = path.resolve(root);
    const target = path.resolve(resolvedRoot, relPath || '.');
    if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
        throw new Error('Path escapes the open workspace folder.');
    }
    return target;
}

async function handleFsCall(message, panel) {
    const { requestId, op, path: relPath, content } = message;
    try {
        const target = resolveSafePath(relPath);
        let result;
        if (op === 'list_directory') {
            const entries = fs.readdirSync(target, { withFileTypes: true });
            result = entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }));
        } else if (op === 'read_file') {
            const text = fs.readFileSync(target, 'utf8');
            result = text.length > 100000 ? text.slice(0, 100000) + '\n...[truncated]' : text;
        } else if (op === 'write_file') {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, content || '', 'utf8');
            result = { ok: true, path: relPath };
        } else {
            throw new Error(`Unknown filesystem operation: ${op}`);
        }
        panel.webview.postMessage({ type: 'fsResult', requestId, data: { result } });
    } catch (err) {
        panel.webview.postMessage({ type: 'fsResult', requestId, data: { error: err.message } });
    }
}

// Best-effort Stop support: the webview resolves its own waiting promise immediately
// (see requestStop() in repeater.html) so the UI never hangs on these, but without this
// the underlying Ollama generation / shell command would keep running in the background
// for no reason after the user has already stopped the task.
function handleCancelLLM(message) {
    const req = pendingLLMRequests[message.requestId];
    if (req) { req.destroy(); delete pendingLLMRequests[message.requestId]; }
}
function handleCancelTerminal(message) {
    const entry = pendingTerminalProcesses[message.requestId];
    if (entry && entry.child && entry.child.pid) {
        entry.stoppedByUser = true;
        if (process.platform === 'win32') {
            exec(`taskkill /pid ${entry.child.pid} /t /f`);
        } else {
            entry.child.kill('SIGKILL');
        }
    }
    delete pendingTerminalProcesses[message.requestId];
}

// Keeps command output small enough that a few verbose commands (npm install, git clone,
// nmap) don't balloon the model's own context -- the full output was never shown to the
// user anywhere anyway (only a short preview in the step log), so this only trims what
// goes into the conversation itself. Keeps the TAIL, not the head: for most CLI tools the
// actual result (an error, a summary line, "up to date") is at the end, not the start.
const TERMINAL_OUTPUT_CAP = 3000;
function truncateOutput(text) {
    if (text.length <= TERMINAL_OUTPUT_CAP) return text;
    return `...[truncated ${text.length - TERMINAL_OUTPUT_CAP} earlier characters]\n` + text.slice(-TERMINAL_OUTPUT_CAP);
}

function handleTerminalCall(message, panel) {
    const { requestId, command, directory } = message;
    // A message handler must ALWAYS post a response, even on garbage input --
    // exec() throws synchronously for a non-string command, which previously left
    // the webview's promise waiting forever with no way to ever resolve it.
    if (typeof command !== 'string' || !command.trim()) {
        panel.webview.postMessage({ type: 'terminalResult', requestId, data: { error: `No command provided (got: ${JSON.stringify(command)}).` } });
        return;
    }
    let cwd = getWorkspaceRoot();
    if (directory && typeof directory === 'string') {
        if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
            panel.webview.postMessage({ type: 'terminalResult', requestId, data: { error: `Directory does not exist: ${directory}` } });
            return;
        }
        cwd = directory;
    }
    if (!cwd) {
        panel.webview.postMessage({ type: 'terminalResult', requestId, data: { error: 'No directory specified and no workspace folder is open.' } });
        return;
    }
    try {
        const entry = { child: null, stoppedByUser: false };
        const child = exec(command, { cwd, timeout: 60000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            delete pendingTerminalProcesses[requestId];
            panel.webview.postMessage({
                type: 'terminalResult', requestId,
                data: {
                    result: {
                        stdout: truncateOutput(stdout),
                        stderr: truncateOutput(stderr),
                        exitCode: err ? (err.code != null ? err.code : 1) : 0,
                        error: err && err.killed ? (entry.stoppedByUser ? 'Stopped by user' : 'Command timed out after 60s') : undefined,
                    },
                },
            });
        });
        entry.child = child;
        pendingTerminalProcesses[requestId] = entry;
    } catch (err) {
        panel.webview.postMessage({ type: 'terminalResult', requestId, data: { error: `Could not run command: ${err.message}` } });
    }
}

// Parses `adb devices -l` output into structured rows, e.g.:
// "R58N90ABCDE     device usb:1-1 product:redfin model:Pixel_5 device:redfin transport_id:3"
function parseAdbDevices(output) {
    return output
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('List of devices'))
        .map(line => {
            const [id, state, ...rest] = line.split(/\s+/);
            const info = {};
            rest.forEach(tok => {
                const idx = tok.indexOf(':');
                if (idx > 0) info[tok.slice(0, idx)] = tok.slice(idx + 1);
            });
            return { id, state, model: info.model, product: info.product, device: info.device };
        });
}

function handleListDevices(message, panel) {
    const { requestId } = message;
    exec('adb devices -l', { timeout: 15000 }, (err, stdout) => {
        if (err) {
            const notFound = /not found|ENOENT|is not recognized/i.test(err.message);
            panel.webview.postMessage({
                type: 'listDevicesResult', requestId,
                data: { error: notFound ? 'adb not found -- install Android SDK Platform Tools and make sure adb is on your PATH.' : err.message },
            });
            return;
        }
        panel.webview.postMessage({ type: 'listDevicesResult', requestId, data: { result: parseAdbDevices(stdout) } });
    });
}

// DuckDuckGo's only public, keyless endpoint is the Instant Answer API -- infoboxes and
// related topics, not full web results. Honest limitation, not a full search replacement.
async function handleWebSearch(message, panel) {
    const { requestId, query } = message;
    try {
        const data = await getJSON(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, {});
        const parsed = JSON.parse(data);
        const results = [];
        if (parsed.AbstractText) results.push({ title: parsed.Heading, url: parsed.AbstractURL, description: parsed.AbstractText });
        (parsed.RelatedTopics || []).forEach(t => {
            if (t.Text && t.FirstURL) results.push({ title: t.Text, url: t.FirstURL });
        });
        panel.webview.postMessage({
            type: 'webSearchResult', requestId,
            data: { result: { provider: 'duckduckgo-instant-answer (limited, not full web search)', results: results.slice(0, 8) } },
        });
    } catch (err) {
        panel.webview.postMessage({ type: 'webSearchResult', requestId, data: { error: err.message } });
    }
}

// Wikipedia's search API is free and keyless -- no signup, unlike Google/Brave.
async function handleWikipediaSearch(message, panel) {
    const { requestId, query } = message;
    try {
        const data = await getJSON(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=5`, { 'User-Agent': 'HackerAI-Repeater/1.0' });
        const parsed = JSON.parse(data);
        const results = ((parsed.query && parsed.query.search) || []).map(r => ({
            title: r.title,
            url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
            snippet: r.snippet.replace(/<[^>]+>/g, ''),
        }));
        panel.webview.postMessage({ type: 'wikipediaResult', requestId, data: { result: results } });
    } catch (err) {
        panel.webview.postMessage({ type: 'wikipediaResult', requestId, data: { error: err.message } });
    }
}

// Minimal hand-rolled SOCKS5 CONNECT client (no-auth) -- enough to tunnel a single
// request through a locally running Tor client's SOCKS proxy (default 127.0.0.1:9050).
function socksConnect(proxyHost, proxyPort, targetHost, targetPort) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(proxyPort, proxyHost, () => {
            socket.write(Buffer.from([0x05, 0x01, 0x00]));
        });
        let stage = 0;
        socket.on('error', reject);
        socket.on('data', (data) => {
            if (stage === 0) {
                if (data[0] !== 0x05 || data[1] !== 0x00) {
                    socket.destroy();
                    reject(new Error(`SOCKS5 handshake failed -- is Tor running on ${proxyHost}:${proxyPort}?`));
                    return;
                }
                const hostBuf = Buffer.from(targetHost, 'utf8');
                socket.write(Buffer.concat([
                    Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
                    hostBuf,
                    Buffer.from([targetPort >> 8, targetPort & 0xff]),
                ]));
                stage = 1;
            } else if (stage === 1) {
                if (data[1] !== 0x00) {
                    socket.destroy();
                    reject(new Error(`SOCKS5 CONNECT failed (code ${data[1]}) -- target unreachable via Tor.`));
                    return;
                }
                stage = 2;
                resolve(socket);
            }
        });
    });
}

function torFetch(urlStr, proxyHost, proxyPort, timeoutMs) {
    return new Promise((resolve, reject) => {
        let parsedUrl;
        try { parsedUrl = new URL(urlStr); } catch (err) { reject(new Error(`Invalid URL: ${urlStr}`)); return; }
        const isHttps = parsedUrl.protocol === 'https:';
        const targetPort = parsedUrl.port ? parseInt(parsedUrl.port) : (isHttps ? 443 : 80);

        socksConnect(proxyHost, proxyPort, parsedUrl.hostname, targetPort).then((rawSocket) => {
            rawSocket.setTimeout(timeoutMs || 30000, () => { rawSocket.destroy(); reject(new Error('Tor fetch timed out')); });

            const sendRequestOver = (sock) => {
                let data = Buffer.alloc(0);
                sock.on('data', chunk => { data = Buffer.concat([data, chunk]); });
                sock.on('end', () => {
                    const raw = data.toString('utf8');
                    const sepIdx = raw.indexOf('\r\n\r\n');
                    const headerPart = sepIdx >= 0 ? raw.slice(0, sepIdx) : raw;
                    const bodyPart = sepIdx >= 0 ? raw.slice(sepIdx + 4) : '';
                    const statusMatch = (headerPart.split('\r\n')[0] || '').match(/HTTP\/\d\.\d (\d+)/);
                    resolve({ statusCode: statusMatch ? parseInt(statusMatch[1]) : 0, body: bodyPart.slice(0, 50000) });
                });
                sock.on('error', reject);
                sock.write([
                    `GET ${parsedUrl.pathname + parsedUrl.search || '/'} HTTP/1.1`,
                    `Host: ${parsedUrl.hostname}`,
                    'User-Agent: Mozilla/5.0',
                    'Connection: close',
                    '', '',
                ].join('\r\n'));
            };

            if (isHttps) {
                const tlsSocket = tls.connect({ socket: rawSocket, servername: parsedUrl.hostname, rejectUnauthorized: false }, () => sendRequestOver(tlsSocket));
                tlsSocket.on('error', reject);
            } else {
                sendRequestOver(rawSocket);
            }
        }).catch(reject);
    });
}

async function handleTorFetch(message, panel) {
    const { requestId, url } = message;
    try {
        const result = await torFetch(url, '127.0.0.1', 9050, 30000);
        panel.webview.postMessage({ type: 'torFetchResult', requestId, data: { result } });
    } catch (err) {
        panel.webview.postMessage({
            type: 'torFetchResult', requestId,
            data: { error: `${err.message} Make sure Tor (Tor Browser or the tor service) is running locally with its SOCKS proxy on 127.0.0.1:9050.` },
        });
    }
}

async function handleSendRequest(message, panel) {
    const { requestId, method, url, headers, body, followRedirects } = message;

    if (!url) {
        panel.webview.postMessage({ type: 'response', requestId, data: { error: 'URL is required' } });
        return;
    }

    try {
        const parsedUrl = new URL(url);
        const isHttps = parsedUrl.protocol === 'https:';
        const port = parsedUrl.port || (isHttps ? 443 : 80);

        // Parse headers
        let headerObj = {};
        if (headers && typeof headers === 'string' && headers.trim()) {
            headers.split('\n').forEach(line => {
                const idx = line.indexOf(':');
                if (idx > 0) {
                    const key = line.slice(0, idx).trim();
                    const val = line.slice(idx + 1).trim();
                    if (key && val) headerObj[key] = val;
                }
            });
        }

        const options = {
            hostname: parsedUrl.hostname,
            port: parseInt(port),
            path: parsedUrl.pathname + parsedUrl.search,
            method: method.toUpperCase(),
            headers: headerObj,
            rejectUnauthorized: false,
            timeout: 30000,
        };

        const startTime = Date.now();
        const lib = isHttps ? https : http;

        const doRequest = (opts) => new Promise((resolve, reject) => {
            const req = lib.request(opts, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({
                    statusCode: res.statusCode,
                    statusMessage: res.statusMessage || '',
                    headers: res.headers,
                    body: data,
                    timing: Date.now() - startTime,
                }));
            });
            req.on('error', reject);
            req.setTimeout(30000, () => {
                req.destroy();
                reject(new Error('Request timed out after 30s'));
            });
            if (body && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
                req.write(body);
            }
            req.end();
        });

        let response = await doRequest(options);

        // Handle redirects manually
        let redirectCount = 0;
        while (followRedirects && [301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirectCount < 5) {
            redirectCount++;
            const redirectUrl = new URL(response.headers.location, url);
            const redirectOpts = {
                hostname: redirectUrl.hostname,
                port: redirectUrl.port || (redirectUrl.protocol === 'https:' ? 443 : 80),
                path: redirectUrl.pathname + redirectUrl.search,
                method: method.toUpperCase(),
                headers: headerObj,
                rejectUnauthorized: false,
                timeout: 30000,
            };
            const redirectLib = redirectUrl.protocol === 'https:' ? https : http;
            response = await doRequest(redirectOpts);
            response.redirected = true;
            response.finalUrl = redirectUrl.href;
        }

        panel.webview.postMessage({ type: 'response', requestId, data: response });

    } catch (err) {
        panel.webview.postMessage({
            type: 'response',
            requestId,
            data: { error: err.message }
        });
    }
}

// Direct HTTP(S) call to any API endpoint the agent wants to reach -- unlike send_request
// this doesn't go through the manual URL/headers/body chips, and unlike web_search/tor_fetch
// it isn't scoped to one service, so it's the general-purpose "call a real API" tool.
async function handleApiFetch(message, panel) {
    const { requestId, method, url, headers, body } = message;
    if (!url || typeof url !== 'string') {
        panel.webview.postMessage({ type: 'apiFetchResult', requestId, data: { error: 'A url is required.' } });
        return;
    }
    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    } catch (err) {
        panel.webview.postMessage({ type: 'apiFetchResult', requestId, data: { error: `Invalid URL: ${url}` } });
        return;
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        panel.webview.postMessage({ type: 'apiFetchResult', requestId, data: { error: 'Only http:// and https:// URLs are supported.' } });
        return;
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;
    const httpMethod = (method || 'GET').toUpperCase();
    const headerObj = Object.assign({}, headers && typeof headers === 'object' ? headers : {});
    const bodyStr = body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    if (bodyStr != null && !Object.keys(headerObj).some(k => k.toLowerCase() === 'content-type')) {
        headerObj['Content-Type'] = 'application/json';
    }

    const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: httpMethod,
        headers: headerObj,
        timeout: 30000,
    };

    try {
        const result = await new Promise((resolve, reject) => {
            const req = lib.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({
                    statusCode: res.statusCode,
                    statusMessage: res.statusMessage || '',
                    headers: res.headers,
                    body: data.slice(0, 20000),
                }));
            });
            req.on('error', reject);
            req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timed out after 30s')); });
            if (bodyStr != null && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(httpMethod)) req.write(bodyStr);
            req.end();
        });
        panel.webview.postMessage({ type: 'apiFetchResult', requestId, data: { result } });
    } catch (err) {
        panel.webview.postMessage({ type: 'apiFetchResult', requestId, data: { error: err.message } });
    }
}

// Generic JSON-over-HTTP(S) POST helper, reused for Ollama / OpenAI-compatible /
// Anthropic-shaped endpoints and plugin webhooks.
function postJSON(urlStr, headers, payload, timeoutMs, onRequest) {
    return new Promise((resolve, reject) => {
        let parsedUrl;
        try {
            parsedUrl = new URL(urlStr);
        } catch (err) {
            reject(new Error(`Invalid URL: ${urlStr}`));
            return;
        }
        const isHttps = parsedUrl.protocol === 'https:';
        const lib = isHttps ? https : http;
        const body = JSON.stringify(payload);
        const req = lib.request({
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'POST',
            headers: Object.assign({
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            }, headers || {}),
            rejectUnauthorized: false,
            timeout: timeoutMs || 120000,
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
                    return;
                }
                try {
                    resolve(JSON.parse(data));
                } catch (err) {
                    reject(new Error(`Could not parse response JSON: ${err.message}`));
                }
            });
        });
        if (onRequest) onRequest(req);
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
        req.write(body);
        req.end();
    });
}

// Normalizes a chat completion across providers into { content, toolCalls, promptTokens, responseTokens }.
async function callLLM(messages, tools, apiConfig, localModel, requestId) {
    if (!apiConfig) {
        // Local Ollama
        const data = await postJSON('http://127.0.0.1:11434/api/chat', {}, {
            model: localModel || 'xenos',
            messages,
            tools: tools && tools.length ? tools : undefined,
            stream: false,
        }, 600000, requestId ? (req) => { pendingLLMRequests[requestId] = req; } : undefined).catch(err => {
            throw new Error(`Could not reach Ollama at localhost:11434 (${err.message}). Make sure Ollama is running and the model is loaded.`);
        });
        const msg = data.message || {};
        return {
            content: msg.content || '',
            toolCalls: (msg.tool_calls || []).map(tc => ({
                id: tc.id || `${Date.now()}`,
                name: tc.function && tc.function.name,
                arguments: tc.function && tc.function.arguments,
            })),
            promptTokens: data.prompt_eval_count,
            responseTokens: data.eval_count,
        };
    }

    if (apiConfig.kind === 'anthropic') {
        const systemMsg = messages.find(m => m.role === 'system');
        const rest = messages.filter(m => m.role !== 'system').map(m => ({
            role: m.role === 'tool' ? 'user' : m.role,
            content: m.role === 'tool'
                ? [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }]
                : m.content,
        }));
        const data = await postJSON(
            (apiConfig.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages',
            { 'x-api-key': apiConfig.apiKey, 'anthropic-version': '2023-06-01' },
            {
                model: apiConfig.model,
                max_tokens: 1536,
                system: systemMsg ? systemMsg.content : undefined,
                messages: rest,
                tools: tools && tools.length ? tools.map(t => ({
                    name: t.function.name,
                    description: t.function.description,
                    input_schema: t.function.parameters,
                })) : undefined,
            }
        );
        const content = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        const toolCalls = (data.content || []).filter(b => b.type === 'tool_use').map(b => ({
            id: b.id, name: b.name, arguments: JSON.stringify(b.input || {}),
        }));
        return {
            content, toolCalls,
            promptTokens: data.usage && data.usage.input_tokens,
            responseTokens: data.usage && data.usage.output_tokens,
        };
    }

    // OpenAI-compatible (default for any custom apiConfig without kind 'anthropic')
    const data = await postJSON(
        (apiConfig.baseUrl || '').replace(/\/$/, '') + '/chat/completions',
        { Authorization: `Bearer ${apiConfig.apiKey}` },
        { model: apiConfig.model, messages, tools: tools && tools.length ? tools : undefined }
    );
    const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
    return {
        content: msg.content || '',
        toolCalls: (msg.tool_calls || []).map(tc => ({
            id: tc.id, name: tc.function && tc.function.name, arguments: tc.function && tc.function.arguments,
        })),
        promptTokens: data.usage && data.usage.prompt_tokens,
        responseTokens: data.usage && data.usage.completion_tokens,
    };
}

async function handleLLMCall(message, panel) {
    const { requestId, messages, tools, apiConfig, model } = message;
    try {
        const result = await callLLM(messages, tools, apiConfig, model, requestId);
        panel.webview.postMessage({ type: 'llmResult', requestId, data: result });
    } catch (err) {
        panel.webview.postMessage({ type: 'llmResult', requestId, data: { error: err.message } });
    } finally {
        delete pendingLLMRequests[requestId];
    }
}

async function handlePluginCall(message, panel) {
    const { requestId, url, args } = message;
    try {
        const data = await postJSON(url, {}, args || {}, 60000);
        panel.webview.postMessage({ type: 'pluginResult', requestId, data: { result: data } });
    } catch (err) {
        panel.webview.postMessage({ type: 'pluginResult', requestId, data: { error: err.message } });
    }
}

// Known providers so /api only needs a name + key. "openrouter" alone covers most other
// models too, since it proxies to nearly everything -- that's the practical answer to
// "we want lots of providers" without a bespoke integration per one.
const PROVIDER_PRESETS = {
    openai: { kind: 'openai', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
    anthropic: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-5' },
    claude: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-5' },
    openrouter: { kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openrouter/auto' },
    groq: { kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile' },
    mistral: { kind: 'openai', baseUrl: 'https://api.mistral.ai/v1', defaultModel: 'mistral-large-latest' },
};
function resolveProvider(name, baseUrlOverride) {
    const key = String(name || '').toLowerCase().replace(/[^a-z]/g, '');
    const preset = PROVIDER_PRESETS[key];
    if (preset) return { kind: preset.kind, baseUrl: baseUrlOverride || preset.baseUrl, defaultModel: preset.defaultModel };
    if (baseUrlOverride) return { kind: 'openai', baseUrl: baseUrlOverride, defaultModel: '' };
    return null;
}

function getJSON(urlStr, headers, timeoutMs) {
    return new Promise((resolve, reject) => {
        let parsedUrl;
        try { parsedUrl = new URL(urlStr); } catch (err) { reject(new Error(`Invalid URL: ${urlStr}`)); return; }
        const isHttps = parsedUrl.protocol === 'https:';
        const lib = isHttps ? https : http;
        const req = lib.request({
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: headers || {},
            rejectUnauthorized: false,
            timeout: timeoutMs || 15000,
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                resolve(data);
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timed out')); });
        req.end();
    });
}

async function handleApiValidate(message, panel) {
    const { requestId, name, apiKey, baseUrl } = message;
    const resolved = resolveProvider(name, baseUrl);
    if (!resolved) {
        panel.webview.postMessage({ type: 'apiValidateResult', requestId, data: { ok: false, message: `Unknown provider "${name}" -- add a base URL for a custom endpoint.` } });
        return;
    }
    try {
        if (resolved.kind === 'anthropic') {
            await getJSON(resolved.baseUrl.replace(/\/$/, '') + '/v1/models', { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' });
        } else {
            await getJSON(resolved.baseUrl.replace(/\/$/, '') + '/models', { Authorization: `Bearer ${apiKey}` });
        }
        panel.webview.postMessage({
            type: 'apiValidateResult', requestId,
            data: { ok: true, message: `"${name}" -- key verified.`, kind: resolved.kind, baseUrl: resolved.baseUrl, defaultModel: resolved.defaultModel },
        });
    } catch (err) {
        panel.webview.postMessage({
            type: 'apiValidateResult', requestId,
            data: { ok: false, message: `"${name}" -- could not verify (${err.message}). Saved anyway; double-check the key.`, kind: resolved.kind, baseUrl: resolved.baseUrl, defaultModel: resolved.defaultModel },
        });
    }
}

function deactivate() {}

module.exports = { activate, deactivate };