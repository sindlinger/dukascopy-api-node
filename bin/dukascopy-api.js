#!/usr/bin/env node
'use strict';

/*
  dukascopy-api.js — robust cross-platform CLI (Node.js) for your JForex WS+REST server.

  Features:
  - REST: instruments, orderbook, history
  - WebSocket: tail/stats/dump (filter by instrument/type)
  - Server management: up/down/status/logs/env (starts jforex-websocket-api-*.jar)
  - MT5 export: writes EA+Indicator sources (WS->GlobalVariables + plot)

  Requirements:
  - Node.js 18+ (for stable runtime)
  - For "server up": Java installed (java in PATH)

  Design goals:
  - One executable file (no extra wrappers). Works on Windows + WSL/Linux.
  - No external npm deps.
*/

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const { spawn } = require('child_process');

const APP = {
  name: 'dukascopy-api',
  version: '1.0.0',
  author: 'Eduardo Candeia Gonçalves'
};

function banner() {
  // stderr to avoid breaking JSON output
  process.stderr.write(`${APP.name} v${APP.version} — ${APP.author}\n`);
}

function die(msg, code = 2) {
  process.stderr.write(`Erro: ${msg}\n`);
  process.exit(code);
}

function warn(msg) {
  process.stderr.write(`Aviso: ${msg}\n`);
}

function isWindows() {
  return process.platform === 'win32';
}

function nowMs() { return Date.now(); }

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function writeFileSafe(p, s) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, s, 'utf8');
}

function tailLines(text, n) {
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

// -------- Config paths --------
// Linux/WSL: ~/.config/dukascopy-api/config.json
// Windows: %APPDATA%\dukascopy-api\config.json
function defaultConfigPath() {
  if (isWindows()) {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'dukascopy-api', 'config.json');
  }
  return path.join(os.homedir(), '.config', 'dukascopy-api', 'config.json');
}

function defaultEnvPath() {
  if (isWindows()) {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'dukascopy-api', '.env');
  }
  return path.join(os.homedir(), '.config', 'dukascopy-api', '.env');
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolveEnvPath() {
  const override = process.env.DUKASCOPY_ENV_PATH || process.env.DUKASCOPY_ENV_FILE;
  return expandHome(override) || defaultEnvPath();
}

function loadEnvFiles(baseDir) {
  const userPath = resolveEnvPath();
  const localPath = path.join(baseDir, '.env');
  const userText = readFileSafe(userPath) || '';
  const localText = readFileSafe(localPath) || '';
  const user = userText ? parseDotEnv(userText) : {};
  const local = localText ? parseDotEnv(localText) : {};
  const merged = { ...process.env, ...local, ...user };
  const primaryPath = Object.keys(user).length ? userPath : localPath;
  return { userPath, localPath, user, local, merged, primaryPath };
}

function loadConfig(cfgPath) {
  const p = cfgPath || defaultConfigPath();
  const raw = readFileSafe(p);
  if (!raw) return { path: p, data: {} };
  try {
    return { path: p, data: JSON.parse(raw) };
  } catch {
    return { path: p, data: {} };
  }
}

function saveConfig(cfgPath, data) {
  const p = cfgPath || defaultConfigPath();
  writeFileSafe(p, JSON.stringify(data, null, 2) + '\n');
  return p;
}

// -------- .env parsing for server --------
function parseDotEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[k] = v;
  }
  return env;
}

function serializeDotEnv(env) {
  const lines = [];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v === null) continue;
    lines.push(`${k}=${v}`);
  }
  return lines.join('\n') + '\n';
}

function splitList(value) {
  if (!value) return [];
  return String(value).split(/[;,]+/).map(s => s.trim()).filter(Boolean);
}

function normalizePathForPlatform(p) {
  if (!p) return p;
  const s = String(p).trim();
  if (!s) return s;
  // Convert Windows path to WSL path if running on non-Windows
  if (!isWindows() && /^[A-Za-z]:[\\/]/.test(s)) {
    const drive = s[0].toLowerCase();
    const rest = s.slice(2).replace(/\\/g, '/');
    return `/mnt/${drive}${rest.startsWith('/') ? '' : '/'}${rest}`;
  }
  return s;
}

function ensureMql5Dir(p) {
  const base = normalizePathForPlatform(p);
  if (!base) return base;
  const name = path.basename(base).toLowerCase();
  return name === 'mql5' ? base : path.join(base, 'MQL5');
}

// -------- Utility: args parsing (minimal) --------
function parseArgs(argv) {
  // Supports: --key value, --key=value, flags
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq >= 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const k = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[k] = true;
    } else {
      out[k] = next;
      i++;
    }
  }
  return out;
}

function normalizeInstrument(s) {
  if (!s) return s;
  return s.replaceAll('/', '').trim().toUpperCase();
}

function ensureUrlNoTrailingSlash(u) {
  return u.endsWith('/') ? u.slice(0, -1) : u;
}

// -------- HTTP client (no deps) --------
async function httpRequest(method, urlStr, headers = {}, body = null, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { reject(new Error(`URL inválida: ${urlStr}`)); return; }

    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;

    const opts = {
      method,
      hostname: u.hostname,
      port: u.port ? parseInt(u.port, 10) : (isHttps ? 443 : 80),
      path: u.pathname + (u.search || ''),
      headers: { ...headers }
    };

    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode || 0,
          headers: res.headers || {},
          body: buf.toString('utf8')
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));

    if (body !== null && body !== undefined) {
      if (Buffer.isBuffer(body)) req.write(body);
      else req.write(String(body));
    }
    req.end();
  });
}

function prettyJson(s) {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}

function jsonGetPath(obj, pathExpr) {
  // Very small: a.b[0].c
  const parts = pathExpr.split('.').filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    const m = part.match(/^([^\[]+)(\[(\d+)\])?$/);
    if (!m) return undefined;
    const key = m[1];
    cur = cur?.[key];
    if (m[2]) {
      const idx = parseInt(m[3], 10);
      cur = Array.isArray(cur) ? cur[idx] : undefined;
    }
    if (cur === undefined || cur === null) return cur;
  }
  return cur;
}

// -------- WebSocket client (no deps) --------
function parseWsUrl(wsUrl) {
  const u = new URL(wsUrl);
  const secure = u.protocol === 'wss:';
  if (!(u.protocol === 'ws:' || u.protocol === 'wss:')) throw new Error('WsUrl precisa ser ws:// ou wss://');
  const port = u.port ? parseInt(u.port, 10) : (secure ? 443 : 80);
  const host = u.hostname;
  const pathPart = (u.pathname || '/') + (u.search || '');
  return { secure, host, port, path: pathPart };
}

function wsMakeKey() {
  return crypto.randomBytes(16).toString('base64');
}

function wsBuildHandshake({ host, port, path }, key) {
  return [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    '',
    ''
  ].join('\r\n');
}

function wsMask(payload, maskKey) {
  const out = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ maskKey[i % 4];
  return out;
}

function wsFrame(opcode, payloadBuf, mask = true) {
  // Client->server MUST mask (RFC6455)
  const fin = 0x80;
  const b0 = fin | (opcode & 0x0f);

  let len = payloadBuf.length;
  let header = [];
  header.push(b0);

  const maskBit = mask ? 0x80 : 0x00;
  if (len <= 125) {
    header.push(maskBit | len);
  } else if (len <= 0xffff) {
    header.push(maskBit | 126);
    header.push((len >> 8) & 0xff, len & 0xff);
  } else {
    header.push(maskBit | 127);
    // 64-bit length
    const hi = Math.floor(len / 2 ** 32);
    const lo = len >>> 0;
    header.push(
      (hi >> 24) & 0xff, (hi >> 16) & 0xff, (hi >> 8) & 0xff, hi & 0xff,
      (lo >> 24) & 0xff, (lo >> 16) & 0xff, (lo >> 8) & 0xff, lo & 0xff
    );
  }

  let maskKey = null;
  let payload = payloadBuf;
  if (mask) {
    maskKey = crypto.randomBytes(4);
    payload = wsMask(payloadBuf, maskKey);
  }

  return mask
    ? Buffer.concat([Buffer.from(header), maskKey, payload])
    : Buffer.concat([Buffer.from(header), payload]);
}

function wsTryParseFrame(buffer) {
  // returns {frame, rest} or null if incomplete
  if (buffer.length < 2) return null;
  const b0 = buffer[0], b1 = buffer[1];
  const fin = !!(b0 & 0x80);
  const opcode = b0 & 0x0f;
  const masked = !!(b1 & 0x80);
  let len = b1 & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buffer.length < offset + 2) return null;
    len = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buffer.length < offset + 8) return null;
    const hi = buffer.readUInt32BE(offset);
    const lo = buffer.readUInt32BE(offset + 4);
    offset += 8;
    // JS safe length for our use; your messages are small
    len = hi * 2 ** 32 + lo;
  }

  let maskKey = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    maskKey = buffer.slice(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + len) return null;
  let payload = buffer.slice(offset, offset + len);
  const rest = buffer.slice(offset + len);

  if (masked && maskKey) payload = wsMask(payload, maskKey);

  return { frame: { fin, opcode, payload }, rest };
}

async function wsConnect(wsUrl, onMessage, onEvent) {
  const info = parseWsUrl(wsUrl);
  const key = wsMakeKey();
  const handshake = wsBuildHandshake(info, key);

  const socket = info.secure
    ? tls.connect({ host: info.host, port: info.port, servername: info.host })
    : net.connect({ host: info.host, port: info.port });

  let stage = 'handshake';
  let rx = Buffer.alloc(0);

  function emit(evt, data) { if (onEvent) onEvent(evt, data); }

  socket.setKeepAlive(true);

  socket.on('error', (e) => emit('error', e));
  socket.on('close', () => emit('close'));

  socket.on('connect', () => {
    emit('connect');
    socket.write(handshake);
  });

  socket.on('data', (chunk) => {
    rx = Buffer.concat([rx, chunk]);

    if (stage === 'handshake') {
      const s = rx.toString('utf8');
      const idx = s.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = s.slice(0, idx);
      // Keep remaining bytes (may contain first WS frame)
      rx = Buffer.from(s.slice(idx + 4), 'utf8');

      if (!head.includes(' 101 ')) {
        emit('error', new Error(`Handshake falhou (não retornou 101). Resposta:\n${head}`));
        socket.destroy();
        return;
      }
      stage = 'frames';
      emit('handshake');
    }

    if (stage === 'frames') {
      // parse multiple frames
      while (true) {
        const parsed = wsTryParseFrame(rx);
        if (!parsed) break;
        rx = parsed.rest;
        const { opcode, payload } = parsed.frame;

        // opcode: 1 text, 2 binary, 8 close, 9 ping, 10 pong
        if (opcode === 9) { // ping
          socket.write(wsFrame(10, payload, true)); // pong
          continue;
        }
        if (opcode === 8) { // close
          socket.end();
          continue;
        }
        if (opcode === 1) { // text
          const text = payload.toString('utf8');
          onMessage(text);
        }
      }
    }
  });

  return {
    close: () => { try { socket.end(); } catch {} },
    sendText: (s) => { socket.write(wsFrame(1, Buffer.from(s, 'utf8'), true)); }
  };
}

// -------- Help --------
function useColor() {
  if (process.env.NO_COLOR) return false;
  return !!process.stdout.isTTY;
}

function printTable(rows, opts = {}) {
  const indent = opts.indent ?? 2;
  const gap = opts.gap ?? 2;
  const pad = (s, n) => s.padEnd(n, ' ');
  const colorOn = useColor();
  const cmdColor = '\x1b[36m'; // cyan
  const reset = '\x1b[0m';
  const col1 = Math.max(...rows.map(r => r[0].length));
  const col2 = Math.max(...rows.map(r => r[1].length));
  for (const r of rows) {
    const raw = r[0];
    const c1 = colorOn
      ? `${cmdColor}${raw}${reset}${' '.repeat(col1 - raw.length)}`
      : pad(raw, col1);
    const c2 = pad(r[1], col2);
    const c3 = r[2] || '';
    console.log(`${' '.repeat(indent)}${c1}${' '.repeat(gap)}${c2}${' '.repeat(gap)}${c3}`);
  }
}

function printSection(title, rows) {
  if (!rows || !rows.length) return;
  console.log(`\n${title}:`);
  printTable(rows);
}

function helpHeader() {
  console.log(`${APP.name} v${APP.version} — ${APP.author}`);
}

const SUBCOMMANDS = {
  config: [
    ['init', 'Cria um config padrão', ''],
    ['show', 'Mostra o config atual', ''],
    ['get', 'Lê uma chave', ''],
    ['set', 'Define uma chave', ''],
    ['path', 'Caminho do config', '']
  ],
  server: [
    ['env', 'Gera .env.example', ''],
    ['set', 'Atualiza o .env', ''],
    ['up', 'Inicia (background)', ''],
    ['down', 'Encerra', ''],
    ['status', 'Status', ''],
    ['logs', 'Logs do servidor', ''],
    ['run', 'Inicia em foreground', '']
  ],
  instruments: [
    ['list', 'Lista instrumentos', ''],
    ['set', 'Define lista completa', ''],
    ['add', 'Adiciona instrumentos', ''],
    ['remove', 'Remove instrumentos', '']
  ],
  orderbook: [
    ['latest', 'Snapshot completo', ''],
    ['top', 'Best bid/ask', ''],
    ['levels', 'N níveis do book', ''],
    ['watch', 'Loop periódico', '']
  ],
  history: [
    ['bars', 'Retorna JSON', ''],
    ['csv', 'Exporta CSV', '']
  ],
  ws: [
    ['tail', 'Imprime mensagens', ''],
    ['stats', 'Contagem de msgs', ''],
    ['dump', 'Salva em arquivo', '']
  ],
  json: [
    ['pretty', 'Formata JSON', ''],
    ['get', 'Extrai campo', '']
  ],
  mt5: [
    ['export', 'Exporta EA/Indicador', '']
  ]
};

function helpRoot() {
  helpHeader();
  console.log(`Uso:
  dukascopy-api [--config <path>] [--host <url>] [--ws <wsurl>] <comando> ...
  node ./dukascopy-api.js [--config <path>] [--host <url>] [--ws <wsurl>] <comando> ...

Comandos (descrição):
`);
  printTable([
    ['config', 'Gerencia host/ws e arquivo de configuração do CLI.', ''],
    ['doctor', 'Testa conectividade REST e WebSocket.', ''],
    ['server', 'Sobe, derruba e inspeciona o servidor JForex.', ''],
    ['instruments', 'Lista e define instrumentos ativos no servidor.', ''],
    ['orderbook', 'Consulta o orderbook (snapshot, níveis, watch).', ''],
    ['history', 'Baixa histórico (JSON/CSV) com filtros de tempo.', ''],
    ['ws', 'Acompanha o WebSocket (tail, stats, dump).', ''],
    ['raw', 'Faz requisição HTTP direta para qualquer endpoint.', ''],
    ['json', 'Formata JSON ou extrai campos com path.', ''],
    ['mt5', 'Exporta EA/Indicador para o MetaTrader 5.', ''],
    ['help', 'Mostra ajuda detalhada de comandos.', '']
  ]);
  printSection('Opções globais', [
    ['--config <path>', 'Caminho do config do CLI', ''],
    ['--host <url>', 'Override do host REST', ''],
    ['--ws <wsurl>', 'Override do WebSocket', '']
  ]);
  console.log(`\nExemplos:
  dukascopy-api config init
  dukascopy-api config set host http://localhost:8080
  dukascopy-api config set ws ws://localhost:8080/ws/market
  dukascopy-api server up --port 8080
  dukascopy-api instruments list
  dukascopy-api orderbook top --instrument EURUSD
  dukascopy-api ws tail --type orderbook --instrument EURUSD --limit 20 --pretty
  dukascopy-api help server env
`);
}

function helpConfig(sub) {
  if (!sub) {
    helpHeader();
    console.log(`Uso:
  dukascopy-api config <subcomando> ...

Subcomandos (descrição):
`);
    printTable(SUBCOMMANDS.config);
    printSection('Chaves suportadas', [
      ['host', 'Base REST (ex.: http://localhost:8080)', ''],
      ['ws', 'Endpoint WS (ex.: ws://localhost:8080/ws/market)', '']
    ]);
    console.log(`\nExemplos:
  dukascopy-api config init
  dukascopy-api config show
  dukascopy-api config get host
  dukascopy-api config set host http://localhost:8080
`);
    return;
  }
  if (sub === 'get') {
    console.log(`Uso:
  dukascopy-api config get <chave>
`);
    printSection('Subcomandos disponíveis', SUBCOMMANDS.config);
    printSection('Chaves suportadas', [
      ['host', 'Base REST (ex.: http://localhost:8080)', ''],
      ['ws', 'Endpoint WS (ex.: ws://localhost:8080/ws/market)', '']
    ]);
    console.log(`\nExemplo:
  dukascopy-api config get host
`);
    return;
  }
  if (sub === 'set') {
    console.log(`Uso:
  dukascopy-api config set <chave> <valor>
`);
    printSection('Subcomandos disponíveis', SUBCOMMANDS.config);
    printSection('Chaves suportadas', [
      ['host', 'Base REST (ex.: http://localhost:8080)', ''],
      ['ws', 'Endpoint WS (ex.: ws://localhost:8080/ws/market)', '']
    ]);
    console.log(`\nExemplos:
  dukascopy-api config set host http://localhost:8080
  dukascopy-api config set ws ws://localhost:8080/ws/market
`);
    return;
  }
  console.log(`Uso:
  dukascopy-api config ${sub}
`);
}

function helpDoctor() {
  helpHeader();
  console.log(`Uso:
  dukascopy-api doctor [--host <url>] [--ws <wsurl>]

Descrição:
  Verifica se REST e WS estão acessíveis no host configurado.
`);
  printSection('Opções', [
    ['--host <url>', 'Override do host REST', ''],
    ['--ws <wsurl>', 'Override do WebSocket', '']
  ]);
  console.log(`\nExemplo:
  dukascopy-api doctor --host http://localhost:8080 --ws ws://localhost:8080/ws/market
`);
}

function helpServer(sub) {
  if (!sub) {
    helpHeader();
    console.log(`Uso:
  dukascopy-api server <subcomando> [opções]

Subcomandos (descrição):
`);
    printTable([
      ['env', 'Gera um .env.example com variáveis suportadas.', ''],
      ['set', 'Atualiza o arquivo .env de forma automática.', ''],
      ['up', 'Inicia o servidor em background (gerenciado).', ''],
      ['down', 'Encerra o servidor (gerenciado ou por porta).', ''],
      ['status', 'Mostra o status e o modo (managed/unmanaged).', ''],
      ['logs', 'Mostra logs e permite seguir em tempo real.', ''],
      ['run', 'Inicia em foreground (saída direta no terminal).', '']
    ]);
    const envPath = resolveEnvPath();
    const envInfo = process.env.DUKASCOPY_ENV_PATH || process.env.DUKASCOPY_ENV_FILE
      ? 'Caminho via DUKASCOPY_ENV_PATH/DUKASCOPY_ENV_FILE'
      : 'Caminho padrão (global)';
    printSection('Arquivo .env', [
      [envPath, envInfo, '']
    ]);
    console.log(`\nExemplos:
  dukascopy-api server env
  dukascopy-api server set --user SEU_USER --pass SUA_SENHA
  dukascopy-api server up --port 8080
  dukascopy-api server logs --n 200 --follow
`);
    return;
  }
  if (sub === 'env') {
    console.log(`Uso:
  dukascopy-api server env
`);
    printSection('Subcomandos disponíveis', SUBCOMMANDS.server);
    console.log(`\nExemplo:
  dukascopy-api server env
`);
    return;
  }
  if (sub === 'set') {
    console.log(`Uso:
  dukascopy-api server set [--user <u>] [--pass <p>] [--jnlp <url>] [--instruments <list>]
                            [--book-depth <n>] [--port <n>] [--address <ip>] [--host-override <host>]
`);
    printSection('Subcomandos disponíveis', SUBCOMMANDS.server);
    printSection('Opções', [
      ['--user <u>', 'Usuário JForex', ''],
      ['--pass <p>', 'Senha JForex', ''],
      ['--jnlp <url>', 'URL do JNLP', ''],
      ['--instruments <list>', 'Lista (ex.: EUR/USD,USD/JPY)', ''],
      ['--book-depth <n>', 'Profundidade do book', ''],
      ['--port <n>', 'Porta do servidor', ''],
      ['--address <ip>', 'Bind do servidor', ''],
      ['--host-override <host>', 'Host para probe status', '']
    ]);
    console.log(`\nExemplos:
  dukascopy-api server set --user SEU_USER --pass SUA_SENHA
  dukascopy-api server set --instruments EUR/USD,USD/JPY --book-depth 10
`);
    return;
  }
  if (sub === 'up') {
    console.log(`Uso:
  dukascopy-api server up [--port <n>] [--address <ip>] [--jar <path>] [--] <args-java>
`);
    printSection('Subcomandos disponíveis', SUBCOMMANDS.server);
    printSection('Opções', [
      ['--port <n>', 'Porta do servidor', ''],
      ['--address <ip>', 'Bind do servidor', ''],
      ['--jar <path>', 'Caminho do JAR', ''],
      ['-- <args>', 'Args extras para o Java', '']
    ]);
    console.log(`\nExemplo:
  dukascopy-api server up --port 8080
`);
    return;
  }
  if (sub === 'run') {
    console.log(`Uso:
  dukascopy-api server run [--port <n>] [--address <ip>] [--jar <path>] [--] <args-java>
`);
    printSection('Subcomandos disponíveis', SUBCOMMANDS.server);
    printSection('Opções', [
      ['--port <n>', 'Porta do servidor', ''],
      ['--address <ip>', 'Bind do servidor', ''],
      ['--jar <path>', 'Caminho do JAR', ''],
      ['-- <args>', 'Args extras para o Java', '']
    ]);
    console.log(`\nExemplo:
  dukascopy-api server run --port 8080
`);
    return;
  }
  if (sub === 'logs') {
    console.log(`Uso:
  dukascopy-api server logs [--n <n>] [--follow]
`);
    printSection('Subcomandos disponíveis', SUBCOMMANDS.server);
    printSection('Opções', [
      ['--n <n>', 'Número de linhas (default 200)', ''],
      ['--follow', 'Acompanhar em tempo real', '']
    ]);
    console.log(`\nExemplo:
  dukascopy-api server logs --n 200 --follow
`);
    return;
  }
  if (sub === 'status' || sub === 'down') {
    console.log(`Uso:
  dukascopy-api server ${sub}
`);
    printSection('Subcomandos disponíveis', SUBCOMMANDS.server);
    console.log(`\nExemplo:
  dukascopy-api server ${sub}
`);
    return;
  }
  console.log(`Uso:
  dukascopy-api server ${sub}
`);
  printSection('Subcomandos disponíveis', SUBCOMMANDS.server);
}

function helpInstruments(sub) {
  if (!sub) {
    helpHeader();
    console.log(`Uso:
  dukascopy-api instruments <subcomando> [opções]

Subcomandos (descrição):
`);
    printTable([
      ['list', 'Lista instrumentos ativos no servidor.', ''],
      ['set', 'Define a lista completa de instrumentos.', ''],
      ['add', 'Adiciona instrumentos à lista atual.', ''],
      ['remove', 'Remove instrumentos da lista atual.', '']
    ]);
    console.log(`\nExemplos:
  dukascopy-api instruments list
  dukascopy-api instruments set EUR/USD,USD/JPY
  dukascopy-api instruments add XAU/USD
  dukascopy-api instruments remove BTC/USD
`);
    return;
  }
  if (sub === 'list') {
    console.log(`Uso:
  dukascopy-api instruments list [--pretty]
`);
    printSection('Subcomandos disponíveis', SUBCOMMANDS.instruments);
    printSection('Opções', [
      ['--pretty', 'Formata a saída JSON', '']
    ]);
    console.log(`\nExemplo:
  dukascopy-api instruments list --pretty
`);
    return;
  }
  if (sub === 'set' || sub === 'add' || sub === 'remove') {
    console.log(`Uso:
  dukascopy-api instruments ${sub} <lista>
`);
    printSection('Subcomandos disponíveis', SUBCOMMANDS.instruments);
    printSection('Parâmetros', [
      ['<lista>', 'Ex.: EUR/USD,USD/JPY (separado por vírgula)', '']
    ]);
    printSection('Opções', [
      ['--list <lista>', 'Mesma lista via flag', '']
    ]);
    console.log(`\nExemplo:
  dukascopy-api instruments ${sub} EUR/USD,USD/JPY
`);
    return;
  }
  console.log(`Uso:
  dukascopy-api instruments ${sub}
`);
  printSection('Subcomandos disponíveis', SUBCOMMANDS.instruments);
}

function helpOrderbook(sub) {
  if (!sub) {
    helpHeader();
    console.log(`Uso:
  dukascopy-api orderbook <subcomando> [opções]

Subcomandos (descrição):
`);
    printTable([
      ['latest', 'Snapshot completo do orderbook.', ''],
      ['top', 'Melhor bid/ask e spread.', ''],
      ['levels', 'Retorna N níveis do book.', ''],
      ['watch', 'Loop periódico para acompanhar mudanças.', '']
    ]);
    console.log(`\nExemplos:
  dukascopy-api orderbook latest --instrument EUR/USD
  dukascopy-api orderbook top --instrument EURUSD
  dukascopy-api orderbook levels --instrument EURUSD --n 10
  dukascopy-api orderbook watch --instrument EURUSD --every 1000
`);
    return;
  }
  if (sub === 'latest') {
    console.log(`Uso:
  dukascopy-api orderbook latest [--instrument <inst>] [--pretty]
`);
    printSection('Subcomandos disponíveis', SUBCOMMANDS.orderbook);
    printSection('Opções', [
      ['--instrument <inst>', 'Instrumento (ex.: EUR/USD)', ''],
      ['--pretty', 'Formata a saída JSON', '']
    ]);
    console.log(`\nExemplo:
  dukascopy-api orderbook latest --instrument EURUSD
`);
    return;
  }
  if (sub === 'top') {
    console.log(`Uso:
  dukascopy-api orderbook top [--instrument <inst>] [--pretty]
`);
    printSection('Subcomandos disponíveis', SUBCOMMANDS.orderbook);
    printSection('Opções', [
      ['--instrument <inst>', 'Instrumento (ex.: EUR/USD)', ''],
      ['--pretty', 'Formata a saída JSON', '']
    ]);
    console.log(`\nExemplo:
  dukascopy-api orderbook top --instrument EURUSD
`);
    return;
  }
  if (sub === 'levels') {
    console.log(`Uso:
  dukascopy-api orderbook levels [--instrument <inst>] [--n <n>] [--out <file>] [--pretty]
`);
    printSection('Subcomandos disponíveis', SUBCOMMANDS.orderbook);
    printSection('Opções', [
      ['--instrument <inst>', 'Instrumento (ex.: EUR/USD)', ''],
      ['--n <n>', 'Número de níveis (default 10)', ''],
      ['--out <file>', 'Salvar em arquivo', ''],
      ['--pretty', 'Formata a saída JSON', '']
    ]);
    console.log(`\nExemplo:
  dukascopy-api orderbook levels --instrument EURUSD --n 10
`);
    return;
  }
  if (sub === 'watch') {
    console.log(`Uso:
  dukascopy-api orderbook watch [--instrument <inst>] [--every <ms>] [--count <n>] [--pretty]
`);
    printSection('Subcomandos disponíveis', SUBCOMMANDS.orderbook);
    printSection('Opções', [
      ['--instrument <inst>', 'Instrumento (ex.: EUR/USD)', ''],
      ['--every <ms>', 'Intervalo em ms (default 1000)', ''],
      ['--count <n>', 'Quantidade de iterações (0=inf)', ''],
      ['--pretty', 'Formata a saída JSON', '']
    ]);
    console.log(`\nExemplo:
  dukascopy-api orderbook watch --instrument EURUSD --every 1000
`);
    return;
  }
  console.log(`Uso:
  dukascopy-api orderbook ${sub}
`);
  printSection('Subcomandos disponíveis', SUBCOMMANDS.orderbook);
}

function helpHistory(sub) {
  if (!sub) {
    helpHeader();
    console.log(`Uso:
  dukascopy-api history <subcomando> --instrument <inst> [opções]

Subcomandos (descrição):
`);
    printTable([
      ['bars', 'Retorna histórico em JSON.', ''],
      ['csv', 'Exporta histórico em CSV.', '']
    ]);
    console.log(`\nExemplos:
  dukascopy-api history bars --instrument EUR/USD --minutes 60
  dukascopy-api history csv --instrument EUR/USD --minutes 60 --out bars.csv
`);
    return;
  }
  if (sub === 'bars') {
    console.log(`Uso:
  dukascopy-api history bars --instrument <inst> [--from <ms>] [--to <ms>] [--minutes <n>]
                               [--period M1|M5|H1] [--side BID|ASK] [--pretty]
`);
    printSection('Subcomandos disponíveis', SUBCOMMANDS.history);
    printSection('Opções', [
      ['--instrument <inst>', 'Obrigatório (ex.: EUR/USD)', ''],
      ['--from <ms>', 'Epoch ms inicial', ''],
      ['--to <ms>', 'Epoch ms final', ''],
      ['--minutes <n>', 'Alternativa a from/to', ''],
      ['--period M1|M5|H1', 'Período (default M1)', ''],
      ['--side BID|ASK', 'Lado (default BID)', ''],
      ['--pretty', 'Formata a saída JSON', '']
    ]);
    console.log(`\nExemplo:
  dukascopy-api history bars --instrument EUR/USD --minutes 60
`);
    return;
  }
  if (sub === 'csv') {
    console.log(`Uso:
  dukascopy-api history csv --instrument <inst> [--from <ms>] [--to <ms>] [--minutes <n>]
                               [--period M1|M5|H1] [--side BID|ASK] [--fields a,b,c] [--out <file>]
`);
    printSection('Subcomandos disponíveis', SUBCOMMANDS.history);
    printSection('Opções', [
      ['--instrument <inst>', 'Obrigatório (ex.: EUR/USD)', ''],
      ['--from <ms>', 'Epoch ms inicial', ''],
      ['--to <ms>', 'Epoch ms final', ''],
      ['--minutes <n>', 'Alternativa a from/to', ''],
      ['--period M1|M5|H1', 'Período (default M1)', ''],
      ['--side BID|ASK', 'Lado (default BID)', ''],
      ['--fields a,b,c', 'Campos CSV (default time,open,high,low,close,volume)', ''],
      ['--out <file>', 'Salvar em arquivo', '']
    ]);
    console.log(`\nExemplo:
  dukascopy-api history csv --instrument EUR/USD --minutes 60 --out bars.csv
`);
    return;
  }
  console.log(`Uso:
  dukascopy-api history ${sub}
`);
  printSection('Subcomandos disponíveis', SUBCOMMANDS.history);
}

function helpWs(sub) {
  if (!sub) {
    helpHeader();
    console.log(`Uso:
  dukascopy-api ws <subcomando> [opções]

Subcomandos (descrição):
`);
    printTable([
      ['tail', 'Imprime mensagens em tempo real.', ''],
      ['stats', 'Mostra estatísticas (msgs/s).', ''],
      ['dump', 'Salva mensagens em arquivo JSONL.', '']
    ]);
    console.log(`\nExemplos:
  dukascopy-api ws tail --type orderbook --instrument EURUSD --limit 20 --pretty
  dukascopy-api ws stats --type orderbook
  dukascopy-api ws dump --type orderbook --out dump.jsonl
`);
    return;
  }
  if (sub === 'tail') {
    console.log(`Uso:
  dukascopy-api ws tail [--type <t>] [--instrument <inst>] [--limit <n>] [--duration <s>] [--pretty]
`);
    printSection('Subcomandos disponíveis', SUBCOMMANDS.ws);
    printSection('Opções', [
      ['--type <t>', 'Tipo (ex.: orderbook)', ''],
      ['--instrument <inst>', 'Instrumento (ex.: EURUSD)', ''],
      ['--limit <n>', 'Para após N mensagens', ''],
      ['--duration <s>', 'Para após N segundos', ''],
      ['--pretty', 'Formata a saída JSON', '']
    ]);
    console.log(`\nExemplo:
  dukascopy-api ws tail --type orderbook --instrument EURUSD --limit 20 --pretty
`);
    return;
  }
  if (sub === 'stats') {
    console.log(`Uso:
  dukascopy-api ws stats [--type <t>] [--instrument <inst>] [--duration <s>]
`);
    printSection('Subcomandos disponíveis', SUBCOMMANDS.ws);
    printSection('Opções', [
      ['--type <t>', 'Tipo (ex.: orderbook)', ''],
      ['--instrument <inst>', 'Instrumento (ex.: EURUSD)', ''],
      ['--duration <s>', 'Para após N segundos', '']
    ]);
    console.log(`\nExemplo:
  dukascopy-api ws stats --type orderbook
`);
    return;
  }
  if (sub === 'dump') {
    console.log(`Uso:
  dukascopy-api ws dump --out <file> [--type <t>] [--instrument <inst>] [--limit <n>] [--duration <s>]
`);
    printSection('Subcomandos disponíveis', SUBCOMMANDS.ws);
    printSection('Opções', [
      ['--out <file>', 'Obrigatório (arquivo JSONL)', ''],
      ['--type <t>', 'Tipo (ex.: orderbook)', ''],
      ['--instrument <inst>', 'Instrumento (ex.: EURUSD)', ''],
      ['--limit <n>', 'Para após N mensagens', ''],
      ['--duration <s>', 'Para após N segundos', '']
    ]);
    console.log(`\nExemplo:
  dukascopy-api ws dump --type orderbook --out dump.jsonl
`);
    return;
  }
  console.log(`Uso:
  dukascopy-api ws ${sub}
`);
  printSection('Subcomandos disponíveis', SUBCOMMANDS.ws);
}

function helpRaw() {
  helpHeader();
  console.log(`Uso:
  dukascopy-api raw --method GET --url <url> [--body <json>] [--pretty]
`);
  printSection('Opções', [
    ['--method <M>', 'Método HTTP (GET/POST/...)', ''],
    ['--url <url>', 'Obrigatório', ''],
    ['--body <json>', 'Corpo JSON (para POST/PUT)', ''],
    ['--pretty', 'Formata a saída JSON', '']
  ]);
  console.log(`\nExemplo:
  dukascopy-api raw --method GET --url http://localhost:8080/api/instruments
`);
}

function helpJson(sub) {
  if (!sub) {
    helpHeader();
    console.log(`Uso:
  dukascopy-api json <subcomando> [opções]

Subcomandos (descrição):
`);
    printTable([
      ['pretty', 'Formata/indenta JSON.', ''],
      ['get', 'Extrai campo usando path.', '']
    ]);
    console.log(`\nExemplos:
  cat file.json | dukascopy-api json pretty
  cat file.json | dukascopy-api json get --path a.b[0].c
`);
    return;
  }
  if (sub === 'pretty') {
    console.log(`Uso:
  dukascopy-api json pretty [--in <arquivo>]
`);
    printSection('Subcomandos disponíveis', SUBCOMMANDS.json);
    printSection('Opções', [
      ['--in <arquivo>', 'Arquivo de entrada (ou stdin)', '']
    ]);
    console.log(`\nExemplo:
  dukascopy-api json pretty --in data.json
`);
    return;
  }
  if (sub === 'get') {
    console.log(`Uso:
  dukascopy-api json get --path <expr> [--in <arquivo>]
`);
    printSection('Subcomandos disponíveis', SUBCOMMANDS.json);
    printSection('Opções', [
      ['--path <expr>', 'Obrigatório (ex.: a.b[0].c)', ''],
      ['--in <arquivo>', 'Arquivo de entrada (ou stdin)', '']
    ]);
    console.log(`\nExemplo:
  dukascopy-api json get --path a.b[0].c --in data.json
`);
    return;
  }
  console.log(`Uso:
  dukascopy-api json ${sub}
`);
  printSection('Subcomandos disponíveis', SUBCOMMANDS.json);
}

function helpMt5() {
  helpHeader();
  console.log(`Uso:
  dukascopy-api mt5 export [--out <dir>]
`);
  printSection('Subcomandos disponíveis', SUBCOMMANDS.mt5);
  printSection('Variáveis de ambiente', [
    ['MT5_DATA_DIRS', 'Lista de pastas de Terminal (separado por ; ou ,).', ''],
    ['MT5_DATA_DIR', 'Uma pasta única (alternativa).', '']
  ]);
  printSection('Opções', [
    ['--out <dir>', 'Diretório base (default ./mt5). Se não terminar com MQL5, será adicionado.', '']
  ]);
  console.log(`\nExemplo:
  dukascopy-api mt5 export --out ./mt5
`);
}

function failWithHelp(msg, helpFn) {
  if (msg) process.stderr.write(`Erro: ${msg}\n`);
  helpFn();
  process.exit(2);
}

async function cmd_config(sub, args, cfgPath) {
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') { helpConfig(); return; }
  const { path: p, data } = loadConfig(cfgPath);
  if (sub === 'path') {
    if (args.length) failWithHelp('config path não aceita argumentos.', () => helpConfig('path'));
    console.log(p);
    return;
  }
  if (sub === 'init') {
    if (args.length) failWithHelp('config init não aceita argumentos.', () => helpConfig('init'));
    const d = { ...data };
    if (!d.host) d.host = 'http://localhost:8080';
    if (!d.ws) d.ws = 'ws://localhost:8080/ws/market';
    saveConfig(cfgPath, d);
    console.log('OK');
    return;
  }
  if (sub === 'show') {
    if (args.length) failWithHelp('config show não aceita argumentos.', () => helpConfig('show'));
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (sub === 'get') {
    const k = args[0];
    if (!k) failWithHelp('config get precisa de <chave>.', () => helpConfig('get'));
    if (args.length > 1) failWithHelp('config get aceita apenas <chave>.', () => helpConfig('get'));
    console.log(data[k] ?? '');
    return;
  }
  if (sub === 'set') {
    const k = args[0], v = args[1];
    if (!k || v === undefined) failWithHelp('config set precisa de <chave> <valor>.', () => helpConfig('set'));
    if (args.length > 2) failWithHelp('config set aceita apenas <chave> <valor>.', () => helpConfig('set'));
    const d = { ...data, [k]: v };
    saveConfig(cfgPath, d);
    console.log('OK');
    return;
  }
  failWithHelp(`config subcomando desconhecido: ${sub}`, () => helpConfig());
}

function resolveHostWs(cliOpts, cfg) {
  const host = cliOpts.host || cfg.host || 'http://localhost:8080';
  const ws = cliOpts.ws || cfg.ws || 'ws://localhost:8080/ws/market';
  return { host: ensureUrlNoTrailingSlash(host), ws };
}

async function cmd_doctor(cliOpts, cfgPath, args) {
  if (args && args.length) failWithHelp('doctor não aceita argumentos posicionais.', helpDoctor);
  const { data } = loadConfig(cfgPath);
  const { host, ws } = resolveHostWs(cliOpts, data);

  banner();
  process.stderr.write(`Config host: ${host}\n`);
  process.stderr.write(`Config ws:   ${ws}\n`);

  // Java availability (optional)
  await new Promise((res) => {
    const p = spawn('java', ['-version'], { stdio: 'ignore' });
    p.on('exit', () => res());
    p.on('error', () => res());
  });

  // REST probe
  const r = await httpRequest('GET', `${host}/api/instruments`, {}, null, 2000).catch(() => null);
  if (!r) die('REST não acessível (falha de conexão).');
  process.stderr.write(`REST /api/instruments: HTTP ${r.status}\n`);
  if (r.status >= 200 && r.status < 500) console.log('OK');
  else die('REST respondeu com erro.');

  // WS handshake probe (connect and close)
  await new Promise(async (res) => {
    try {
      const c = await wsConnect(ws, () => {}, (evt, e) => {
        if (evt === 'error') {
          process.stderr.write(`WS erro: ${String(e)}\n`);
          res();
        }
      });
      setTimeout(() => { c.close(); res(); }, 500);
    } catch (e) {
      process.stderr.write(`WS erro: ${String(e)}\n`);
      res();
    }
  });
}

function findServerJarInDir(dir) {
  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.jar'));
  const cand = files.find(f => /^jforex-websocket-api-.*\.jar$/i.test(f) && !/old|original/i.test(f));
  return cand ? path.join(dir, cand) : null;
}

function runtimeDirs(baseDir) {
  const rt = path.join(baseDir, '.runtime');
  return {
    rt,
    run: path.join(rt, 'run'),
    log: path.join(rt, 'log'),
    pid: path.join(rt, 'run', 'server.pid'),
    logFile: path.join(rt, 'log', 'server.log')
  };
}

function serverReadPid(pidPath) {
  const t = readFileSafe(pidPath);
  if (!t) return null;
  const pid = parseInt(t.trim(), 10);
  return Number.isFinite(pid) ? pid : null;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}


async function cmd_server(sub, cliOpts, cfgPath, args) {
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') { helpServer(); return; }
  const baseDir = process.cwd();
  const rt = runtimeDirs(baseDir);
  mkdirp(rt.run); mkdirp(rt.log);

  const envInfo = loadEnvFiles(baseDir);
  const envMerged = envInfo.merged;

  // default port/address for all subcommands
  const port = parseInt(cliOpts.port || envMerged.SERVER_PORT || '8080', 10) || 8080;
  const address = cliOpts.address || envMerged.SERVER_ADDRESS || '';

  if (sub === 'env') {
    if (args.length) failWithHelp('server env não aceita argumentos.', () => helpServer('env'));
    const tpl =
`# Credenciais dukascopy-api / JForex
JFOREX_USER=SEU_USER
JFOREX_PASS=SUA_SENHA

# Instrumentos (aceita EUR/USD ou EURUSD)
JFOREX_INSTRUMENTS=EUR/USD,USD/JPY
JFOREX_BOOK_DEPTH=10

# Porta/Bind do Spring
SERVER_PORT=8080
# SERVER_ADDRESS=0.0.0.0

# Opcional: se o servidor estiver fora do WSL e o cliente dentro do WSL, ajuste o host de probe
# HOST_OVERRIDE=host.docker.internal

# MT5 export (pasta base do Terminal; o export grava em MQL5/Experts e MQL5/Indicators)
# Você pode listar múltiplos Terminals separados por ; ou ,
MT5_DATA_DIRS=C:\\Users\\pichau\\AppData\\Roaming\\MetaQuotes\\Terminal\\EDC2DBD7187032A6326EC5B7406951FA
`;
    const out = path.join(baseDir, '.env.example');
    writeFileSafe(out, tpl);
    console.log(out);
    return;
  }

  if (sub === 'set') {
    if (args.length) failWithHelp('server set não aceita argumentos posicionais.', () => helpServer('set'));
    const updates = {};
    if (cliOpts.user) updates.JFOREX_USER = String(cliOpts.user);
    if (cliOpts.pass) updates.JFOREX_PASS = String(cliOpts.pass);
    if (cliOpts.jnlp) updates.JFOREX_JNLP = String(cliOpts.jnlp);
    if (cliOpts.instruments) updates.JFOREX_INSTRUMENTS = String(cliOpts.instruments);
    if (cliOpts['book-depth'] || cliOpts.bookDepth) updates.JFOREX_BOOK_DEPTH = String(cliOpts['book-depth'] || cliOpts.bookDepth);
    if (cliOpts.port) updates.SERVER_PORT = String(cliOpts.port);
    if (cliOpts.address) updates.SERVER_ADDRESS = String(cliOpts.address);
    if (cliOpts['host-override'] || cliOpts.hostOverride) updates.HOST_OVERRIDE = String(cliOpts['host-override'] || cliOpts.hostOverride);

    const keys = Object.keys(updates);
    if (!keys.length) {
      failWithHelp('server set precisa de ao menos uma opção: --user --pass --jnlp --instruments --book-depth --port --address --host-override', () => helpServer('set'));
    }

    const next = { ...envInfo.local, ...envInfo.user, ...updates };
    writeFileSafe(envInfo.userPath, serializeDotEnv(next));
    if (fs.existsSync(envInfo.localPath)) {
      writeFileSafe(envInfo.localPath, serializeDotEnv(next));
    }
    console.log(envInfo.userPath);
    return;
  }

  const jar = cliOpts.jar || findServerJarInDir(baseDir);

  // helper: probe REST to detect unmanaged running server
  async function probeRunning() {
    const hostProbe = cliOpts.probeHost || envMerged.HOST_OVERRIDE || '127.0.0.1';
    const probeUrl = `http://${hostProbe}:${port}/api/instruments`;
    const r = await httpRequest('GET', probeUrl, {}, null, 1200).catch(() => null);
    return { ok: !!(r && r.status > 0), status: r ? r.status : 0, url: probeUrl };
  }

  if (sub === 'status') {
    if (args.length) failWithHelp('server status não aceita argumentos.', () => helpServer('status'));
    const pid = serverReadPid(rt.pid);
    if (pid && pidAlive(pid)) {
      console.log(`RUNNING (managed) pid=${pid} port=${port}`);
      return;
    }
    // no pid or dead pid -> probe
    const pr = await probeRunning();
    if (pr.ok) console.log(`RUNNING (unmanaged) port=${port} probe=${pr.status}`);
    else console.log('STOPPED');
    return;
  }

  if (sub === 'logs') {
    if (args.length) failWithHelp('server logs não aceita argumentos.', () => helpServer('logs'));
    const n = parseInt(cliOpts.n || '200', 10) || 200;
    const follow = !!cliOpts.follow;
    const content = readFileSafe(rt.logFile) || '';
    console.log(tailLines(content, n));
    if (!follow) return;

    let lastSize = fs.existsSync(rt.logFile) ? fs.statSync(rt.logFile).size : 0;
    setInterval(() => {
      if (!fs.existsSync(rt.logFile)) return;
      const st = fs.statSync(rt.logFile);
      if (st.size <= lastSize) return;
      const fd = fs.openSync(rt.logFile, 'r');
      const buf = Buffer.alloc(st.size - lastSize);
      fs.readSync(fd, buf, 0, buf.length, lastSize);
      fs.closeSync(fd);
      lastSize = st.size;
      process.stdout.write(buf.toString('utf8'));
    }, 500);
    return;
  }

  if (sub === 'down') {
    if (args.length) failWithHelp('server down não aceita argumentos.', () => helpServer('down'));
    // First try managed pidfile
    const pid = serverReadPid(rt.pid);
    if (pid && pidAlive(pid)) {
      if (isWindows()) {
        await new Promise((res) => {
          const p = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
          p.on('exit', () => res());
          p.on('error', () => res());
        });
      } else {
        try { process.kill(pid, 'SIGTERM'); } catch {}
        await new Promise(r => setTimeout(r, 800));
        if (pidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      }
      try { fs.unlinkSync(rt.pid); } catch {}
      console.log('OK (killed managed pid)');
      return;
    }

    // If no pidfile, attempt best-effort kill by port (unmanaged)
    const pr = await probeRunning();
    if (!pr.ok) {
      try { if (fs.existsSync(rt.pid)) fs.unlinkSync(rt.pid); } catch {}
      console.log('OK (sem pid; nada respondendo no probe)');
      return;
    }

    if (isWindows()) {
      let out = '';
      try {
        out = require('child_process').execSync(`netstat -ano -p tcp | findstr :${port}`, { encoding: 'utf8' });
      } catch {
        console.log('RUNNING (unmanaged). Não consegui identificar PID via netstat. Encerre manualmente.');
        return;
      }
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        if (!t.toUpperCase().includes('LISTENING')) continue;
        const parts = t.split(/\s+/);
        const pid2 = parts[parts.length - 1];
        const n = parseInt(pid2, 10);
        if (Number.isFinite(n)) pids.add(n);
      }
      if (!pids.size) {
        console.log('RUNNING (unmanaged). Não encontrei PID LISTENING para a porta. Encerre manualmente.');
        return;
      }
      for (const pidX of pids) {
        await new Promise((res) => {
          const p = spawn('taskkill', ['/PID', String(pidX), '/T', '/F'], { stdio: 'ignore' });
          p.on('exit', () => res());
          p.on('error', () => res());
        });
      }
      console.log('OK (killed unmanaged by port)');
      return;
    } else {
      const { execSync } = require('child_process');
      try {
        execSync(`fuser -k ${port}/tcp`, { stdio: 'ignore' });
        console.log('OK (killed unmanaged by port)');
        return;
      } catch {
        try {
          const pids = execSync(`lsof -t -i tcp:${port}`, { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
          for (const pidX of pids) {
            try { process.kill(parseInt(pidX, 10), 'SIGKILL'); } catch {}
          }
          if (pids.length) { console.log('OK (killed unmanaged by port)'); return; }
        } catch {}
        console.log('RUNNING (unmanaged). Não consegui matar por porta (fuser/lsof ausentes). Encerre manualmente.');
        return;
      }
    }
  }

  if (!jar && (sub === 'up' || sub === 'run')) {
    die('Não encontrei jforex-websocket-api-*.jar na pasta. Use --jar <path> ou copie o JAR para a pasta atual.');
  }

  if (sub === 'run') {
    if (args.length) failWithHelp('server run não aceita argumentos posicionais.', () => helpServer('run'));
    banner();
    const javaArgs = ['-jar', jar, `--server.port=${port}`];
    if (address) javaArgs.push(`--server.address=${address}`);
    const dd = cliOpts['--'] || [];
    javaArgs.push(...dd);
    const childEnv = envMerged;
    const p = spawn('java', javaArgs, { stdio: 'inherit', env: childEnv });
    p.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  if (sub === 'up') {
    if (args.length) failWithHelp('server up não aceita argumentos posicionais.', () => helpServer('up'));
    const pid0 = serverReadPid(rt.pid);
    if (pid0 && pidAlive(pid0)) { console.log(`OK (já rodando pid=${pid0})`); return; }
    if (pid0 && !pidAlive(pid0)) { try { fs.unlinkSync(rt.pid); } catch {} }

    if (!envMerged.JFOREX_USER || !envMerged.JFOREX_PASS) {
      warn('JFOREX_USER/JFOREX_PASS não estão no .env (o servidor pode subir, mas não vai gerar dados Dukascopy).');
    }

    writeFileSafe(rt.logFile, '');

    const javaArgs = ['-jar', jar, `--server.port=${port}`];
    if (address) javaArgs.push(`--server.address=${address}`);
    const dd = cliOpts['--'] || [];
    javaArgs.push(...dd);

    const outFd = fs.openSync(rt.logFile, 'a');
    const childEnv = envMerged;

    const child = spawn('java', javaArgs, {
      cwd: baseDir,
      env: childEnv,
      detached: true,
      stdio: ['ignore', outFd, outFd]
    });
    child.unref();
    fs.writeFileSync(rt.pid, String(child.pid), 'utf8');

    const pr = await probeRunning();
    if (!pr.ok) warn(`Servidor não respondeu no probe ${pr.url}. Veja: server logs --follow`);
    console.log(`OK (pid=${child.pid}, log=${rt.logFile})`);
    return;
  }

  failWithHelp(`server subcomando desconhecido: ${sub}`, () => helpServer());
}


async function cmd_instruments(sub, cliOpts, cfgPath, args) {
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') { helpInstruments(); return; }
  if (sub !== 'list' && sub !== 'set' && sub !== 'add' && sub !== 'remove') {
    failWithHelp(`instruments subcomando desconhecido: ${sub}`, () => helpInstruments());
  }
  const { data } = loadConfig(cfgPath);
  const { host } = resolveHostWs(cliOpts, data);

  if (sub === 'list') {
    if (args.length) failWithHelp('instruments list não aceita argumentos.', () => helpInstruments('list'));
    const r = await httpRequest('GET', `${host}/api/instruments`);
    if (r.status < 200 || r.status >= 300) die(`HTTP ${r.status}: ${r.body}`);
    console.log(cliOpts.pretty ? prettyJson(r.body) : r.body);
    return;
  }

  // parse list argument (first positional)
  const listArg = cliOpts.list || args[0] || '';
  const list = listArg.split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) failWithHelp('instruments set/add/remove precisa de uma lista "EURUSD,USDJPY".', () => helpInstruments(sub));
  if (args.length > 1) failWithHelp('instruments aceita apenas uma lista (ex.: EURUSD,USDJPY).', () => helpInstruments(sub));

  if (sub === 'set') {
    const qs = encodeURIComponent(list.join(','));
    const r = await httpRequest('POST', `${host}/api/instruments?list=${qs}`);
    if (r.status < 200 || r.status >= 300) die(`HTTP ${r.status}: ${r.body}`);
    console.log(cliOpts.pretty ? prettyJson(r.body) : r.body);
    return;
  }

  if (sub === 'add' || sub === 'remove') {
    // Get current
    const cur = await httpRequest('GET', `${host}/api/instruments`);
    if (cur.status < 200 || cur.status >= 300) die(`HTTP ${cur.status}: ${cur.body}`);
    let instruments = [];
    try {
      const obj = JSON.parse(cur.body);
      instruments = Array.isArray(obj.instruments) ? obj.instruments : [];
    } catch { instruments = []; }

    const set = new Set(instruments.map(s => normalizeInstrument(s)));

    if (sub === 'add') list.forEach(x => set.add(normalizeInstrument(x)));
    else list.forEach(x => set.delete(normalizeInstrument(x)));

    const merged = Array.from(set.values());
    const qs = encodeURIComponent(merged.join(','));
    const r = await httpRequest('POST', `${host}/api/instruments?list=${qs}`);
    if (r.status < 200 || r.status >= 300) die(`HTTP ${r.status}: ${r.body}`);
    console.log(cliOpts.pretty ? prettyJson(r.body) : r.body);
    return;
  }

  failWithHelp(`instruments subcomando desconhecido: ${sub}`, () => helpInstruments());
}

async function cmd_orderbook(sub, cliOpts, cfgPath, args) {
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') { helpOrderbook(); return; }
  if (sub !== 'latest' && sub !== 'top' && sub !== 'levels' && sub !== 'watch') {
    failWithHelp(`orderbook subcomando desconhecido: ${sub}`, () => helpOrderbook());
  }
  const { data } = loadConfig(cfgPath);
  const { host } = resolveHostWs(cliOpts, data);
  const instrument = normalizeInstrument(cliOpts.instrument || args[0] || '');
  if (args.length > 1) failWithHelp('orderbook aceita no máximo um instrumento como argumento.', () => helpOrderbook(sub));

  async function getOne() {
    const url = instrument ? `${host}/api/orderbook?instrument=${encodeURIComponent(instrument)}` : `${host}/api/orderbook`;
    const r = await httpRequest('GET', url);
    if (r.status < 200 || r.status >= 300) die(`HTTP ${r.status}: ${r.body}`);
    return r.body;
  }

  if (sub === 'latest') {
    const body = await getOne();
    console.log(cliOpts.pretty ? prettyJson(body) : body);
    return;
  }

  if (sub === 'top') {
    const body = await getOne();
    let obj;
    try { obj = JSON.parse(body); } catch { die('Resposta não é JSON'); }
    const bestBid = obj.bestBid ?? obj.bid;
    const bestAsk = obj.bestAsk ?? obj.ask;
    const spread = (bestAsk && bestBid) ? (bestAsk - bestBid) : obj.spread;
    console.log(JSON.stringify({ instrument: obj.instrument, bestBid, bestAsk, spread }, null, cliOpts.pretty ? 2 : 0));
    return;
  }

  if (sub === 'levels') {
    const n = parseInt(cliOpts.n || '10', 10) || 10;
    const body = await getOne();
    let obj;
    try { obj = JSON.parse(body); } catch { die('Resposta não é JSON'); }
    const out = {
      instrument: obj.instrument,
      bids: Array.isArray(obj.bids) ? obj.bids.slice(0, n) : [],
      asks: Array.isArray(obj.asks) ? obj.asks.slice(0, n) : []
    };
    const s = JSON.stringify(out, null, cliOpts.pretty ? 2 : 0);
    if (cliOpts.out) { fs.writeFileSync(cliOpts.out, s + '\n', 'utf8'); console.error(`OK -> ${cliOpts.out}`); }
    else console.log(s);
    return;
  }

  if (sub === 'watch') {
    const every = parseInt(cliOpts.every || '1000', 10) || 1000;
    const count = parseInt(cliOpts.count || '0', 10) || 0;
    let i = 0;
    while (true) {
      const body = await getOne();
      console.log(cliOpts.pretty ? prettyJson(body) : body);
      i++;
      if (count > 0 && i >= count) break;
      await new Promise(r => setTimeout(r, every));
    }
    return;
  }

  failWithHelp(`orderbook subcomando desconhecido: ${sub}`, () => helpOrderbook());
}

async function cmd_history(sub, cliOpts, cfgPath, args) {
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') { helpHistory(); return; }
  if (sub !== 'bars' && sub !== 'csv') {
    failWithHelp(`history subcomando desconhecido: ${sub}`, () => helpHistory());
  }
  const { data } = loadConfig(cfgPath);
  const { host } = resolveHostWs(cliOpts, data);

  const instrumentRaw = cliOpts.instrument || args[0];
  if (!instrumentRaw) failWithHelp('history precisa de --instrument (ex.: EUR/USD).', () => helpHistory(sub));
  if (args.length > 1) failWithHelp('history aceita no máximo um instrumento como argumento.', () => helpHistory(sub));
  const instrument = instrumentRaw;

  const period = (cliOpts.period || 'M1').toUpperCase();
  const side = (cliOpts.side || 'BID').toUpperCase();

  let from = cliOpts.from ? parseInt(cliOpts.from, 10) : null;
  let to = cliOpts.to ? parseInt(cliOpts.to, 10) : null;
  if (!from || !to) {
    const minutes = cliOpts.minutes ? parseInt(cliOpts.minutes, 10) : null;
    if (!minutes) failWithHelp('history precisa de --from/--to (epoch ms) ou --minutes N.', () => helpHistory(sub));
    to = nowMs();
    from = to - minutes * 60 * 1000;
  }

  const url = `${host}/api/history?instrument=${encodeURIComponent(instrument)}&period=${encodeURIComponent(period)}&from=${from}&to=${to}&side=${encodeURIComponent(side)}`;
  const r = await httpRequest('GET', url);
  if (r.status < 200 || r.status >= 300) die(`HTTP ${r.status}: ${r.body}`);

  if (sub === 'bars') {
    console.log(cliOpts.pretty ? prettyJson(r.body) : r.body);
    return;
  }

  if (sub === 'csv') {
    let arr;
    try { arr = JSON.parse(r.body); } catch { die('Resposta não é JSON.'); }
    if (!Array.isArray(arr)) {
      // Some implementations wrap in {bars:[...]}
      arr = arr?.bars;
    }
    if (!Array.isArray(arr)) die('Formato inesperado do histórico (esperado array).');

    const fields = (cliOpts.fields || 'time,open,high,low,close,volume').split(',').map(s => s.trim()).filter(Boolean);
    const lines = [];
    lines.push(fields.join(','));
    for (const row of arr) {
      const vals = fields.map(f => {
        const v = row?.[f];
        return (v === undefined || v === null) ? '' : String(v);
      });
      lines.push(vals.join(','));
    }
    const csv = lines.join('\n') + '\n';
    if (cliOpts.out) { fs.writeFileSync(cliOpts.out, csv, 'utf8'); console.error(`OK -> ${cliOpts.out}`); }
    else process.stdout.write(csv);
    return;
  }

  failWithHelp(`history subcomando desconhecido: ${sub}`, () => helpHistory());
}

async function cmd_ws(sub, cliOpts, cfgPath, args) {
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') { helpWs(); return; }
  if (args.length) failWithHelp('ws não aceita argumentos posicionais.', () => helpWs(sub));
  if (sub !== 'tail' && sub !== 'dump' && sub !== 'stats') {
    failWithHelp(`ws subcomando desconhecido: ${sub}`, () => helpWs());
  }
  const { data } = loadConfig(cfgPath);
  const { ws } = resolveHostWs(cliOpts, data);

  const type = cliOpts.type || '';
  const instrument = normalizeInstrument(cliOpts.instrument || '');
  const pretty = !!cliOpts.pretty;

  const limit = cliOpts.limit ? parseInt(cliOpts.limit, 10) : null;
  const duration = cliOpts.duration ? parseFloat(cliOpts.duration) : null; // seconds

  if (sub === 'tail' || sub === 'dump' || sub === 'stats') {
    banner();
  }

  let outStream = null;
  if (sub === 'dump') {
    const out = cliOpts.out;
    if (!out) failWithHelp('ws dump precisa de --out arquivo.', () => helpWs('dump'));
    outStream = fs.createWriteStream(out, { flags: 'a' });
    process.stderr.write(`Dump -> ${out}\n`);
  }

  let start = Date.now();
  let count = 0;
  const counts = new Map(); // key: type|instrument
  const lastReport = { t: Date.now(), n: 0 };

  const conn = await wsConnect(ws, (text) => {
    let obj = null;
    try { obj = JSON.parse(text); } catch { return; }

    if (type && obj.type !== type) return;
    if (instrument && normalizeInstrument(obj.instrument) !== instrument) return;

    count++;

    if (sub === 'stats') {
      const k = `${obj.type}|${obj.instrument}`;
      counts.set(k, (counts.get(k) || 0) + 1);
      const now = Date.now();
      if (now - lastReport.t >= 1000) {
        const dt = (now - lastReport.t) / 1000;
        const dn = count - lastReport.n;
        lastReport.t = now;
        lastReport.n = count;
        process.stdout.write(`msgs/s=${(dn/dt).toFixed(1)} total=${count}\n`);
      }
    } else if (sub === 'dump') {
      outStream.write(text + '\n');
    } else { // tail
      process.stdout.write((pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj)) + '\n');
    }

    if (limit && count >= limit) conn.close();
    if (duration && (Date.now() - start) / 1000 >= duration) conn.close();
  }, (evt, e) => {
    if (evt === 'error') warn(String(e));
  });

  // wait until closed
  await new Promise((res) => {
    const timer = setInterval(() => {
      if ((limit && count >= limit) || (duration && (Date.now() - start) / 1000 >= duration)) {
        clearInterval(timer);
        res();
      }
    }, 100);
    setTimeout(() => {
      // safety
      if (!limit && !duration) return;
      clearInterval(timer);
      res();
    }, (duration ? duration * 1000 + 2000 : 600000));
  });

  try { conn.close(); } catch {}
  if (outStream) outStream.end();

  if (sub === 'stats') {
    // Print summary
    const rows = Array.from(counts.entries())
      .map(([k, v]) => ({ k, v }))
      .sort((a, b) => b.v - a.v);
    process.stdout.write('--- summary ---\n');
    for (const r of rows.slice(0, 30)) process.stdout.write(`${r.v}\t${r.k}\n`);
  }
}

async function cmd_raw(cliOpts, args) {
  if (args && args.length) failWithHelp('raw não aceita argumentos posicionais.', helpRaw);
  const method = (cliOpts.method || 'GET').toUpperCase();
  const url = cliOpts.url;
  if (!url) failWithHelp('raw precisa de --url.', helpRaw);
  let body = null;
  const headers = {};
  if (cliOpts.body) {
    body = cliOpts.body;
    headers['Content-Type'] = 'application/json';
  }
  const r = await httpRequest(method, url, headers, body);
  if (cliOpts.pretty) console.log(prettyJson(r.body));
  else process.stdout.write(r.body);
}

async function cmd_json(sub, cliOpts, args) {
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') { helpJson(); return; }
  if (args && args.length) failWithHelp('json não aceita argumentos posicionais.', () => helpJson(sub));
  const input = cliOpts.in ? readFileSafe(cliOpts.in) : null;
  const data = input !== null ? input : await new Promise((res) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => s += c);
    process.stdin.on('end', () => res(s));
  });

  if (sub === 'pretty') {
    process.stdout.write(prettyJson(data) + '\n');
    return;
  }
  if (sub === 'get') {
    const p = cliOpts.path;
    if (!p) failWithHelp('json get precisa de --path a.b[0].c', () => helpJson('get'));
    let obj;
    try { obj = JSON.parse(data); } catch { die('entrada não é JSON'); }
    const v = jsonGetPath(obj, p);
    if (typeof v === 'object') process.stdout.write(JSON.stringify(v, null, 2) + '\n');
    else process.stdout.write(String(v ?? '') + '\n');
    return;
  }
  failWithHelp(`json subcomando desconhecido: ${sub}`, () => helpJson());
}

async function cmd_mt5(sub, cliOpts, args) {
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') { helpMt5(); return; }
  if (sub !== 'export') failWithHelp('mt5 só suporta: export.', helpMt5);
  if (args.length) failWithHelp('mt5 export não aceita argumentos posicionais.', helpMt5);
  const envInfo = loadEnvFiles(process.cwd());
  const envMerged = envInfo.merged;

  let targets = [];
  if (cliOpts.out) {
    targets = [cliOpts.out];
  } else {
    const list = envMerged.MT5_DATA_DIRS || envMerged.MT5_DATA_DIR || '';
    if (list) targets = splitList(list);
    else targets = [path.join(process.cwd(), 'mt5')];
  }

  const mql5Dirs = targets.map(ensureMql5Dir).filter(Boolean);
  if (!mql5Dirs.length) failWithHelp('mt5 export: nenhum caminho válido encontrado.', helpMt5);

  const ea = MT5_EA_SOURCE;
  const ind = MT5_IND_SOURCE;
  if (!ea || !ind) die('Fonte do EA/Indicador não embutida nesta build.');

  for (const mql5 of mql5Dirs) {
    mkdirp(mql5);
    const expertsDir = path.join(mql5, 'Experts');
    const indDir = path.join(mql5, 'Indicators');
    mkdirp(expertsDir); mkdirp(indDir);
    writeFileSafe(path.join(expertsDir, 'dukascopy-api_WS_Service_EA.mq5'), ea);
    writeFileSafe(path.join(indDir, 'dukascopy-api_L2_VolumeProfile_GV.mq5'), ind);
  }

  if (mql5Dirs.length === 1) console.log(mql5Dirs[0]);
  else mql5Dirs.forEach(p => console.log(p));
}

// -------- Embedded MT5 sources (optional) --------
const MT5_EA_SOURCE = `//+------------------------------------------------------------------+
//| dukascopy-api_WS_Service_EA.mq5                                           |
//| EA servico: conecta no WebSocket do servidor e publica L2 em      |
//| Global Variables do Terminal.                                     |
//|                                                                  |
//| Suporta ws:// (sem TLS).                                          |
//+------------------------------------------------------------------+
#property strict
#property copyright "Eduardo Candeia Goncalves"
#property version   "1.0.0"

input string WsUrl            = "ws://127.0.0.1:8080/ws/market";
input string InstrumentFilter = "";            // vazio => usa Symbol()
input string TypeFilter       = "orderbook";   // "orderbook" recomendado
input int    Depth            = 10;            // niveis por lado
input int    TimerMs          = 20;            // loop
input bool   VerboseLog       = false;

string GVPrefix(const string inst) { return "dukascopy-api."+inst+"."; }

int    g_sock=-1;
string g_host="";
int    g_port=0;
string g_path="/";
bool   g_connected=false;
uchar  g_rx[];
double g_seq=0;

void V(string s){ if(VerboseLog) Print(s); }
void E(string s){ Print(s); }

bool ParseWsUrl(const string url, string &host, int &port, string &path)
{
   host=""; port=0; path="/";
   string u=url;
   if(StringFind(u,"ws://")!=0){ E("WsUrl deve comecar com ws://"); return false; }
   u=StringSubstr(u,5);
   int slash=StringFind(u,"/");
   string hostport=(slash>=0)?StringSubstr(u,0,slash):u;
   path=(slash>=0)?StringSubstr(u,slash):"/";
   int colon=StringFind(hostport,":");
   if(colon>=0){ host=StringSubstr(hostport,0,colon); port=(int)StringToInteger(StringSubstr(hostport,colon+1)); }
   else { host=hostport; port=80; }
   if(StringLen(host)==0) return false;
   if(port<=0) port=80;
   if(StringLen(path)==0) path="/";
   return true;
}

string Base64Encode(const uchar &src[], int len)
{
   string table="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
   string out="";
   int i=0;
   while(i<len)
   {
      int b0=src[i++];
      int b1=(i<len)?src[i++]:-1;
      int b2=(i<len)?src[i++]:-1;
      int trip=(b0<<16)|((b1<0?0:b1)<<8)|(b2<0?0:b2);
      int c0=(trip>>18)&63, c1=(trip>>12)&63, c2=(trip>>6)&63, c3=trip&63;
      out+=StringSubstr(table,c0,1);
      out+=StringSubstr(table,c1,1);
      if(b1<0) out+="="; else out+=StringSubstr(table,c2,1);
      if(b2<0) out+="="; else out+=StringSubstr(table,c3,1);
   }
   return out;
}

bool SendAll(const uchar &buf[], uint n){ return (SocketSend(g_sock,buf,n)==(int)n); }

bool ReadAvailable()
{
   if(g_sock<0) return false;
   if(!SocketIsConnected(g_sock)) return false;
   uint can=(uint)SocketIsReadable(g_sock);
   if(can==0) return true;
   uchar tmp[];
   int r=SocketRead(g_sock,tmp,can,1);
   if(r<=0) return true;
   int old=ArraySize(g_rx);
   ArrayResize(g_rx,old+r);
   for(int i=0;i<r;i++) g_rx[old+i]=tmp[i];
   return true;
}

bool TryPopWsText(string &msg)
{
   msg="";
   int n=ArraySize(g_rx);
   if(n<2) return false;
   int p=0;
   uchar b0=g_rx[p], b1=g_rx[p+1];
   bool fin=((b0&0x80)!=0);
   int opcode=(int)(b0&0x0F);
   bool masked=((b1&0x80)!=0);
   int plen7=(int)(b1&0x7F);
   p+=2;

   long payload_len=0;
   if(plen7<=125) payload_len=plen7;
   else if(plen7==126)
   {
      if(n<p+2) return false;
      payload_len=((long)g_rx[p]<<8)|(long)g_rx[p+1];
      p+=2;
   }
   else
   {
      if(n<p+8) return false;
      payload_len=0;
      for(int i=0;i<8;i++) payload_len=(payload_len<<8)|(long)g_rx[p+i];
      p+=8;
   }

   uchar maskkey[4];
   if(masked)
   {
      if(n<p+4) return false;
      for(int i=0;i<4;i++) maskkey[i]=g_rx[p+i];
      p+=4;
   }

   if(n<p+(int)payload_len) return false;

   if(opcode==1 && fin)
   {
      uchar payload[];
      ArrayResize(payload,(int)payload_len);
      for(int i=0;i<(int)payload_len;i++)
      {
         uchar c=g_rx[p+i];
         if(masked) c=(uchar)(c^maskkey[i%4]);
         payload[i]=c;
      }
      msg=CharArrayToString(payload,0,(int)payload_len,CP_UTF8);
   }

   int consumed=p+(int)payload_len;
   int remain=n-consumed;
   if(remain>0)
   {
      uchar nb[];
      ArrayResize(nb,remain);
      for(int i=0;i<remain;i++) nb[i]=g_rx[consumed+i];
      ArrayResize(g_rx,remain);
      for(int i=0;i<remain;i++) g_rx[i]=nb[i];
   }
   else ArrayResize(g_rx,0);

   return (StringLen(msg)>0);
}

int FindMatching(const string s,const int startPos,const ushort openCh,const ushort closeCh)
{
   int depth=0,len=StringLen(s);
   for(int i=startPos;i<len;i++)
   {
      ushort c=(ushort)StringGetCharacter(s,i);
      if(c==openCh) depth++;
      else if(c==closeCh){ depth--; if(depth==0) return i; }
   }
   return -1;
}

bool ExtractJsonArray(const string json,const string key,string &outArrayContent)
{
   outArrayContent="";
   string k="\\""+key+"\\"";
   int kp=StringFind(json,k);
   if(kp<0) return false;
   int lb=StringFind(json,"[",kp);
   if(lb<0) return false;
   int rb=FindMatching(json,lb,'[',']');
   if(rb<0) return false;
   outArrayContent=StringSubstr(json,lb+1,rb-lb-1);
   return true;
}

bool ExtractJsonString(const string json,const string key,string &val)
{
   val="";
   string k="\\""+key+"\\"";
   int kp=StringFind(json,k);
   if(kp<0) return false;
   int cp=StringFind(json,":",kp);
   if(cp<0) return false;
   int q1=StringFind(json,"\\"",cp);
   if(q1<0) return false;
   int q2=StringFind(json,"\\"",q1+1);
   if(q2<0) return false;
   val=StringSubstr(json,q1+1,q2-(q1+1));
   return true;
}

bool ExtractJsonNumber(const string obj,const string key,double &val)
{
   val=0.0;
   string k="\\""+key+"\\"";
   int kp=StringFind(obj,k);
   if(kp<0) return false;
   int cp=StringFind(obj,":",kp);
   if(cp<0) return false;
   int i=cp+1,n=StringLen(obj);
   while(i<n)
   {
      ushort c=(ushort)StringGetCharacter(obj,i);
      if(c!=' '&&c!='\\t'&&c!='\\r'&&c!='\\n') break;
      i++;
   }
   if(i>=n) return false;
   int j=i;
   while(j<n)
   {
      ushort c=(ushort)StringGetCharacter(obj,j);
      bool ok=(c>='0'&&c<='9')||c=='.'||c=='-'||c=='+'||c=='e'||c=='E';
      if(!ok) break;
      j++;
   }
   if(j<=i) return false;
   string token=StringSubstr(obj,i,j-i);
   val=StringToDouble(token);
   return true;
}

int ParseLevels(const string arrayContent,const int maxLevels,double &prices[],double &vols[])
{
   ArrayResize(prices,0); ArrayResize(vols,0);
   int pos=0,count=0,len=StringLen(arrayContent);
   while(pos<len && count<maxLevels)
   {
      int lb=StringFind(arrayContent,"{",pos);
      if(lb<0) break;
      int rb=FindMatching(arrayContent,lb,'{','}');
      if(rb<0) break;
      string obj=StringSubstr(arrayContent,lb+1,rb-lb-1);
      double price=0.0, vol=0.0;
      bool okP=ExtractJsonNumber(obj,"price",price);
      bool okV=ExtractJsonNumber(obj,"volume",vol);
      if(!okV) okV=ExtractJsonNumber(obj,"quantity",vol);
      if(okP && okV)
      {
         int n0=ArraySize(prices);
         ArrayResize(prices,n0+1);
         ArrayResize(vols,n0+1);
         prices[n0]=price; vols[n0]=vol; count++;
      }
      pos=rb+1;
   }
   return count;
}

void GVSet(const string name,const double value){ GlobalVariableSet(name,value); }

void PublishOrderBook(const string json)
{
   string type=""; ExtractJsonString(json,"type",type);
   if(StringLen(TypeFilter)>0 && type!=TypeFilter) return;

   string instrument=""; ExtractJsonString(json,"instrument",instrument);
   if(StringLen(instrument)==0) return;

   string wantInst=InstrumentFilter;
   if(StringLen(wantInst)==0) wantInst=Symbol();
   StringReplace(wantInst,"/","");

   if(instrument!=wantInst) return;
   if(type!="orderbook") return;

   double bid=0,ask=0,ts=0;
   ExtractJsonNumber(json,"bid",bid);
   ExtractJsonNumber(json,"ask",ask);
   ExtractJsonNumber(json,"timestamp",ts);

   string bidsArr="",asksArr="";
   ExtractJsonArray(json,"bids",bidsArr);
   ExtractJsonArray(json,"asks",asksArr);

   double bp[],bv[],ap[],av[];
   int nb=ParseLevels(bidsArr,Depth,bp,bv);
   int na=ParseLevels(asksArr,Depth,ap,av);

   string pfx=GVPrefix(instrument);

   GVSet(pfx+"ts",ts);
   GVSet(pfx+"bid",bid);
   GVSet(pfx+"ask",ask);
   GVSet(pfx+"depth",(double)Depth);

   for(int i=1;i<=Depth;i++)
   {
      double p=0,v=0;
      if(i<=nb){ p=bp[i-1]; v=bv[i-1]; }
      GVSet(pfx+"B.P"+(string)i,p);
      GVSet(pfx+"B.V"+(string)i,v);

      p=0; v=0;
      if(i<=na){ p=ap[i-1]; v=av[i-1]; }
      GVSet(pfx+"A.P"+(string)i,p);
      GVSet(pfx+"A.V"+(string)i,v);
   }

   g_seq+=1.0;
   GVSet(pfx+"seq",g_seq);
   EventChartCustom(0,10001,(long)g_seq,0.0,instrument);
}

void Disconnect()
{
   if(g_sock>=0) SocketClose(g_sock);
   g_sock=-1; g_connected=false; ArrayResize(g_rx,0);
}

bool Connect()
{
   Disconnect();
   if(!ParseWsUrl(WsUrl,g_host,g_port,g_path)) return false;

   g_sock=SocketCreate();
   if(g_sock<0){ E("SocketCreate falhou err="+(string)GetLastError()); return false; }

   if(!SocketConnect(g_sock,g_host,g_port,3000))
   {
      E("SocketConnect falhou err="+(string)GetLastError());
      SocketClose(g_sock); g_sock=-1;
      return false;
   }

   uchar keybytes[16];
   for(int i=0;i<16;i++) keybytes[i]=(uchar)MathRand();
   string key=Base64Encode(keybytes,16);

   string req=
      "GET "+g_path+" HTTP/1.1\\r\\n"+
      "Host: "+g_host+":"+ (string)g_port +"\\r\\n"+
      "Upgrade: websocket\\r\\n"+
      "Connection: Upgrade\\r\\n"+
      "Sec-WebSocket-Key: "+key+"\\r\\n"+
      "Sec-WebSocket-Version: 13\\r\\n\\r\\n";

   uchar out[];
   StringToCharArray(req,out,0,WHOLE_ARRAY,CP_UTF8);
   if(!SendAll(out,(uint)(ArraySize(out)-1))){ E("Handshake send falhou"); Disconnect(); return false; }

   uchar respbuf[]; ArrayResize(respbuf,0);
   string resp="";
   for(int t=0;t<50;t++)
   {
      uint can=(uint)SocketIsReadable(g_sock);
      if(can>0)
      {
         uchar tmp[];
         int r=SocketRead(g_sock,tmp,can,200);
         if(r>0)
         {
            int old=ArraySize(respbuf);
            ArrayResize(respbuf,old+r);
            for(int i=0;i<r;i++) respbuf[old+i]=tmp[i];
            resp=CharArrayToString(respbuf,0,ArraySize(respbuf),CP_UTF8);
            if(StringFind(resp,"\\r\\n\\r\\n")>=0) break;
         }
      }
      Sleep(50);
   }

   if(StringFind(resp," 101 ")<0){ E("Handshake sem 101. Resp:\\n"+resp); Disconnect(); return false; }

   g_connected=true;
   V("WS conectado.");
   return true;
}

int OnInit()
{
   MathSrand((uint)TimeLocal());
   ArrayResize(g_rx,0);
   g_seq=0;
   int ms=TimerMs; if(ms<10) ms=10;
   EventSetMillisecondTimer(ms);
   Connect();
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   Disconnect();
}

void OnTimer()
{
   if(g_sock<0 || !SocketIsConnected(g_sock) || !g_connected){ Connect(); return; }
   if(!ReadAvailable()){ Disconnect(); return; }

   for(int i=0;i<50;i++)
   {
      string msg;
      if(!TryPopWsText(msg)) break;
      PublishOrderBook(msg);
   }
}
//+------------------------------------------------------------------+
`;
const MT5_IND_SOURCE = `//+------------------------------------------------------------------+
//| dukascopy-api_L2_VolumeProfile_GV.mq5                                     |
//| Indicador: apenas plota. Lê L2 via Global Variables do Terminal.  |
//+------------------------------------------------------------------+
#property indicator_chart_window
#property indicator_plots 0
#property strict
#property copyright "Eduardo Candeia Goncalves"
#property version   "1.0.0"

input string Instrument        = "";   // vazio => usa Symbol()
input int    Depth             = 10;
input int    ProfileRows       = 60;
input int    BinPoints         = 10;
input int    MaxBarPixels      = 240;
input int    BarHeightPixels   = 8;
input int    WallMarginPixels  = 12;
input bool   ShowText          = true;
input int    FontSize          = 8;
input string FontName          = "Consolas";
input double VolumeDivisor     = 1.0;
input int    SegmentOrder      = 0;    // 0 Bid->Ask, 1 Ask->Bid
input color  BidColor          = clrLime;
input color  AskColor          = clrRed;

string g_prefix;
double g_binSize=0.0;

long   g_keys[];
double g_bidAgg[];
double g_askAgg[];

double g_lastBid=0.0;
double g_lastAsk=0.0;
double g_lastSeq=-1.0;

string NormalizeInst(string s){ StringReplace(s,"/",""); return s; }
string GVPrefix(const string inst){ return "dukascopy-api."+inst+"."; }

int FindKeyIndex(const long key)
{
   int n=ArraySize(g_keys);
   for(int i=0;i<n;i++) if(g_keys[i]==key) return i;
   return -1;
}

long PriceToKey(const double price){ return (g_binSize<=0.0)?0:(long)MathRound(price/g_binSize); }
double KeyToPrice(const long key){ return (double)key*g_binSize; }

void AddToBin(const long key,const double bidAdd,const double askAdd)
{
   int idx=FindKeyIndex(key);
   if(idx<0)
   {
      int n=ArraySize(g_keys);
      ArrayResize(g_keys,n+1);
      ArrayResize(g_bidAgg,n+1);
      ArrayResize(g_askAgg,n+1);
      g_keys[n]=key; g_bidAgg[n]=0.0; g_askAgg[n]=0.0;
      idx=n;
   }
   g_bidAgg[idx]+=bidAdd;
   g_askAgg[idx]+=askAdd;
}

void ObjRectLabelUpsert(const string name,const int x,const int y,const int w,const int h,const color col)
{
   if(ObjectFind(0,name)<0)
   {
      ObjectCreate(0,name,OBJ_RECTANGLE_LABEL,0,0,0);
      ObjectSetInteger(0,name,OBJPROP_CORNER,CORNER_LEFT_UPPER);
      ObjectSetInteger(0,name,OBJPROP_SELECTABLE,false);
      ObjectSetInteger(0,name,OBJPROP_BACK,true);
      ObjectSetInteger(0,name,OBJPROP_HIDDEN,true);
   }
   ObjectSetInteger(0,name,OBJPROP_XDISTANCE,x);
   ObjectSetInteger(0,name,OBJPROP_YDISTANCE,y);
   ObjectSetInteger(0,name,OBJPROP_XSIZE,MathMax(0,w));
   ObjectSetInteger(0,name,OBJPROP_YSIZE,MathMax(0,h));
   ObjectSetInteger(0,name,OBJPROP_COLOR,col);
}

void ObjTextUpsert(const string name,const int x,const int y,const string text)
{
   if(ObjectFind(0,name)<0)
   {
      ObjectCreate(0,name,OBJ_LABEL,0,0,0);
      ObjectSetInteger(0,name,OBJPROP_CORNER,CORNER_LEFT_UPPER);
      ObjectSetInteger(0,name,OBJPROP_SELECTABLE,false);
      ObjectSetInteger(0,name,OBJPROP_BACK,true);
      ObjectSetInteger(0,name,OBJPROP_HIDDEN,true);
      ObjectSetInteger(0,name,OBJPROP_FONTSIZE,FontSize);
      ObjectSetString(0,name,OBJPROP_FONT,FontName);
      ObjectSetInteger(0,name,OBJPROP_COLOR,clrSilver);
   }
   ObjectSetInteger(0,name,OBJPROP_XDISTANCE,x);
   ObjectSetInteger(0,name,OBJPROP_YDISTANCE,y);
   ObjectSetString(0,name,OBJPROP_TEXT,text);
}

void DeleteAllObjects()
{
   int total=ObjectsTotal(0,0,-1);
   for(int i=total-1;i>=0;i--)
   {
      string name=ObjectName(0,i,0,-1);
      if(StringFind(name,g_prefix)==0) ObjectDelete(0,name);
   }
}

bool GVGetSafe(const string name,double &val){ return GlobalVariableGet(name,val); }

bool LoadSnapshot(const string inst)
{
   string pfx=GVPrefix(inst);
   double seq;
   if(!GVGetSafe(pfx+"seq",seq)) return false;
   if(seq==g_lastSeq) return false;

   ArrayResize(g_keys,0);
   ArrayResize(g_bidAgg,0);
   ArrayResize(g_askAgg,0);

   double bid=0,ask=0;
   GVGetSafe(pfx+"bid",bid);
   GVGetSafe(pfx+"ask",ask);
   g_lastBid=bid; g_lastAsk=ask;

   for(int i=1;i<=Depth;i++)
   {
      double bp=0,bv=0,ap=0,av=0;
      GVGetSafe(pfx+"B.P"+(string)i,bp);
      GVGetSafe(pfx+"B.V"+(string)i,bv);
      GVGetSafe(pfx+"A.P"+(string)i,ap);
      GVGetSafe(pfx+"A.V"+(string)i,av);

      if(bp>0) AddToBin(PriceToKey(bp), bv/VolumeDivisor, 0.0);
      if(ap>0) AddToBin(PriceToKey(ap), 0.0, av/VolumeDivisor);
   }

   g_lastSeq=seq;
   return true;
}

void Render(const datetime anchorTime)
{
   if(g_binSize<=0.0) return;
   if(ArraySize(g_keys)==0) return;

   double mid=0.0;
   if(g_lastBid>0.0 && g_lastAsk>0.0) mid=(g_lastBid+g_lastAsk)/2.0;
   else if(g_lastBid>0.0) mid=g_lastBid;
   else if(g_lastAsk>0.0) mid=g_lastAsk;
   else return;

   int rows=MathMax(10,ProfileRows);
   int half=rows/2;
   long centerKey=PriceToKey(mid);
   long minKey=centerKey-half;
   long maxKey=centerKey+half;

   double maxTotal=0.0;
   for(long k=minKey;k<=maxKey;k++)
   {
      int idx=FindKeyIndex(k);
      if(idx<0) continue;
      double t=g_bidAgg[idx]+g_askAgg[idx];
      if(t>maxTotal) maxTotal=t;
   }
   if(maxTotal<=0.0) maxTotal=1.0;

   int chartW=(int)ChartGetInteger(0,CHART_WIDTH_IN_PIXELS,0);
   int wallX=chartW-WallMarginPixels;

   DeleteAllObjects();

   for(long k=minKey;k<=maxKey;k++)
   {
      int idx=FindKeyIndex(k);
      if(idx<0) continue;
      double bidV=g_bidAgg[idx];
      double askV=g_askAgg[idx];
      double total=bidV+askV;
      if(total<=0.0) continue;

      double price=KeyToPrice(k);

      int x=0,y=0;
      if(!ChartTimePriceToXY(0,0,anchorTime,price,x,y)) continue;

      int barLen=(int)MathRound((total/maxTotal)*MaxBarPixels);
      barLen=MathMax(1,MathMin(MaxBarPixels,barLen));

      int yTop=y-(BarHeightPixels/2);
      int startX=wallX-barLen; if(startX<0) startX=0;

      int bidLen=(int)MathRound(barLen*(bidV/total));
      bidLen=MathMax(0,MathMin(barLen,bidLen));
      int askLen=barLen-bidLen;

      int len1=(SegmentOrder==0)?bidLen:askLen;
      int len2=barLen-len1;

      color col1=(SegmentOrder==0)?BidColor:AskColor;
      color col2=(SegmentOrder==0)?AskColor:BidColor;

      string name1=g_prefix+"S1_"+(string)k;
      string name2=g_prefix+"S2_"+(string)k;

      ObjRectLabelUpsert(name1,startX,yTop,len1,BarHeightPixels,col1);
      ObjRectLabelUpsert(name2,startX+len1,yTop,len2,BarHeightPixels,col2);

      if(ShowText)
      {
         string txt=DoubleToString(price,_Digits)+"  B:"+DoubleToString(bidV,0)+" A:"+DoubleToString(askV,0);
         string nameT=g_prefix+"T_"+(string)k;
         int tx=startX-150; if(tx<0) tx=0;
         ObjTextUpsert(nameT,tx,yTop-1,txt);
      }
   }
}

int OnInit()
{
   g_prefix="JXVG_"+(string)ChartID()+"_";
   g_binSize=BinPoints*_Point;
   ArrayResize(g_keys,0);
   ArrayResize(g_bidAgg,0);
   ArrayResize(g_askAgg,0);
   g_lastSeq=-1.0;
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason){ DeleteAllObjects(); }

int OnCalculate(const int rates_total,
                const int prev_calculated,
                const datetime &time[],
                const double &open[],
                const double &high[],
                const double &low[],
                const double &close[],
                const long &tick_volume[],
                const long &volume[],
                const int &spread[])
{
   if(rates_total<=0) return 0;

   string inst=Instrument;
   if(StringLen(inst)==0) inst=Symbol();
   inst=NormalizeInst(inst);

   if(LoadSnapshot(inst)) Render(time[0]);
   return rates_total;
}
//+------------------------------------------------------------------+
`;

// -------- main --------
(async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) { helpRoot(); return; }

  const dd = argv.indexOf('--');
  const argvNoDD = dd >= 0 ? argv.slice(0, dd) : argv;
  const ddArgs = dd >= 0 ? argv.slice(dd + 1) : [];

  // Global flags
  const cfgPath = (() => {
    const i = argvNoDD.indexOf('--config');
    if (i >= 0 && argvNoDD[i + 1]) return argvNoDD[i + 1];
    return null;
  })();

  // Extract --host/--ws for resolveHostWs
  const globalOpts = parseArgs(argvNoDD);

  const cmd = argvNoDD[0];
  let sub = argvNoDD[1];
  let subArgv = argvNoDD.slice(2);
  if (!sub || sub.startsWith('--')) {
    sub = null;
    subArgv = argvNoDD.slice(1);
  }
  const subOpts = parseArgs(subArgv);
  const cliOpts = { ...globalOpts, ...subOpts, _: subOpts._ };
  if (ddArgs.length) cliOpts['--'] = ddArgs;
  const subArgs = subOpts._ || [];

  if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
    const topic = sub;
    const subtopic = subArgs[0];
    if (!topic) { helpRoot(); return; }
    if (topic === 'config') { helpConfig(subtopic); return; }
    if (topic === 'doctor') { helpDoctor(); return; }
    if (topic === 'server') { helpServer(subtopic); return; }
    if (topic === 'instruments') { helpInstruments(subtopic); return; }
    if (topic === 'orderbook') { helpOrderbook(subtopic); return; }
    if (topic === 'history') { helpHistory(subtopic); return; }
    if (topic === 'ws') { helpWs(subtopic); return; }
    if (topic === 'raw') { helpRaw(); return; }
    if (topic === 'json') { helpJson(subtopic); return; }
    if (topic === 'mt5') { helpMt5(); return; }
    helpRoot();
    return;
  }
  if (cmd === 'version') { banner(); return; }

  if (cmd === 'config') { await cmd_config(sub, subArgs, cfgPath); return; }
  if (cmd === 'doctor') { await cmd_doctor(cliOpts, cfgPath, subArgs); return; }
  if (cmd === 'server') {
    await cmd_server(sub, cliOpts, cfgPath, subArgs);
    return;
  }
  if (cmd === 'instruments') { await cmd_instruments(sub, cliOpts, cfgPath, subArgs); return; }
  if (cmd === 'orderbook') { await cmd_orderbook(sub, cliOpts, cfgPath, subArgs); return; }
  if (cmd === 'history') { await cmd_history(sub, cliOpts, cfgPath, subArgs); return; }
  if (cmd === 'ws') { await cmd_ws(sub, cliOpts, cfgPath, subArgs); return; }
  if (cmd === 'raw') { await cmd_raw(cliOpts, subArgs); return; }
  if (cmd === 'json') { await cmd_json(sub, cliOpts, subArgs); return; }
  if (cmd === 'mt5') { await cmd_mt5(sub, cliOpts, subArgs); return; }

  failWithHelp(`Comando desconhecido: ${cmd}`, helpRoot);
})().catch(e => die(e?.stack || String(e)));
