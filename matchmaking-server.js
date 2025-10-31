const { WebSocketServer } = require('ws');

function createWebSocketServer({ server, onConnection } = {}) {
	const wss = new WebSocketServer({ server });
	wss.on('connection', (socket, request) => {
		socket.send(JSON.stringify({ type: 'welcome', message: 'Connected to websocket server.' }));
		socket.on('message', (data) => {
			socket.send(JSON.stringify({ type: 'echo', payload: data.toString() }));
		});
		socket.on('close', (code, reason) => {
			console.log(`Client disconnected (${code}): ${reason.toString() || 'no reason'}`);
		});
		if (typeof onConnection === 'function') {
			onConnection(socket, request);
		}
	});
	console.log(`WebSocket server is running on ws://localhost:${port}`);
	return wss;
}

module.exports = { createWebSocketServer };

if (require.main === module) {
    const port = Number(process.env.PORT || process.env.WS_PORT) || 8080;
    const httpServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
    });
    httpServer.listen(port, () => {
        console.log(`HTTP listening on :${port}`);
        createWebSocketServer({ server: httpServer });
    });
}