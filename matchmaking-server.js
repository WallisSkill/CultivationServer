const { WebSocketServer } = require('ws');

function createWebSocketServer({ port = 8080, onConnection } = {}) {
	const wss = new WebSocketServer({ port });
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
	const port = Number(process.env.WS_PORT) || 8080;
	createWebSocketServer({ port });
}