const express = require('express');
const http = require('http');
const os = require('os');
const WebSocket = require('ws');

const CEF_DEBUG_PORT = Number(process.env.CEF_DEBUG_PORT || 9222);
const PORT = Number(process.env.EFB_BROWSER_PORT || 2333);
const DEFAULT_URL = process.env.EFB_BROWSER_HOME || 'https://www.bing.com';
const FRAME_INTERVAL_MS = Number(process.env.EFB_BROWSER_FRAME_MS || 16);
const JPEG_QUALITY = Number(process.env.EFB_BROWSER_JPEG_QUALITY || 60);

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

let cdpSocket = null;
let cdpTargetUrl = null;
let cdpId = 0;
const pending = new Map();
const viewers = new Set();
let captureTimer = null;
let viewport = { width: 1024, height: 680 };
let currentUrl = DEFAULT_URL;
let lastFrameAt = 0;
let captureInProgress = false;
let mainFrameId = null;
let heartbeatInterval = null;
let consecutiveTimeouts = 0;
let lastSuccessfulCapture = Date.now();
let isNavigating = false;
let frameCount = 0;
let lastFpsTime = Date.now();
let currentFps = 0;
let lastUserInteraction = Date.now();
let isReloading = false;
let reloadTimeout = null;
let currentTargetId = null;
let pageCheckInterval = null;

app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

function getLocalIPv4() {
    const nets = os.networkInterfaces();
    for (const items of Object.values(nets)) {
        for (const item of items || []) {
            if (item.family === 'IPv4' && !item.internal) return item.address;
        }
    }
    return '127.0.0.1';
}

async function fetchJson(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
}

async function getAllPages() {
    try {
        const list = await fetchJson(`http://127.0.0.1:${CEF_DEBUG_PORT}/json/list`);
        return list.filter(target => target.type === 'page' && target.webSocketDebuggerUrl);
    } catch (error) {
        console.error('[CDP] Failed to get pages:', error.message);
        return [];
    }
}

async function getNewestPage() {
    const pages = await getAllPages();
    if (pages.length === 0) return null;
    
    let newestPage = pages[0];
    let maxId = pages[0].id;
    for (const page of pages) {
        if (page.id > maxId) {
            maxId = page.id;
            newestPage = page;
        }
    }
    return newestPage;
}

async function checkAndSwitch() {
    try {
        const newestPage = await getNewestPage();
        if (!newestPage) return;
        
        if (newestPage.id !== currentTargetId) {
            console.log('[CDP] Switching to new page:', newestPage.url);
            
            if (cdpSocket) {
                try { cdpSocket.close(); } catch(e) {}
                cdpSocket = null;
            }
            
            currentTargetId = newestPage.id;
            currentUrl = newestPage.url;
            cdpTargetUrl = null;
            
            broadcast({ type: 'url', url: currentUrl });
            broadcast({ type: 'status', connected: false, message: 'Switching page...' });
            
            setTimeout(() => {
                connectCdp().catch(console.error);
            }, 300);
        }
    } catch (err) {
        console.error('[CDP] checkAndSwitch error:', err);
    }
}

async function getCdpUrl() {
    try {
        const pages = await getAllPages();
        let targetPage = null;
        
        if (pages.length > 0) {
            let newestPage = pages[0];
            for (const page of pages) {
                if (page.id > newestPage.id) {
                    newestPage = page;
                }
            }
            targetPage = newestPage;
        }
        
        if (targetPage) {
            currentTargetId = targetPage.id;
            currentUrl = targetPage.url;
            console.log('[CDP] Using page:', currentUrl);
            return targetPage.webSocketDebuggerUrl;
        }

        const created = await fetchJson(
            `http://127.0.0.1:${CEF_DEBUG_PORT}/json/new?${encodeURIComponent(DEFAULT_URL)}`,
            { method: 'PUT' }
        );
        if (!created.webSocketDebuggerUrl) throw new Error('CEF did not expose a page target');
        currentTargetId = created.id;
        currentUrl = created.url;
        console.log('[CDP] Created new page:', created.url);
        return created.webSocketDebuggerUrl;
    } catch (error) {
        console.error('[CDP] Failed to get URL:', error.message);
        throw error;
    }
}

function startPageChecker() {
    if (pageCheckInterval) clearInterval(pageCheckInterval);
    pageCheckInterval = setInterval(() => {
        checkAndSwitch().catch(console.error);
    }, 500);
}

function stopPageChecker() {
    if (pageCheckInterval) {
        clearInterval(pageCheckInterval);
        pageCheckInterval = null;
    }
}
function getAntiDetectionScript() {
    return `
        (function() {
            if (window._efb_patched) return;
            window._efb_patched = true;
            
            if (navigator.webdriver) {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            }
            
            var cdcVars = ['cdc_adoQpoasnfa76pfcZLmcfl_Array', 'cdc_adoQpoasnfa76pfcZLmcfl_Promise', 'cdc_adoQpoasnfa76pfcZLmcfl_Symbol'];
            cdcVars.forEach(function(v) {
                if (window[v]) delete window[v];
            });
        })();
    `;
}

async function connectCdp() {
    const wsUrl = await getCdpUrl();
    if (cdpSocket && cdpSocket.readyState === WebSocket.OPEN && cdpTargetUrl === wsUrl) return;

    if (cdpSocket) {
        try { cdpSocket.close(); } catch(e) {}
        cdpSocket = null;
    }
    cdpTargetUrl = wsUrl;

    await new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(() => reject(new Error('CEF debug socket timeout')), 8000);

        ws.on('open', () => {
            clearTimeout(timeout);
            cdpSocket = ws;
            consecutiveTimeouts = 0;
            console.log('[CDP] Connected');
            resolve();
        });

        ws.on('message', (raw) => {
            try {
                const message = JSON.parse(raw.toString());
                if (message.id && pending.has(message.id)) {
                    const entry = pending.get(message.id);
                    pending.delete(message.id);
                    if (message.error) entry.reject(new Error(message.error.message));
                    else entry.resolve(message.result || {});
                }
                
                if (message.method === 'Page.frameNavigated' && message.params && message.params.frame) {
                    const frame = message.params.frame;
                    if (!frame.parentId || frame.id === mainFrameId) {
                        currentUrl = frame.url;
                        isNavigating = false;
                        broadcast({ type: 'url', url: currentUrl });
                        broadcast({ type: 'loading', loading: false });
                        setTimeout(async () => {
                            try { await cdp('Runtime.evaluate', { expression: getAntiDetectionScript() }); } catch(e) {}
                        }, 1000);
                    }
                }
                
                if (message.method === 'Page.loadEventFired') {
                    broadcast({ type: 'loading', loading: false });
                    isNavigating = false;
                    if (reloadTimeout) clearTimeout(reloadTimeout);
                    isReloading = false;
                    setTimeout(async () => {
                        try { await cdp('Runtime.evaluate', { expression: getAntiDetectionScript() }); } catch(e) {}
                    }, 500);
                }
            } catch (e) {
                console.error('[CDP] Parse error:', e);
            }
        });

        ws.on('close', () => {
            console.log('[CDP] Disconnected');
            cdpSocket = null;
            cdpTargetUrl = null;
            pending.clear();
            broadcast({ type: 'status', connected: false, message: 'CEF disconnected' });
            if (viewers.size > 0) {
                setTimeout(() => {
                    if (viewers.size > 0) connectCdp().catch(console.error);
                }, 2000);
            }
        });

        ws.on('error', (err) => {
            clearTimeout(timeout);
            console.error('[CDP] Socket error:', err.message);
            reject(err);
        });
    });

    await cdp('Page.enable');
    await cdp('Runtime.enable');
    await cdp('Network.enable');
    await cdp('Runtime.evaluate', { expression: getAntiDetectionScript() });
    
    // 不覆盖 User-Agent，让 CEF 保持原生
    
    const tree = await cdp('Page.getFrameTree').catch(() => null);
    if (tree && tree.frameTree && tree.frameTree.frame) {
        mainFrameId = tree.frameTree.frame.id;
        if (tree.frameTree.frame.url) currentUrl = tree.frameTree.frame.url;
    }
    
    await cdp('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: false
    });
    
    broadcast({ type: 'status', connected: true, message: 'CEF connected' });
    broadcast({ type: 'url', url: currentUrl });
}

function cdp(method, params = {}) {
    if (!cdpSocket || cdpSocket.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error('CEF is not connected'));
    }

    const id = ++cdpId;
    cdpSocket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            if (pending.has(id)) {
                pending.delete(id);
                reject(new Error(`${method} timeout`));
            }
        }, 5000);
        pending.set(id, { resolve, reject: (err) => { clearTimeout(timeout); reject(err); } });
    });
}

function broadcast(payload) {
    const text = JSON.stringify(payload);
    for (const viewer of viewers) {
        if (viewer.readyState === WebSocket.OPEN) viewer.send(text);
    }
}

async function captureFrame() {
    if (!viewers.size) {
        stopCapture();
        return;
    }
    if (captureInProgress) return;
    if (isNavigating) return;
    if (isReloading) return;
    
    captureInProgress = true;
    
    try {
        if (!cdpSocket || cdpSocket.readyState !== WebSocket.OPEN) {
            await connectCdp().catch(e => {});
        }
        
        if (!cdpSocket || cdpSocket.readyState !== WebSocket.OPEN) {
            throw new Error('CDP not connected');
        }
        
        const result = await cdp('Page.captureScreenshot', {
            format: 'jpeg',
            quality: JPEG_QUALITY,
            fromSurface: true
        });
        
        lastSuccessfulCapture = Date.now();
        consecutiveTimeouts = 0;
        lastFrameAt = Date.now();
        
        frameCount++;
        const now = Date.now();
        if (now - lastFpsTime >= 1000) {
            currentFps = frameCount;
            frameCount = 0;
            lastFpsTime = now;
        }
        
        broadcast({
            type: 'frame',
            image: 'data:image/jpeg;base64,' + result.data,
            width: viewport.width,
            height: viewport.height,
            url: currentUrl,
            ts: lastFrameAt,
            fps: currentFps
        });
        
    } catch (error) {
        consecutiveTimeouts++;
        
        if (consecutiveTimeouts >= 3) {
            console.log('[CDP] Resetting connection...');
            if (cdpSocket) {
                try { cdpSocket.close(); } catch(e) {}
                cdpSocket = null;
            }
            consecutiveTimeouts = 0;
        }
    } finally {
        captureInProgress = false;
    }
}

function startCapture() {
    if (captureTimer) return;
    const tick = async () => {
        await captureFrame();
        if (captureTimer) {
            const now = Date.now();
            const elapsed = now - lastFrameAt;
            const nextDelay = Math.max(0, FRAME_INTERVAL_MS - elapsed);
            captureTimer = setTimeout(tick, nextDelay);
        }
    };
    captureTimer = setTimeout(tick, 0);
}

function stopCapture() {
    if (!captureTimer) return;
    clearTimeout(captureTimer);
    captureTimer = null;
}

function startHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(async () => {
        if (cdpSocket && cdpSocket.readyState === WebSocket.OPEN) {
            try {
                await cdp('Runtime.evaluate', { expression: '1', returnByValue: true });
            } catch (e) {
                console.log('[CDP] Heartbeat failed');
                if (cdpSocket) {
                    try { cdpSocket.close(); } catch(e2) {}
                    cdpSocket = null;
                }
            }
        }
    }, 15000);
}

async function navigate(url) {
    let target = url;
    if (!/^https?:\/\//i.test(target)) {
        target = 'https://' + target;
    }
    
    console.log('[CDP] Navigating to:', target);
    isNavigating = true;
    
    try {
        await connectCdp();
    } catch (e) {
        broadcast({ type: 'status', connected: false, message: 'CEF connection failed' });
        isNavigating = false;
        return;
    }
    
    currentUrl = target;
    broadcast({ type: 'loading', loading: true });
    broadcast({ type: 'url', url: target });
    
    try {
        await cdp('Page.navigate', { url: target });
        setTimeout(() => {
            isNavigating = false;
            broadcast({ type: 'loading', loading: false });
        }, 5000);
    } catch (error) {
        console.error('[CDP] Navigation error:', error.message);
        isNavigating = false;
        broadcast({ type: 'loading', loading: false });
    }
}

async function navigateHistory(offset) {
    try {
        const history = await cdp('Page.getNavigationHistory');
        const targetIndex = history.currentIndex + offset;
        const entry = history.entries && history.entries[targetIndex];
        if (!entry) return;
        await cdp('Page.navigateToHistoryEntry', { entryId: entry.id });
        currentUrl = entry.url;
        broadcast({ type: 'url', url: currentUrl });
    } catch (e) {}
}

async function handleInput(message) {
    if (message.kind === 'mouse' || message.kind === 'key') {
        lastUserInteraction = Date.now();
    }
    
    if (message.kind === 'resize') {
        viewport = {
            width: Math.max(320, Math.min(1920, Number(message.width) || 1024)),
            height: Math.max(240, Math.min(1080, Number(message.height) || 680))
        };
        if (cdpSocket && cdpSocket.readyState === WebSocket.OPEN) {
            try {
                await cdp('Emulation.setDeviceMetricsOverride', {
                    width: viewport.width,
                    height: viewport.height,
                    deviceScaleFactor: 1,
                    mobile: false
                });
                console.log('[CDP] Viewport:', viewport.width, 'x', viewport.height);
            } catch (e) {}
        }
        return;
    }

    if (!cdpSocket || cdpSocket.readyState !== WebSocket.OPEN) return;

    if (message.kind === 'mouse') {
        try {
            let x = Number(message.x) || 0;
            let y = Number(message.y) || 0;
            x = Math.max(0, Math.min(viewport.width, x));
            y = Math.max(0, Math.min(viewport.height, y));
            
            await cdp('Input.dispatchMouseEvent', {
                type: message.type,
                x: x,
                y: y,
                button: message.button || 'left',
                buttons: Number(message.buttons) || 0,
                deltaX: Number(message.deltaX) || 0,
                deltaY: Number(message.deltaY) || 0,
                clickCount: Number(message.clickCount) || 1,
                modifiers: Number(message.modifiers) || 0
            });
        } catch (e) {}
        return;
    }

    if (message.kind === 'key') {
        try {
            if (message.type === 'keyDown' && message.text && message.text.length === 1) {
                await cdp('Input.insertText', { text: message.text });
                return;
            }
            await cdp('Input.dispatchKeyEvent', {
                type: message.type === 'keyDown' ? 'rawKeyDown' : 'keyUp',
                key: message.key || '',
                code: message.code || '',
                windowsVirtualKeyCode: Number(message.keyCode) || 0,
                nativeVirtualKeyCode: Number(message.keyCode) || 0,
                modifiers: Number(message.modifiers) || 0
            });
        } catch (e) {}
        return;
    }

    if (message.kind === 'text' && message.text) {
        try {
            await cdp('Input.insertText', { text: String(message.text) });
        } catch (e) {}
        return;
    }

    if (message.kind === 'command') {
        if (message.command === 'navigate') await navigate(message.url || DEFAULT_URL);
        if (message.command === 'reload') {
            try {
                isReloading = true;
                await cdp('Page.reload', { ignoreCache: true });
                broadcast({ type: 'loading', loading: true });
                setTimeout(() => {
                    broadcast({ type: 'loading', loading: false });
                    isReloading = false;
                }, 4000);
            } catch (e) {}
        }
        if (message.command === 'back') await navigateHistory(-1);
        if (message.command === 'forward') await navigateHistory(1);
    }
}

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        connected: cdpSocket && cdpSocket.readyState === WebSocket.OPEN,
        url: currentUrl,
        fps: currentFps,
        targetFps: Math.round(1000 / FRAME_INTERVAL_MS),
        viewport: viewport
    });
});

app.post('/api/navigate', async (req, res) => {
    try {
        await navigate(req.body.url || DEFAULT_URL);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/stream') {
        socket.destroy();
        return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
    console.log('[WS] Viewer connected');
    viewers.add(ws);
    ws.send(JSON.stringify({
        type: 'status',
        connected: cdpSocket && cdpSocket.readyState === WebSocket.OPEN,
        message: 'EFB stream connected',
        url: currentUrl,
        fps: currentFps,
        viewport: viewport
    }));
    startCapture();
    startHeartbeat();
    startPageChecker();

    ws.on('message', async (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg.kind === 'ping') return;
            await handleInput(msg);
        } catch (e) {}
    });

    ws.on('close', () => {
        console.log('[WS] Viewer disconnected');
        viewers.delete(ws);
        if (!viewers.size) {
            stopCapture();
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            stopPageChecker();
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('[EFB Browser] http://127.0.0.1:' + PORT);
    console.log('[EFB Browser] http://' + getLocalIPv4() + ':' + PORT);
    console.log('[EFB Browser] Target FPS: ' + Math.round(1000 / FRAME_INTERVAL_MS));
    console.log('[EFB Browser] JPEG Quality: ' + JPEG_QUALITY);
});

//©2026 ASTteam