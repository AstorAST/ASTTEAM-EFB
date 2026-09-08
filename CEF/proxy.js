const express = require('express');
const http = require('http');
const app = express();

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.get('/json/version', async (req, res) => {
    try {
        const fetchRes = await fetch('http://localhost:9222/json/version');
        const data = await fetchRes.json();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/devtools/*', (req, res) => {
    const url = 'http://localhost:9222' + req.originalUrl;
    const proxyReq = http.request(url, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
    });
    proxyReq.on('error', (err) => res.status(500).send(err.message));
    req.pipe(proxyReq, { end: true });
});

app.listen(2335, () => console.log('[Proxy] http://localhost:2335'));


//©2026 ASTteam