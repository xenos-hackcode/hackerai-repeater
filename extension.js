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
            case 'aiRequest':
                await handleAIRequest(message, panel);
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

function handleAIRequest(message, panel) {
    const { model, prompt } = message;
    const payload = JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
    });

    return new Promise((resolve) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port: 11434,
            path: '/api/chat',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
            timeout: 120000,
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    panel.webview.postMessage({ type: 'aiResponse', data: { error: `Ollama returned HTTP ${res.statusCode}: ${data.slice(0, 300)}` } });
                    resolve();
                    return;
                }
                try {
                    const parsed = JSON.parse(data);
                    const content = parsed && parsed.message && parsed.message.content;
                    panel.webview.postMessage({
                        type: 'aiResponse',
                        data: {
                            content: content || 'No response content returned.',
                            promptTokens: parsed.prompt_eval_count,
                            responseTokens: parsed.eval_count,
                        }
                    });
                } catch (err) {
                    panel.webview.postMessage({ type: 'aiResponse', data: { error: `Could not parse Ollama response: ${err.message}` } });
                }
                resolve();
            });
        });
        req.on('error', (err) => {
            panel.webview.postMessage({
                type: 'aiResponse',
                data: { error: `Could not reach Ollama at localhost:11434 (${err.message}). Make sure Ollama is running and the model is loaded (ollama run ${model}).` }
            });
            resolve();
        });
        req.on('timeout', () => {
            req.destroy();
            panel.webview.postMessage({ type: 'aiResponse', data: { error: 'Ollama request timed out after 120s.' } });
            resolve();
        });
        req.write(payload);
        req.end();
    });
}

function deactivate() {}

module.exports = { activate, deactivate };