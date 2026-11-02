const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');

const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, 'tianjiao.json');
const LADDER_FILE = path.join(process.env.DATA_DIR || __dirname, 'ladder.json');
const BOSS_FILE = path.join(process.env.DATA_DIR || __dirname, 'worldboss.json');
const THRONE_FILE = path.join(process.env.DATA_DIR || __dirname, 'huvo.json');
const THRONE_MIN_REALM = 32;
const DUEL_MIN_REALM = 31;
const DUEL_MAX_LOSSES = 5;
const DUEL_STALE_MS = 15 * 60 * 1000;
const ORDER_PER_DISCIPLE = 3;
const ORDER_MAX_HUNT = 50;
const DISCIPLE_SEATS = 12;
const ORDER_WORKS = ['word', 'hunt', 'gather', 'boss'];
const ORDER_REWARD_MAX = 2;
const SEED_CAP = 30;
const ORDER_TITLE_MAX = 40;
const ORDER_TEXT_MAX = 200;
/* Tăng số này để xóa ngôi cũ khi deploy */
const THRONE_EPOCH = 3;
const SAVE_INTERVAL_MS = 30000;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const POSITION_MIN_MS = 100;
const POSITION_FLUSH_MS = 250;
const SEND_BUFFER_LIMIT = 256 * 1024;
const RELAY_BUFFER_LIMIT = 32 * 1024;
const RELAY_DROPPABLE = new Set(['arena_tick', 'tick']);
const RELAY_SILENT = new Set(['arena_tick', 'tick', 'hb']);
const HEARTBEAT_MS = 30000;
const SAY_MAX_LENGTH = 120;
const NAME_MAX_LENGTH = 24;
const LOC_MAX_LENGTH = 40;
const BOARD_SIZE = 10;
const FIRST_REPORT_MAX = 500;
const KILLS_PER_SECOND = 1;

const ELO_START = 1000;
const ELO_K = 32;
const LADDER_REWARD_TOP = 10;
const LADDER_MAX_PENDING = 7;
const PAIR_DAILY_LIMIT = 3;
const MATCH_EXPIRE_MS = 3600000;
const MATCH_GRACE_MS = 20000;
const DAY_CHECK_MS = 60000;
const DAY_OFFSET_MS = 7 * 3600000;

const BOSS_WORLDS = ['pham', 'tien', 'thanh', 'thien', 'hondon', 'hongmong', 'chungnguyen'];
const BOSS_BAR_UNITS = 1000;
const BOSS_BARS = 20;
const BOSS_HIT_GAP_MS = 25000;
const BOSS_BROADCAST_MS = 2000;
const BOSS_RESPAWN_MS = 3600000;
const BOSS_MIN_UNITS = 50;
const BOSS_TOP = 10;
const BOSS_MAX_PENDING = 7;

/* Ngày theo giờ Việt Nam */
function currentDay() {
    return new Date(Date.now() + DAY_OFFSET_MS).toISOString().slice(0, 10);
}

/* Bảng PvP: players: id -> { token, name, elo, wins, losses, lastDay }, rewards: id -> [{ day, rank }],
   pairs: số trận tính điểm trong ngày của từng cặp */
function loadLadder() {
    try {
        return JSON.parse(fs.readFileSync(LADDER_FILE, 'utf8'));
    } catch {
        return { day: currentDay(), players: {}, rewards: {}, pairs: {} };
    }
}

function eloDelta(winner, loser) {
    const expected = 1 / (1 + Math.pow(10, (loser - winner) / 400));
    return Math.max(1, Math.round(ELO_K * (1 - expected)));
}

/* Điểm một con quái ở cảnh giới realm, khớp với renownPoints của game */
function maxPointsPerKill(realm) {
    return Math.round(Math.pow(10, (Number(realm) || 0) / 2));
}

/* Boss thế giới: bosses: world -> { hp, respawnAt, hits: id -> { name, units } }, rewards: id -> [{ world, rank, total }].
   Máu tính theo đơn vị: một thanh máu trong trận của người chơi là BOSS_BAR_UNITS */
function newBoss() {
    return { hp: BOSS_BAR_UNITS * BOSS_BARS, respawnAt: 0, hits: {} };
}

function loadThrone() {
    try {
        const saved = JSON.parse(fs.readFileSync(THRONE_FILE, 'utf8'));
        return saved.epoch === THRONE_EPOCH ? saved : null;
    } catch {
        return null;
    }
}

function loadBoss() {
    let saved = {};
    try {
        saved = JSON.parse(fs.readFileSync(BOSS_FILE, 'utf8'));
    } catch { }
    const bosses = saved.bosses || {};
    BOSS_WORLDS.forEach(world => { bosses[world] = bosses[world] || newBoss(); });
    return { bosses, rewards: saved.rewards || {}, tokens: saved.tokens || {} };
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
    const rooms = new Map();            // loc -> Set<socket>
    const pendingMoves = new Map();     // loc -> Map<profileId, [x, y]>
    const boards = new Map();           // loc -> top thiên kiêu đã sắp
    const waiting = [];
    const records = loadRecords();
    const ladder = loadLadder();
    const boss = loadBoss();
    let throne = loadThrone();
    let duel = null;                    // { challenger, holder, at }
    let duelWinner = null;
    let orderSeq = 0;
    const bossHitAt = new Map();        // profileId -> lúc báo sát thương gần nhất
    const matches = new Map();          // matchId -> { a, b, at }
    let matchSeq = 0;
    const nameless = Object.keys(records).filter(id => !records[id].name);
    nameless.forEach(id => { delete records[id]; });
    let recordsDirty = nameless.length > 0;
    let ladderDirty = false;
    let bossDirty = false;
    let bossShared = null;
    let bossBroadcastTimer = null;

    const saveTimer = setInterval(() => {
        if (ladderDirty) {
            ladderDirty = false;
            fs.writeFile(LADDER_FILE, JSON.stringify(ladder), err => {
                if (err) console.error('Error saving ladder:', err);
            });
        }
        if (bossDirty) {
            bossDirty = false;
            fs.writeFile(BOSS_FILE, JSON.stringify(boss), err => {
                if (err) console.error('Error saving boss:', err);
            });
        }
        if (!recordsDirty) return;
        recordsDirty = false;
        fs.writeFile(DATA_FILE, JSON.stringify(records), err => {
            if (err) console.error('Error saving tianjiao:', err);
        });
    }, SAVE_INTERVAL_MS);
    saveTimer.unref();

    const dayTimer = setInterval(() => {
        rollLadderDay();
        respawnBosses();
        const limit = Date.now() - MATCH_EXPIRE_MS;
        matches.forEach((match, id) => { if (match.at < limit) matches.delete(id); });
    }, DAY_CHECK_MS);
    dayTimer.unref();

    const moveTimer = setInterval(flushMoves, POSITION_FLUSH_MS);
    moveTimer.unref();

    /* Kết nối chết không tự đóng: không trả lời ping thì cắt, để khỏi tính là đang online */
    const heartbeatTimer = setInterval(() => {
        wss.clients.forEach(socket => {
            if (socket.isAlive === false) {
                socket.terminate();
                return;
            }
            socket.isAlive = false;
            socket.ping();
        });
    }, HEARTBEAT_MS);
    heartbeatTimer.unref();

    function sendTo(socket, payload) {
        if (socket.readyState === 1) socket.send(JSON.stringify(payload));
    }

    /* Gửi cho nhiều người thì chỉ stringify một lần */
    function sendEach(sockets, payload) {
        const text = JSON.stringify(payload);
        sockets.forEach(socket => {
            if (socket.readyState === 1) socket.send(text);
        });
    }

    function socketsAt(loc, except) {
        const room = rooms.get(loc);
        if (!room) return [];
        const out = [...room];
        const i = except ? out.indexOf(except) : -1;
        if (i >= 0) out.splice(i, 1);
        return out;
    }

    /* Vị trí gom theo phòng, mỗi người chỉ giữ tọa độ mới nhất; ai nghẽn mạng thì bỏ lượt */
    function flushMoves() {
        pendingMoves.forEach((moves, loc) => {
            const room = rooms.get(loc);
            if (!room || room.size < 2 || !moves.size) return;
            const text = JSON.stringify({ type: 'world_moves', loc, moves: [...moves].map(([id, [x, y]]) => [id, x, y]) });
            room.forEach(socket => {
                if (socket.readyState === 1 && socket.bufferedAmount < SEND_BUFFER_LIMIT) socket.send(text);
            });
        });
        pendingMoves.clear();
    }

    /* Hồ sơ chỉ phát lại khi thông tin người khác nhìn thấy đổi, không phát theo chu kỳ */
    function profileKey(profile) {
        return JSON.stringify([profile.name, profile.realmIndex, profile.realmStage, profile.rootRank, profile.elements, profile.look]);
    }

    function publicPlayer(info) {
        const p = info.profile || {};
        return { id: info.id, name: p.name, look: p.look, realmIndex: p.realmIndex, realmStage: p.realmStage, x: info.x, y: info.y };
    }

    function leaveLocation(socket, info) {
        if (!info.loc) return;
        const room = rooms.get(info.loc);
        if (room) {
            room.delete(socket);
            if (!room.size) rooms.delete(info.loc);
        }
        pendingMoves.get(info.loc)?.delete(info.id);
        sendEach(socketsAt(info.loc), { type: 'world_leave', id: info.id });
        info.loc = null;
    }

    function joinLocation(socket, info, loc) {
        info.loc = loc;
        info.x = info.y = null;
        sendEach(socketsAt(loc), { type: 'world_join', player: publicPlayer(info) });
        if (!rooms.has(loc)) rooms.set(loc, new Set());
        rooms.get(loc).add(socket);
    }

    function tianjiaoBoard(loc) {
        if (!boards.has(loc)) {
            boards.set(loc, Object.entries(records)
                .filter(([, record]) => record.scores[loc])
                .map(([id, record]) => ({ id, name: record.name, score: record.scores[loc].score }))
                .sort((a, b) => b.score - a.score)
                .slice(0, BOARD_SIZE));
        }
        return boards.get(loc);
    }

    /* Sửa bảng đã sắp tại chỗ: phần lớn điểm báo lên không lọt top nên không tốn gì */
    function updateBoard(loc, id, name, score) {
        const board = boards.get(loc);
        if (!board) return;
        const entry = board.find(item => item.id === id);
        if (!entry && board.length >= BOARD_SIZE && score <= board[board.length - 1].score) return;
        if (entry) Object.assign(entry, { name, score });
        else board.push({ id, name, score });
        board.sort((a, b) => b.score - a.score);
        board.length = Math.min(board.length, BOARD_SIZE);
    }

    /* Điểm do máy khách báo: chỉ tăng, và không tăng nhanh hơn tốc độ săn tối đa */
    function reportScore(info, msg) {
        const token = String(msg.token || '');
        const loc = String(msg.loc || '').slice(0, LOC_MAX_LENGTH);
        const score = Math.floor(Number(msg.score));
        const name = String(info.profile?.name || '').slice(0, NAME_MAX_LENGTH);
        if (!info.id || !token || !loc || !name || !Number.isFinite(score) || score <= 0) return;
        const record = records[info.id] || (records[info.id] = { token, name, scores: {} });
        if (record.token !== token) return;
        record.name = name;
        const now = Date.now();
        const entry = record.scores[loc];
        const points = maxPointsPerKill(info.profile?.realmIndex);
        const allowed = entry
            ? entry.score + Math.ceil((now - entry.at) / 1000 * KILLS_PER_SECOND) * points
            : FIRST_REPORT_MAX * points;
        const next = Math.min(score, allowed);
        if (entry && next <= entry.score) return;
        record.scores[loc] = { score: next, at: now };
        updateBoard(loc, info.id, record.name, next);
        recordsDirty = true;
    }

    /* Hư Vô Chi Chủ: người đầu tiên lên cảnh giới cuối, ai thắng người đó sẽ thế chỗ */
    function claimThrone(info, msg) {
        const name = String(msg.name || '').slice(0, NAME_MAX_LENGTH);
        const stats = [msg.atk, msg.def, msg.hp].map(Number);
        if (!info.id || !name || !msg.token || !stats.every(n => Number.isFinite(n) && n > 0)) return;
        if (!(Number(info.profile?.realmIndex) >= THRONE_MIN_REALM)) return;
        if (throne && throne.id !== info.id && duelWinner !== info.id) return;
        duelWinner = null;
        const { [info.id]: promoted, ...disciples } = throne?.disciples || {};
        throne = {
            epoch: THRONE_EPOCH, id: info.id, name, atk: stats[0], def: stats[1], hp: stats[2],
            look: msg.look && typeof msg.look === 'object' ? msg.look : null,
            elements: Array.isArray(msg.elements) ? msg.elements.slice(0, 5).map(String) : [],
            path: msg.path ? String(msg.path).slice(0, 16) : null,
            reign: (throne?.reign || 0) + 1, at: Date.now(),
            disciples, orders: throne?.orders || [], seeds: throne?.seeds || [], losses: {}
        };
        saveThrone();
        sendEach(clients.keys(), { type: 'huvo_throne', throne: publicThrone(), news: true });
        sendOrders(throne.id);
    }

    function saveThrone() {
        fs.writeFile(THRONE_FILE, JSON.stringify(throne), err => {
            if (err) console.error('Error saving throne:', err);
        });
    }

    function publicThrone() {
        if (!throne) return null;
        const { orders, losses, ...shown } = throne;
        return shown;
    }

    function sendThrone() {
        sendEach(clients.keys(), { type: 'huvo_throne', throne: publicThrone() });
    }

    function sendOrders(id) {
        const socket = ids.get(id);
        if (!socket || !throne) return;
        const orders = (throne.orders || []).filter(o => id === throne.id || o.to === id || (o.by || throne.id) === id);
        sendTo(socket, { type: 'huvo_orders', orders });
    }

    /* Hết ghế thì người mới chỉ vào được chỗ của đệ tử mình đã thắng; người bị đẩy xuống phải thách đấu lại */
    function joinThrone(info, msg) {
        const name = String(msg.name || '').slice(0, NAME_MAX_LENGTH);
        if (!throne || !info.id || info.id === throne.id || !name || !msg.token) return;
        if (!(Number(info.profile?.realmIndex) >= THRONE_MIN_REALM)) return;
        const stats = [msg.atk, msg.def, msg.hp].map(Number);
        if (!stats.every(n => Number.isFinite(n) && n > 0)) return;
        const disciples = (throne.disciples ||= {});
        const seated = !!disciples[info.id];
        const replaced = !seated && Object.keys(disciples).length >= DISCIPLE_SEATS ? String(msg.replace || '') : null;
        if (replaced !== null && (!disciples[replaced] || replaced === info.id)) {
            const socket = ids.get(info.id);
            if (socket) sendTo(socket, { type: 'huvo_full' });
            return;
        }
        const seat = {
            name, stage: Math.max(0, Math.floor(Number(info.profile.realmStage)) || 0),
            atk: stats[0], def: stats[1], hp: stats[2],
            look: msg.look && typeof msg.look === 'object' ? msg.look : null,
            elements: Array.isArray(msg.elements) ? msg.elements.slice(0, 5).map(String) : [],
            path: msg.path ? String(msg.path).slice(0, 16) : null
        };
        if (replaced !== null) {
            throne.disciples = Object.fromEntries(Object.entries(disciples).map(([id, d]) => (id === replaced ? [info.id, seat] : [id, d])));
            throne.orders = (throne.orders || []).filter(o => o.to !== replaced);
            (throne.exiled ||= {})[replaced] = true;
            delete throne.losses?.[replaced];
            sendOrders(replaced);
            sendOrders(throne.id);
        } else disciples[info.id] = seat;
        if (throne.exiled) delete throne.exiled[info.id];
        saveThrone();
        sendThrone();
        sendOrders(info.id);
    }

    /* Chỉ Chủ được đuổi đệ tử: mất ghế và việc đang giữ, phải thách đấu lại như người bị đẩy xuống */
    function expelDisciple(info, msg) {
        const id = String(msg.id || '');
        if (!throne || info.id !== throne.id || !throne.disciples?.[id]) return;
        delete throne.disciples[id];
        throne.orders = (throne.orders || []).filter(o => o.to !== id);
        (throne.exiled ||= {})[id] = true;
        delete throne.losses?.[id];
        saveThrone();
        sendThrone();
        sendOrders(id);
        sendOrders(throne.id);
    }

    /* Đổi trang phục thì ghế đổi theo; chỉ số trên ghế vẫn giữ như lúc nhập môn */
    function updateThroneLook(info, msg) {
        const seat = info.id === throne?.id ? throne : throne?.disciples?.[info.id];
        if (!seat || !msg.look || typeof msg.look !== 'object') return;
        seat.look = msg.look;
        saveThrone();
        sendThrone();
    }

    /* Chủ sai được mọi đệ tử, đệ tử chỉ sai được người ở tiểu cảnh giới thấp hơn */
    function throneRank(id) {
        if (id === throne.id) return Infinity;
        return throne.disciples?.[id]?.stage ?? -1;
    }

    function addOrder(info, msg) {
        if (!throne || !throne.disciples?.[msg.to] || throneRank(info.id) <= throneRank(msg.to)) return;
        if (!ORDER_WORKS.includes(msg.work)) return;
        const title = String(msg.title || '').slice(0, ORDER_TITLE_MAX);
        const text = String(msg.text || '').slice(0, ORDER_TEXT_MAX);
        const orders = (throne.orders ||= []);
        if (!title || !text || orders.filter(o => o.to === msg.to).length >= ORDER_PER_DISCIPLE) return;
        orders.push({
            id: `${Date.now().toString(36)}${(orderSeq++).toString(36)}`, to: String(msg.to), kind: 'seed', work: msg.work,
            target: msg.work === 'word' && msg.target === 'all' ? 'first' : String(msg.target || 'first').slice(0, 64),
            reward: Math.min(ORDER_REWARD_MAX, Math.max(0, Math.floor(Number(msg.reward)) || 0)),
            loc: String(msg.loc || '').slice(0, 32), monster: String(msg.monster || '').slice(0, 40),
            n: Math.min(ORDER_MAX_HUNT, Math.max(1, Math.floor(Number(msg.n)) || 1)), title, text, by: info.id,
            from: info.id === throne.id ? throne.name : throne.disciples[info.id].name
        });
        saveThrone();
        sendOrders(msg.to);
        sendOrders(info.id);
    }

    /* Đệ tử xuống xong thì việc hiện ở Giới dưới: cho mọi người, người nhận đầu tiên hoặc người được chỉ định */
    function finishOrder(info, msg) {
        const order = throne?.orders?.find(o => o.id === msg.id && o.to === info.id);
        if (!order) return;
        throne.orders = throne.orders.filter(o => o !== order);
        if (order.kind === 'seed') throne.seeds = [...(throne.seeds || []), { ...order, kind: 'seed_quest' }].slice(-SEED_CAP);
        saveThrone();
        if (order.kind === 'seed') sendThrone();
        sendOrders(info.id);
        sendOrders(order.by || throne.id);
        const holder = ids.get(order.by || throne.id);
        if (holder) sendTo(holder, { type: 'huvo_report', name: throne.disciples?.[info.id]?.name || '', title: order.title });
    }

    function claimSeed(socket, info, msg) {
        const seed = throne?.seeds?.find(o => o.id === msg.id);
        const ok = !!seed && seed.target === 'first' && (!seed.claimedBy || seed.claimedBy === info.id);
        if (ok && !seed.claimedBy) {
            seed.claimedBy = info.id;
            saveThrone();
            sendThrone();
        }
        sendTo(socket, { type: 'huvo_claim', id: String(msg.id || ''), ok });
    }

    function finishSeed(info, msg) {
        const seed = throne?.seeds?.find(o => o.id === msg.id && (o.claimedBy === info.id || o.target === info.id));
        if (!seed) return;
        throne.seeds = throne.seeds.filter(o => o !== seed);
        saveThrone();
        sendThrone();
        [...new Set([seed.by || throne.id, throne.id])].forEach(id => {
            const socket = ids.get(id);
            if (socket) sendTo(socket, { type: 'huvo_report', name: info.profile?.name || '', title: seed.title });
        });
    }

    /* Chỉ Chủ được xóa việc đã giao, dù đệ tử chưa xuống hay việc đã hiện ở Giới dưới */
    function deleteOrder(info, msg) {
        if (!throne || info.id !== throne.id) return;
        const order = throne.orders?.find(o => o.id === msg.id);
        throne.orders = (throne.orders || []).filter(o => o !== order);
        throne.seeds = (throne.seeds || []).filter(o => o.id !== msg.id);
        saveThrone();
        sendThrone();
        sendOrders(throne.id);
        if (order) sendOrders(order.to);
    }

    /* Khiêu chiến là PvP thật: Chủ phải online và không được từ chối */
    function startDuel(socket, info, msg) {
        const fail = reason => sendTo(socket, { type: 'huvo_duel_fail', reason });
        if (!throne || !info.id || info.id === throne.id || !msg.token || !msg.profile) return;
        if (!(Number(info.profile?.realmIndex) >= DUEL_MIN_REALM)) return;
        if ((throne.losses?.[info.id] || 0) >= DUEL_MAX_LOSSES) return fail('tries');
        const holder = ids.get(throne.id);
        const holderInfo = holder && clients.get(holder);
        if (!holderInfo?.profile || holder.readyState !== 1) return fail('offline');
        if (duel && Date.now() - duel.at < DUEL_STALE_MS) return fail('busy');
        duel = { challenger: info.id, holder: throne.id, at: Date.now() };
        sendTo(socket, { type: 'huvo_duel', role: 'challenger', opponent: holderInfo.profile });
        sendTo(holder, { type: 'huvo_duel', role: 'holder', opponent: msg.profile });
    }

    function endDuel(winner) {
        if (!duel) return;
        const { challenger, holder } = duel;
        duel = null;
        if (winner === challenger) duelWinner = challenger;
        else if (throne) {
            (throne.losses ||= {})[challenger] = (throne.losses[challenger] || 0) + 1;
            saveThrone();
        }
        const tries = throne?.losses?.[challenger] || 0;
        [challenger, holder].forEach(id => {
            const socket = ids.get(id);
            if (socket) sendTo(socket, { type: 'huvo_duel_end', winner, tries });
        });
    }

    function ladderSorted() {
        return Object.entries(ladder.players)
            .filter(([, p]) => p.wins + p.losses > 0)
            .sort((a, b) => b[1].elo - a[1].elo);
    }

    /* Sang ngày mới: top đã đánh trong ngày cũ được ghi thưởng, chờ người chơi tới nhận */
    function rollLadderDay() {
        const today = currentDay();
        if (ladder.day === today) return;
        ladderSorted().filter(([, p]) => p.lastDay === ladder.day).slice(0, LADDER_REWARD_TOP).forEach(([id], i) => {
            const pending = ladder.rewards[id] || (ladder.rewards[id] = []);
            pending.push({ day: ladder.day, rank: i + 1 });
            ladder.rewards[id] = pending.slice(-LADDER_MAX_PENDING);
        });
        ladder.day = today;
        ladder.pairs = {};
        ladderDirty = true;
    }

    function bossRanking(world) {
        return Object.entries(boss.bosses[world].hits).sort((a, b) => b[1].units - a[1].units);
    }

    /* Phần giống nhau của mọi người chỉ tính lại khi boss đổi */
    function bossSummary() {
        if (bossShared) return bossShared;
        bossShared = {};
        BOSS_WORLDS.forEach(world => {
            const { hp, respawnAt } = boss.bosses[world];
            bossShared[world] = {
                hp, respawnAt,
                maxHp: BOSS_BAR_UNITS * BOSS_BARS,
                top: bossRanking(world).slice(0, BOSS_TOP).map(([, hit]) => hit)
            };
        });
        return bossShared;
    }

    function bossView(id) {
        const shared = bossSummary();
        const bosses = {};
        BOSS_WORLDS.forEach(world => {
            bosses[world] = { ...shared[world], mine: boss.bosses[world].hits[id]?.units || 0 };
        });
        return { type: 'boss_state', bosses, pending: !!boss.rewards[id]?.length };
    }

    /* Boss đổi thì gom lại rồi báo một lượt, nhiều người đánh cùng lúc không gửi dồn */
    function broadcastBoss() {
        bossShared = null;
        if (bossBroadcastTimer) return;
        bossBroadcastTimer = setTimeout(() => {
            bossBroadcastTimer = null;
            clients.forEach((info, socket) => {
                if (info.id) sendTo(socket, bossView(info.id));
            });
        }, BOSS_BROADCAST_MS);
        bossBroadcastTimer.unref();
    }

    function respawnBosses() {
        const now = Date.now();
        const due = BOSS_WORLDS.filter(world => boss.bosses[world].respawnAt && boss.bosses[world].respawnAt <= now);
        if (!due.length) return;
        due.forEach(world => { boss.bosses[world] = newBoss(); });
        bossDirty = true;
        broadcastBoss();
    }

    /* Boss chết: ai đủ đóng góp được ghi thưởng theo hạng, chờ tới nhận */
    function killBoss(world, killer) {
        const ranking = bossRanking(world).filter(([, hit]) => hit.units >= BOSS_MIN_UNITS);
        ranking.forEach(([id], i) => {
            const pending = boss.rewards[id] || (boss.rewards[id] = []);
            pending.push({ world, rank: i + 1, total: ranking.length });
            boss.rewards[id] = pending.slice(-BOSS_MAX_PENDING);
        });
        boss.bosses[world].respawnAt = Date.now() + BOSS_RESPAWN_MS;
        bossShared = null;
        sendEach([...clients].filter(([, info]) => info.id).map(([socket]) => socket), { type: 'boss_killed', world, killer });
    }

    function bossOwner(id, token) {
        if (!id || !token) return false;
        if (!boss.tokens[id]) boss.tokens[id] = token;
        return boss.tokens[id] === token;
    }

    function hitBoss(info, msg) {
        const world = String(msg.world || '');
        const target = boss.bosses[world];
        const token = String(msg.token || '');
        if (!target || target.hp <= 0 || !bossOwner(info.id, token)) return;
        const now = Date.now();
        if (now - (bossHitAt.get(info.id) || 0) < BOSS_HIT_GAP_MS) return;
        bossHitAt.set(info.id, now);
        const units = Math.min(BOSS_BAR_UNITS, target.hp, Math.max(0, Math.floor(Number(msg.units) || 0)));
        if (!units) return;
        const name = String(info.profile?.name || 'Vô danh').slice(0, NAME_MAX_LENGTH);
        const hit = target.hits[info.id] || (target.hits[info.id] = { name, units: 0 });
        hit.name = name;
        hit.units += units;
        target.hp -= units;
        bossDirty = true;
        if (target.hp <= 0) killBoss(world, name);
        broadcastBoss();
    }

    function ladderPlayer(id, token, name) {
        if (!id || !token) return null;
        const player = ladder.players[id] || (ladder.players[id] = { token, name: '', elo: ELO_START, wins: 0, losses: 0, lastDay: '' });
        if (player.token !== token) return null;
        player.name = String(name || player.name).slice(0, NAME_MAX_LENGTH);
        return player;
    }

    function ladderView(id) {
        const sorted = ladderSorted();
        const me = ladder.players[id];
        return {
            type: 'ranked_board',
            board: sorted.slice(0, LADDER_REWARD_TOP).map(([pid, p]) => ({ id: pid, name: p.name, elo: p.elo, wins: p.wins, losses: p.losses })),
            me: me ? { elo: me.elo, wins: me.wins, losses: me.losses, rank: sorted.findIndex(([pid]) => pid === id) + 1 } : null
        };
    }

    function pairKey(a, b) {
        return [a, b].sort().join(':');
    }

    /* Chỉ trận ghép qua tìm trận mới tính điểm; một cặp chỉ tính vài trận mỗi ngày */
    function openRankedMatch(first, second) {
        if (first.token === second.token) return null;
        const a = ladderPlayer(first.profile.id, first.token, first.profile.name);
        const b = ladderPlayer(second.profile.id, second.token, second.profile.name);
        if (!a || !b || (ladder.pairs[pairKey(first.profile.id, second.profile.id)] || 0) >= PAIR_DAILY_LIMIT) return null;
        const matchId = `m${Date.now().toString(36)}_${++matchSeq}`;
        matches.set(matchId, { a: first.profile.id, b: second.profile.id, at: Date.now() });
        return matchId;
    }

    function settleMatch(matchId, loserId) {
        const match = matches.get(matchId);
        if (!match || (match.a !== loserId && match.b !== loserId)) return;
        matches.delete(matchId);
        rollLadderDay();
        const winnerId = match.a === loserId ? match.b : match.a;
        const winner = ladder.players[winnerId], loser = ladder.players[loserId];
        const delta = eloDelta(winner.elo, loser.elo);
        winner.elo += delta;
        loser.elo = Math.max(0, loser.elo - delta);
        winner.wins++;
        loser.losses++;
        winner.lastDay = loser.lastDay = ladder.day;
        const key = pairKey(winnerId, loserId);
        ladder.pairs[key] = (ladder.pairs[key] || 0) + 1;
        ladderDirty = true;
        [[winnerId, delta], [loserId, -delta]].forEach(([id, change]) => {
            const target = ids.get(id);
            if (target) sendTo(target, { ...ladderView(id), change });
        });
    }

    /* Rớt mạng thoáng qua chưa tính thua: hết hạn mà chưa quay lại mới xử */
    function settleAfterGrace(id) {
        setTimeout(() => {
            if (!ids.has(id)) matches.forEach((match, matchId) => settleMatch(matchId, id));
        }, MATCH_GRACE_MS).unref();
    }

    function cleanup(socket) {
        const info = clients.get(socket);
        if (!info) return;
        
        // 🆕 Thông báo cho bạn bè rằng user đã offline (đăng nhập lại ở tab khác thì vẫn online)
        if (info.id && ids.get(info.id) === socket) {
            sendEach([...clients.keys()].filter(clientSocket => clientSocket !== socket), { type: 'friend_offline', profileId: info.id });
        }
        
        leaveLocation(socket, info);
        clients.delete(socket);
        const leaving = info.id && (!ids.get(info.id) || ids.get(info.id) === socket);
        if (info.id && ids.get(info.id) === socket) ids.delete(info.id);
        if (leaving) settleAfterGrace(info.id);
        if (leaving && duel && (info.id === duel.challenger || info.id === duel.holder)) endDuel(info.id === duel.holder ? duel.challenger : duel.holder);
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
                const matchId = openRankedMatch(entry, newEntry);
                const payloadA = { type: 'match_found', opponent: b, matchId };
                const payloadB = { type: 'match_found', opponent: a, matchId };
                entry.socket.send(JSON.stringify(payloadA));
                newEntry.socket.send(JSON.stringify(payloadB));
                return true;
            }
        }
        return false;
    }

    wss.on('connection', (socket) => {
        socket.isAlive = true;
        socket.on('pong', () => { socket.isAlive = true; });
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
                const key = profileKey(profile);
                const isNew = previous?.id !== id || !previous.profileText;
                const changed = isNew || previous.profileKey !== key;
                const profileText = JSON.stringify({ type: 'friend_online', profileId: id, profile });
                clients.set(socket, { ...previous, id, profile, profileKey: key, profileText, finding: false });
                ids.set(id, socket);
                if (!changed) return;
                if (isNew) socket.send(JSON.stringify({ type: 'info', message: 'Đã đăng ký hồ sơ.' }));
                if (isNew) sendTo(socket, { type: 'huvo_throne', throne: publicThrone() });
                if (isNew) sendOrders(id);

                // 🆕 Người mới nhận danh sách đang online một lần, những người khác chỉ nghe khi có đổi
                clients.forEach((clientInfo, clientSocket) => {
                    if (clientSocket === socket || clientSocket.readyState !== 1) return;
                    clientSocket.send(profileText);
                    if (isNew && clientInfo.profileText) socket.send(clientInfo.profileText);
                });

                return;
            }

            if (msg.type === 'world_enter') {
                const info = clients.get(socket);
                if (!info) return;
                const loc = String(msg.loc || '').slice(0, LOC_MAX_LENGTH);
                if (info.loc !== loc) {
                    leaveLocation(socket, info);
                    joinLocation(socket, info, loc);
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
                if (!pendingMoves.has(info.loc)) pendingMoves.set(info.loc, new Map());
                pendingMoves.get(info.loc).set(info.id, [x, y]);
                return;
            }

            if (msg.type === 'world_say') {
                const info = clients.get(socket);
                if (!info || !info.loc) return;
                const text = String(msg.text || '').slice(0, SAY_MAX_LENGTH);
                if (!text) return;
                sendEach(socketsAt(info.loc, socket), { type: 'world_say', id: info.id, text });
                return;
            }

            if (msg.type === 'tianjiao_report') {
                const info = clients.get(socket);
                if (info) reportScore(info, msg);
                return;
            }

            if (msg.type === 'huvo_win') {
                const info = clients.get(socket);
                if (info) claimThrone(info, msg);
                return;
            }

            if (msg.type === 'huvo_join') {
                const info = clients.get(socket);
                if (info) joinThrone(info, msg);
                return;
            }

            if (msg.type === 'huvo_order') {
                const info = clients.get(socket);
                if (info) addOrder(info, msg);
                return;
            }

            if (msg.type === 'huvo_order_done') {
                const info = clients.get(socket);
                if (info) finishOrder(info, msg);
                return;
            }

            if (msg.type === 'huvo_expel') {
                const info = clients.get(socket);
                if (info) expelDisciple(info, msg);
                return;
            }

            if (msg.type === 'huvo_look') {
                const info = clients.get(socket);
                if (info) updateThroneLook(info, msg);
                return;
            }

            if (msg.type === 'huvo_claim') {
                const info = clients.get(socket);
                if (info) claimSeed(socket, info, msg);
                return;
            }

            if (msg.type === 'huvo_seed_done') {
                const info = clients.get(socket);
                if (info) finishSeed(info, msg);
                return;
            }

            if (msg.type === 'huvo_order_delete') {
                const info = clients.get(socket);
                if (info) deleteOrder(info, msg);
                return;
            }

            if (msg.type === 'huvo_challenge') {
                const info = clients.get(socket);
                if (info) startDuel(socket, info, msg);
                return;
            }

            if (msg.type === 'huvo_duel_win') {
                const id = clients.get(socket)?.id;
                if (duel && (id === duel.challenger || id === duel.holder)) endDuel(id);
                return;
            }

            if (msg.type === 'huvo_duel_busy') {
                const id = clients.get(socket)?.id;
                if (!duel || id !== duel.holder) return;
                const challenger = ids.get(duel.challenger);
                duel = null;
                if (challenger) sendTo(challenger, { type: 'huvo_duel_fail', reason: 'busy' });
                return;
            }

            if (msg.type === 'tianjiao_get') {
                const loc = String(msg.loc || '').slice(0, LOC_MAX_LENGTH);
                sendTo(socket, { type: 'tianjiao_board', loc, board: tianjiaoBoard(loc) });
                return;
            }

            if (msg.type === 'ranked_get') {
                const info = clients.get(socket);
                rollLadderDay();
                sendTo(socket, ladderView(info?.id));
                return;
            }

            if (msg.type === 'ranked_result') {
                const info = clients.get(socket);
                if (info?.id && msg.lost === true) settleMatch(String(msg.matchId || ''), info.id);
                return;
            }

            if (msg.type === 'ranked_claim') {
                const info = clients.get(socket);
                rollLadderDay();
                const player = ladder.players[info?.id];
                const rewards = ladder.rewards[info?.id];
                if (!player || player.token !== String(msg.token || '') || !rewards?.length) return;
                delete ladder.rewards[info.id];
                ladderDirty = true;
                sendTo(socket, { type: 'ranked_rewards', rewards });
                return;
            }

            if (msg.type === 'boss_get') {
                const info = clients.get(socket);
                respawnBosses();
                sendTo(socket, bossView(info?.id));
                return;
            }

            if (msg.type === 'boss_hit') {
                const info = clients.get(socket);
                if (info?.id) hitBoss(info, msg);
                return;
            }

            if (msg.type === 'boss_claim') {
                const info = clients.get(socket);
                const rewards = boss.rewards[info?.id];
                if (!rewards?.length || !bossOwner(info.id, String(msg.token || ''))) return;
                delete boss.rewards[info.id];
                bossDirty = true;
                sendTo(socket, { type: 'boss_rewards', rewards });
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
                const entry = { socket, profile: msg.profile, token: String(msg.token || '') };
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
                    if (!RELAY_SILENT.has(msg.kind)) socket.send(JSON.stringify({ type: 'info', message: 'Đối thủ ngoại tuyến.' }));
                    return;
                }
                /* Ảnh trận chỉ cần cái mới nhất: người nhận nghẽn mạng thì bỏ, khỏi xem trận chậm dần */
                if (RELAY_DROPPABLE.has(msg.kind) && target.bufferedAmount >= RELAY_BUFFER_LIMIT) return;
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