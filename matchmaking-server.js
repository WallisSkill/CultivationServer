const http = require('http');
const { WebSocketServer } = require('ws');

function createWebSocketServer({ server } = {}) {
    if (!server) throw new Error('HTTP server instance is required');
    const wss = new WebSocketServer({ server });

    const clients = new Map();          // socket -> { id, profile, finding }
    const ids = new Map();              // profileId -> socket
    const waiting = [];

    function cleanup(socket) {
        const info = clients.get(socket);
        if (!info) return;
        
        // 🆕 Thông báo cho bạn bè rằng user đã offline
        if (info.id) {
            // Gửi offline notification cho tất cả client đang kết nối
            clients.forEach((clientInfo, clientSocket) => {
                if (clientSocket !== socket && clientSocket.readyState === 1) {
                    try {
                        clientSocket.send(JSON.stringify({
                            type: 'friend_offline',
                            profileId: info.id
                        }));
                    } catch(e) {
                        console.error('Error sending offline notification:', e);
                    }
                }
            });
        }
        
        clients.delete(socket);
        if (info.id) ids.delete(info.id);
        const idx = waiting.findIndex((w) => w.socket === socket);
        if (idx >= 0) waiting.splice(idx, 1);
    }

    function tryMatch(newEntry) {
        const maxDiff = 1;
        for (let i = 0; i < waiting.length; i++) {
            const entry = waiting[i];
            if (entry.socket === newEntry.socket) continue;
            const a = entry.profile;
            const b = newEntry.profile;
            if (!a || !b) continue;
            const diff = Math.abs((a.realmIndex || 0) - (b.realmIndex || 0));
            if (diff <= maxDiff) {
                waiting.splice(i, 1);
                const payloadA = { type: 'match_found', opponent: b };
                const payloadB = { type: 'match_found', opponent: a };
                entry.socket.send(JSON.stringify(payloadA));
                newEntry.socket.send(JSON.stringify(payloadB));
                return true;
            }
        }
        return false;
    }

    wss.on('connection', (socket) => {
        socket.send(JSON.stringify({ type: 'welcome', message: 'Connected to matchmaking server.' }));

        socket.on('message', (data) => {
            let msg = {};
            try { msg = JSON.parse(data.toString()); } catch {
                socket.send(JSON.stringify({ type: 'info', message: 'Invalid JSON.' }));
                return;
            }

            if (msg.type === 'register' && msg.profile) {
                const profile = msg.profile;
                const id = profile.id;
                if (!id) {
                    socket.send(JSON.stringify({ type: 'info', message: 'Missing profile id.' }));
                    return;
                }
                if (ids.has(id) && ids.get(id) !== socket) {
                    const other = ids.get(id);
                    if (other && other.readyState === 1) other.close(1000, 'Duplicate login');
                }
                clients.set(socket, { id, profile, finding: false });
                ids.set(id, socket);
                socket.send(JSON.stringify({ type: 'info', message: 'Đã đăng ký hồ sơ.' }));
                
                // 🆕 Thông báo cho tất cả client rằng user này đã online
                clients.forEach((clientInfo, clientSocket) => {
                    if (clientSocket !== socket && clientSocket.readyState === 1) {
                        try {
                            clientSocket.send(JSON.stringify({
                                type: 'friend_online',
                                profileId: id,
                                profile: profile
                            }));
                        } catch(e) {
                            console.error('Error sending online notification:', e);
                        }
                    }
                });
                
                return;
            }

            if (msg.type === 'find_match' && msg.profile) {
                const info = clients.get(socket) || {};
                info.profile = msg.profile;
                info.id = msg.profile.id;
                info.finding = true;
                clients.set(socket, info);
                if (info.id) ids.set(info.id, socket);
                const existingIdx = waiting.findIndex((w) => w.socket === socket);
                if (existingIdx >= 0) waiting.splice(existingIdx, 1);
                const entry = { socket, profile: msg.profile };
                if (!tryMatch(entry)) {
                    waiting.push(entry);
                    socket.send(JSON.stringify({ type: 'info', message: 'Đang tìm trận...' }));
                }
                return;
            }

            if (msg.type === 'cancel_find') {
                const info = clients.get(socket);
                if (info) info.finding = false;
                const idx = waiting.findIndex((w) => w.socket === socket);
                if (idx >= 0) waiting.splice(idx, 1);
                socket.send(JSON.stringify({ type: 'info', message: 'Đã hủy tìm trận.' }));
                return;
            }

            if (msg.type === 'pvp_relay' && msg.to) {
                const target = ids.get(msg.to);
                if (!target || target.readyState !== 1) {
                    socket.send(JSON.stringify({ type: 'info', message: 'Đối thủ ngoại tuyến.' }));
                    return;
                }
                target.send(JSON.stringify({
                    type: 'pvp_relay',
                    from: (clients.get(socket) || {}).id,
                    sessionId: msg.sessionId,
                    kind: msg.kind,
                    data: msg.data
                }));
                return;
            }

            // 🆕 Xử lý friend requests với profile lookup
            if (msg.type === 'friend_request' && msg.to && msg.from) {
                const target = ids.get(msg.to);
                if (!target || target.readyState !== 1) {
                    socket.send(JSON.stringify({ type: 'info', message: 'Đạo hữu không online.' }));
                    return;
                }
                
                // 🆕 Gửi thông báo cho người gửi rằng đã tìm thấy target
                const targetInfo = clients.get(target);
                if (targetInfo && targetInfo.profile) {
                    socket.send(JSON.stringify({ 
                        type: 'friend_request_sent', 
                        targetName: targetInfo.profile.name,
                        targetProfile: targetInfo.profile
                    }));
                }
                
                target.send(JSON.stringify({
                    type: 'friend_request',
                    from: msg.from,
                    fromName: msg.fromName,
                    fromProfile: msg.fromProfile
                }));
                return;
            }

            if (msg.type === 'friend_accept' && msg.to && msg.from) {
                const target = ids.get(msg.to);
                if (target && target.readyState === 1) {
                    target.send(JSON.stringify({
                        type: 'friend_accept',
                        from: msg.from,
                        fromName: msg.fromName,
                        fromProfile: msg.fromProfile
                    }));
                }
                return;
            }

            if (msg.type === 'friend_reject' && msg.to && msg.from) {
                const target = ids.get(msg.to);
                if (target && target.readyState === 1) {
                    target.send(JSON.stringify({
                        type: 'friend_reject',
                        from: msg.from
                    }));
                }
                return;
            }

            if (msg.type === 'friend_remove' && msg.to && msg.from) {
                const target = ids.get(msg.to);
                if (target && target.readyState === 1) {
                    target.send(JSON.stringify({
                        type: 'friend_remove',
                        from: msg.from
                    }));
                }
                return;
            }

            if (msg.type === 'pvp_invite' && msg.to && msg.from) {
                const target = ids.get(msg.to);
                if (!target || target.readyState !== 1) {
                    socket.send(JSON.stringify({ type: 'info', message: 'Đạo hữu không online.' }));
                    return;
                }
                target.send(JSON.stringify({
                    type: 'pvp_invite',
                    from: msg.from,
                    fromName: msg.fromName,
                    fromProfile: msg.fromProfile
                }));
                return;
            }

            // 🆕 Xử lý pvp_accept
            if (msg.type === 'pvp_accept' && msg.to && msg.from) {
                const target = ids.get(msg.to);
                if (!target || target.readyState !== 1) {
                    socket.send(JSON.stringify({ type: 'info', message: 'Đối thủ đã offline.' }));
                    return;
                }
                target.send(JSON.stringify({
                    type: 'pvp_accept',
                    from: msg.from,
                    fromName: msg.fromName,
                    fromProfile: msg.fromProfile
                }));
                return;
            }

            // 🆕 Xử lý pvp_decline
            if (msg.type === 'pvp_decline' && msg.to && msg.from) {
                const target = ids.get(msg.to);
                if (target && target.readyState === 1) {
                    target.send(JSON.stringify({
                        type: 'pvp_decline',
                        from: msg.from
                    }));
                }
                return;
            }

            socket.send(JSON.stringify({ type: 'info', message: 'Lệnh không xác định.' }));
        });

        socket.on('close', () => cleanup(socket));
        socket.on('error', () => cleanup(socket));
    });

    const addr = server.address();
    const port = typeof addr === 'string' ? addr : addr?.port;
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