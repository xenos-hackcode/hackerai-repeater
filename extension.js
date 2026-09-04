const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

let panel = null;

function activate(context) {
    console.log('HackerAI Repeater activated');

    const openCommand = vscode.commands.registerCommand('hackeraiRepeater.openRepeater', (initialRequest) => {
        createOrShowPanel(context.extensionPath, initialRequest);
    });

    const sendCommand = vscode.commands.registerCommand('hackeraiRepeater.sendToRepeater', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const selection = editor.document.getText(editor.selection);
        if (!selection) {
            vscode.window.showWarningMessage('No text selected');
            return;
        }
        createOrShowPanel(context.extensionPath, selection);
    });

    context.subscriptions.push(openCommand, sendCommand);
}

function createOrShowPanel(extensionPath, initialRequest = '') {
    if (panel) {
        panel.reveal(vscode.ViewColumn.Beside);
        if (initialRequest) {
            panel.webview.postMessage({ type: 'loadRequest', data: initialRequest });
        }
        return;
    }

    panel = vscode.window.createWebviewPanel(
        'hackeraiRepeater.repeaterView',
        'HackerAI Repeater',
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
        }
    );

    const htmlPath = path.join(extensionPath, 'media', 'repeater.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    // Fix resource paths if needed — we used inline everything, so no substitutions needed
    panel.webview.html = html;

    panel.webview.onDidReceiveMessage(async (message) => {
        switch (message.type) {
            case 'sendRequest':
                await handleSendRequest(message, panel);
                break;
            case 'llmCall':
                await handleLLMCall(message, panel);
                break;
            case 'pluginCall':
                await handlePluginCall(message, panel);
                break;
            case 'apiValidate':
                await handleApiValidate(message, panel);
                break;
            case 'log':
                console.log('[Repeater]', message.text);
                break;
        }
    });

    if (initialRequest) {
        panel.webview.postMessage({ type: 'loadRequest', data: initialRequest });
    }

    panel.onDidDispose(() => {
        panel = null;
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