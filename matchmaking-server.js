const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');

const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, 'tianjiao.json');
const SAVE_INTERVAL_MS = 30000;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const POSITION_MIN_MS = 100;
const SAY_MAX_LENGTH = 120;
const NAME_MAX_LENGTH = 24;
const LOC_MAX_LENGTH = 40;
const BOARD_SIZE = 10;
const FIRST_REPORT_MAX = 500;
const KILLS_PER_SECOND = 1;

/* Điểm một con quái ở cảnh giới realm, khớp với renownPoints của game */
function maxPointsPerKill(realm) {
    return Math.round(Math.pow(10, (Number(realm) || 0) / 2));
}

/* Bảng thiên kiêu: profileId -> { name, token, scores: { loc: { score, at } } } */
function loadRecords() {
    try {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function createWebSocketServer({ server } = {}) {
    if (!server) throw new Error('HTTP server instance is required');
    const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD_BYTES });

    const clients = new Map();          // socket -> { id, profile, finding }
    const ids = new Map();              // profileId -> socket
    const waiting = [];
    const records = loadRecords();
    let recordsDirty = false;

    const saveTimer = setInterval(() => {
        if (!recordsDirty) return;
        recordsDirty = false;
        fs.writeFile(DATA_FILE, JSON.stringify(records), err => {
            if (err) console.error('Error saving tianjiao:', err);
        });
    }, SAVE_INTERVAL_MS);
    saveTimer.unref();

    function sendTo(socket, payload) {
        if (socket.readyState === 1) socket.send(JSON.stringify(payload));
    }

    function socketsAt(loc, except) {
        const out = [];
        clients.forEach((info, clientSocket) => {
            if (info.loc === loc && clientSocket !== except) out.push(clientSocket);
        });
        return out;
    }

    function publicPlayer(info) {
        const p = info.profile || {};
        return { id: info.id, name: p.name, look: p.look, realmIndex: p.realmIndex, realmStage: p.realmStage, x: info.x, y: info.y };
    }

    function leaveLocation(socket, info) {
        if (!info.loc) return;
        socketsAt(info.loc, socket).forEach(s => sendTo(s, { type: 'world_leave', id: info.id }));
        info.loc = null;
    }

    function tianjiaoBoard(loc) {
        return Object.entries(records)
            .filter(([, record]) => record.scores[loc])
            .map(([id, record]) => ({ id, name: record.name, score: record.scores[loc].score }))
            .sort((a, b) => b.score - a.score)
            .slice(0, BOARD_SIZE);
    }

    /* Điểm do máy khách báo: chỉ tăng, và không tăng nhanh hơn tốc độ săn tối đa */
    function reportScore(info, msg) {
        const token = String(msg.token || '');
        const loc = String(msg.loc || '').slice(0, LOC_MAX_LENGTH);
        const score = Math.floor(Number(msg.score));
        if (!info.id || !token || !loc || !Number.isFinite(score) || score <= 0) return;
        const record = records[info.id] || (records[info.id] = { token, name: '', scores: {} });
        if (record.token !== token) return;
        record.name = String(info.profile?.name || '').slice(0, NAME_MAX_LENGTH);
        const now = Date.now();
        const entry = record.scores[loc];
        const points = maxPointsPerKill(info.profile?.realmIndex);
        const allowed = entry
            ? entry.score + Math.ceil((now - entry.at) / 1000 * KILLS_PER_SECOND) * points
            : FIRST_REPORT_MAX * points;
        const next = Math.min(score, allowed);
        if (entry && next <= entry.score) return;
        record.scores[loc] = { score: next, at: now };
        recordsDirty = true;
    }

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
        
        leaveLocation(socket, info);
        clients.delete(socket);
        if (info.id && ids.get(info.id) === socket) ids.delete(info.id);
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
                const previous = clients.get(socket);
                clients.set(socket, { ...previous, id, profile, finding: false });
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

            if (msg.type === 'world_enter') {
                const info = clients.get(socket);
                if (!info) return;
                const loc = String(msg.loc || '').slice(0, LOC_MAX_LENGTH);
                if (info.loc !== loc) {
                    leaveLocation(socket, info);
                    info.loc = loc;
                    info.x = info.y = null;
                    socketsAt(loc, socket).forEach(s => sendTo(s, { type: 'world_join', player: publicPlayer(info) }));
                }
                sendTo(socket, {
                    type: 'world_players',
                    loc,
                    online: clients.size,
                    players: socketsAt(loc, socket).map(s => publicPlayer(clients.get(s))),
                    board: tianjiaoBoard(loc)
                });
                return;
            }

            if (msg.type === 'world_pos') {
                const info = clients.get(socket);
                if (!info || !info.loc) return;
                const now = Date.now();
                if (now - (info.posAt || 0) < POSITION_MIN_MS) return;
                info.posAt = now;
                const x = Number(msg.x), y = Number(msg.y);
                if (!Number.isFinite(x) || !Number.isFinite(y)) return;
                info.x = x;
                info.y = y;
                socketsAt(info.loc, socket).forEach(s => sendTo(s, { type: 'world_pos', id: info.id, x, y }));
                return;
            }

            if (msg.type === 'world_say') {
                const info = clients.get(socket);
                if (!info || !info.loc) return;
                const text = String(msg.text || '').slice(0, SAY_MAX_LENGTH);
                if (!text) return;
                socketsAt(info.loc, socket).forEach(s => sendTo(s, { type: 'world_say', id: info.id, text }));
                return;
            }

            if (msg.type === 'tianjiao_report') {
                const info = clients.get(socket);
                if (info) reportScore(info, msg);
                return;
            }

            if (msg.type === 'tianjiao_get') {
                const loc = String(msg.loc || '').slice(0, LOC_MAX_LENGTH);
                sendTo(socket, { type: 'tianjiao_board', loc, board: tianjiaoBoard(loc) });
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