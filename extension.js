const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { exec } = require('child_process');

let activeView = null; // the current webviewView (docked panel tab), if resolved

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

function handleTerminalCall(message, panel) {
    const { requestId, command } = message;
    const cwd = getWorkspaceRoot();
    if (!cwd) {
        panel.webview.postMessage({ type: 'terminalResult', requestId, data: { error: 'No workspace folder is open.' } });
        return;
    }
    exec(command, { cwd, timeout: 60000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        panel.webview.postMessage({
            type: 'terminalResult', requestId,
            data: {
                result: {
                    stdout: stdout.slice(0, 20000),
                    stderr: stderr.slice(0, 20000),
                    exitCode: err ? (err.code != null ? err.code : 1) : 0,
                    error: err && err.killed ? 'Command timed out after 60s' : undefined,
                },
            },
        });
    });
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

// Generic JSON-over-HTTP(S) POST helper, reused for Ollama / OpenAI-compatible /
// Anthropic-shaped endpoints and plugin webhooks.
function postJSON(urlStr, headers, payload, timeoutMs) {
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
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
        req.write(body);
        req.end();
    });
}

// Normalizes a chat completion across providers into { content, toolCalls, promptTokens, responseTokens }.
async function callLLM(messages, tools, apiConfig, localModel) {
    if (!apiConfig) {
        // Local Ollama
        const data = await postJSON('http://127.0.0.1:11434/api/chat', {}, {
            model: localModel || 'xenos',
            messages,
            tools: tools && tools.length ? tools : undefined,
            stream: false,
        }, 180000).catch(err => {
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
        const result = await callLLM(messages, tools, apiConfig, model);
        panel.webview.postMessage({ type: 'llmResult', requestId, data: result });
    } catch (err) {
        panel.webview.postMessage({ type: 'llmResult', requestId, data: { error: err.message } });
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