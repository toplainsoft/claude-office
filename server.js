#!/usr/bin/env node
// 클로드 오피스 — Claude Code 세션 기록(~/.claude/projects/**.jsonl)을 따라 읽어서
// 브라우저 속 사무실 캐릭터를 움직이는 로컬 서버. 설치할 패키지 없음, 토큰 사용 없음.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const PORT = +process.env.PORT || 4777;
const ROOT = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const TAIL_MS = 250;          // 활성 파일을 따라 읽는 간격
const SCAN_MS = 2000;         // 새 프로젝트·세션을 찾는 간격
const HOT_MS = 15 * 60e3;     // 이 시간 안에 바뀐 파일만 실시간으로 따라 읽음
const ACTIVE_MS = 90e3;       // 이 시간 안에 움직인 세션 = 불 켜진 매장
const BOOT_BYTES = 256 * 1024;
const CODEX_ON = !process.env.NO_CODEX;
const CODEX_DIR = process.env.CODEX_SESSIONS_DIR || path.join(os.homedir(), '.codex', 'sessions');
const CODEX_INDEX = path.join(path.dirname(CODEX_DIR), 'session_index.jsonl');
const USER = (() => { try { return os.userInfo().username; } catch { return '나'; } })();// 처음 볼 때 현재 상태를 복원하려고 읽는 꼬리 크기

// ───────── 도구 → 방 ─────────
const ROOM = {
  Read: 'library', Glob: 'library', Grep: 'library', LS: 'library', NotebookRead: 'library',
  Edit: 'dev', Write: 'dev', MultiEdit: 'dev', NotebookEdit: 'dev',
  Bash: 'server', BashOutput: 'server', KillShell: 'server', KillBash: 'server', Monitor: 'server', TaskStop: 'server',
  WebSearch: 'web', WebFetch: 'web', ToolSearch: 'web', ListMcpResourcesTool: 'web', ReadMcpResourceTool: 'web',
  TodoWrite: 'meeting', TaskCreate: 'meeting', TaskUpdate: 'meeting', TaskList: 'meeting', TaskGet: 'meeting',
  EnterPlanMode: 'meeting', ExitPlanMode: 'meeting', Skill: 'meeting',
  AskUserQuestion: 'boss',
  Task: 'phone', Agent: 'phone',
};
const roomOf = (name) => (name && name.startsWith('mcp__')) ? 'web' : (ROOM[name] || 'desk');
const isAgentTool = (name) => name === 'Task' || name === 'Agent';

const snip = (s, n = 80) => {
  s = String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
function detailOf(inp) {
  inp = inp || {};
  if (inp.file_path) return path.basename(String(inp.file_path));
  if (inp.notebook_path) return path.basename(String(inp.notebook_path));
  if (inp.command) return snip(inp.command, 48);
  if (inp.pattern) return snip(inp.pattern, 40);
  if (inp.query) return snip(inp.query, 48);
  if (inp.url) { try { return new URL(inp.url).host; } catch { return snip(inp.url, 40); } }
  if (inp.description) return snip(inp.description, 48);
  if (inp.subject) return snip(inp.subject, 48);
  if (Array.isArray(inp.todos)) return `할 일 ${inp.todos.length}개`;
  if (Array.isArray(inp.questions) && inp.questions[0]) return snip(inp.questions[0].question, 48);
  if (inp.plan) return snip(inp.plan, 48);
  if (inp.skill) return snip(inp.skill, 40);
  return '';
}
const textOf = (c) => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map(x => (x && (x.text || (typeof x === 'string' ? x : ''))) || '').join(' ') : '';
const contentArr = (msg) => !msg ? [] : typeof msg.content === 'string'
  ? [{ type: 'text', text: msg.content }] : (Array.isArray(msg.content) ? msg.content : []);

// ───────── 상태 ─────────
const sessions = new Map(); // key → session
const files = new Map();    // 파일경로 → tail 정보
const projects = new Map(); // 디렉터리명 → { dir, name }
const clients = new Set();

function getSession(proj, sid) {
  const key = proj + '/' + sid;
  let S = sessions.get(key);
  if (!S) {
    S = { key, proj, sid, mtime: 0, cwd: '', summary: '', firstPrompt: '',
      room: 'desk', tool: '', detail: '', mood: '', bubble: null,
      agents: {}, pending: {}, board: [], fileAgent: {}, lastEv: 0, tools: 0, started: 0, agent: 'claude', main: true, title: '' };
    sessions.set(key, S);
  }
  return S;
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

// 상태를 바꾸고, 실시간이면 브라우저로 보냄
function ev(S, live, e) {
  if (/^(tool|think|say|user|error)$/.test(e.k)) S.waiting = 0; // 다시 움직이면 답변 대기 끝
  switch (e.k) {
    case 'wait': S.waiting = e.since || Date.now(); S.room = 'boss'; S.tool = ''; S.mood = ''; break; // 말을 마치고 사용자 답을 기다림 → 대표실
    case 'tool': if (e.room === 'boss') S.waiting = Date.now(); S.room = e.room; S.tool = e.tool; S.detail = e.detail; S.mood = 'work'; S.bubble = null; S.tools++; break;
    case 'think': S.mood = 'think'; S.bubble = { k: 'think', text: e.text }; break;
    case 'say': S.mood = ''; S.bubble = { k: 'say', text: e.text }; break;
    case 'error': S.mood = 'sweat'; S.bubble = { k: 'error', text: e.text }; break;
    case 'user': S.room = 'desk'; S.tool = ''; S.detail = ''; S.mood = ''; S.bubble = { k: 'user', text: e.text }; break;
    case 'spawn': S.agents[e.id] = { id: e.id, type: e.type, desc: e.desc, room: 'lobby', tool: '', detail: '', tools: 0, since: e.since || Date.now() }; break;
    case 'agentTool': if (S.agents[e.id]) { Object.assign(S.agents[e.id], { room: e.room, tool: e.tool, detail: e.detail }); S.agents[e.id].tools++; } break;
    case 'agentDone': delete S.agents[e.id]; break;
    case 'board': S.board = e.items; break;
  }
  if (live) { S.lastEv = Date.now(); broadcast('ev', Object.assign({ session: S.key, at: Date.now() }, e)); }
}
const publicAgent = (a) => ({ id: a.id, type: a.type, desc: a.desc, room: a.room, tool: a.tool, detail: a.detail, tools: a.tools, since: a.since });

// ───────── jsonl 한 줄 해석 ─────────
function applyLine(S, o, live, agentFile) {
  if (!o || typeof o !== 'object') return;
  if (o.type === 'summary' && o.summary) { S.summary = snip(o.summary, 40); return; }
  if (o.cwd && !S.cwd) S.cwd = o.cwd;
  if (agentFile || o.isSidechain) return applySub(S, o, live, agentFile);
  const content = contentArr(o.message);

  if (o.type === 'assistant') {
    for (const c of content) {
      if (!c) continue;
      if (c.type === 'thinking' || c.type === 'redacted_thinking') {
        ev(S, live, { k: 'think', text: snip(c.thinking, 90) || '생각 중…' });
      } else if (c.type === 'text' && c.text && c.text.trim()) {
        ev(S, live, { k: 'say', text: snip(c.text, 90) });
      } else if (c.type === 'tool_use') {
        const inp = c.input || {};
        S.pending[c.id] = c.name;
        ev(S, live, { k: 'tool', tool: c.name, room: roomOf(c.name), detail: detailOf(inp) });
        if (isAgentTool(c.name)) {
          const a = { k: 'spawn', id: c.id, type: inp.subagent_type || 'general-purpose', desc: snip(inp.description || inp.prompt, 40), since: o.timestamp ? Date.parse(o.timestamp) : Date.now() };
          ev(S, live, a);
          if (S.agents[c.id]) { S.agents[c.id].prompt = String(inp.prompt || '').trim().slice(0, 200); S.agents[c.id].seen = Date.now(); }
        }
        if (c.name === 'TodoWrite' && Array.isArray(inp.todos)) {
          ev(S, live, { k: 'board', items: inp.todos.slice(0, 8).map(t => ({ t: snip(t.content || t.activeForm, 34), s: t.status })) });
        } else if (c.name === 'TaskCreate' && inp.subject) {
          ev(S, live, { k: 'board', items: S.board.concat([{ t: snip(inp.subject, 34), s: 'pending' }]).slice(-8) });
        } else if (c.name === 'TaskUpdate' && inp.taskId && inp.status) {
          const i = parseInt(inp.taskId, 10) - 1;
          if (S.board[i]) { const b = S.board.map(x => Object.assign({}, x)); b[i].s = inp.status; ev(S, live, { k: 'board', items: b }); }
        } else if (c.name === 'ExitPlanMode' && inp.plan) {
          const lines = String(inp.plan).split('\n').map(l => l.replace(/^[#*\-\d.\s]+/, '').trim()).filter(Boolean);
          ev(S, live, { k: 'board', items: lines.slice(0, 7).map(t => ({ t: snip(t, 34), s: 'pending' })) });
        }
      }
    }
    if (o.message && o.message.stop_reason === 'end_turn') ev(S, live, { k: 'wait', since: Date.parse(o.timestamp) || Date.now() });
  } else if (o.type === 'user') {
    for (const c of content) {
      if (!c) continue;
      if (c.type === 'tool_result') {
        const name = S.pending[c.tool_use_id];
        delete S.pending[c.tool_use_id];
        const txt = textOf(c.content);
        if (c.is_error) ev(S, live, { k: 'error', text: snip(txt.split('\n')[0], 70) || '도구 실패' });
        if (isAgentTool(name) && S.agents[c.tool_use_id]) {
          if (/background|async|launched|running in/i.test(txt) && !c.is_error) S.agents[c.tool_use_id].bg = true;
          else ev(S, live, { k: 'agentDone', id: c.tool_use_id });
        }
      } else if (c.type === 'text' && !o.isMeta) {
        const t = String(c.text || '').trim();
        if (!t) continue;
        if (t.includes('<task-notification>')) { // 백그라운드 에이전트 완료 알림
          const bg = Object.values(S.agents).find(a => a.bg);
          if (bg) ev(S, live, { k: 'agentDone', id: bg.id });
          continue;
        }
        if (/^<(command|local-command|system-reminder|bash-|user-memory)/.test(t) || t.startsWith('Caveat:')) continue;
        if (!S.firstPrompt) S.firstPrompt = snip(t, 40);
        ev(S, live, { k: 'user', text: snip(t, 70) });
      }
    }
  }
}

// 서브에이전트 기록 (별도 파일 또는 isSidechain 줄)
function applySub(S, o, live, agentFile) {
  let id = agentFile ? S.fileAgent[agentFile] : null;
  const content = contentArr(o.message);
  if (id && !S.agents[id]) { // 이미 퇴근한 에이전트의 파일: 새 프롬프트로 시작할 때만 다시 연결
    const isPrompt = o.type === 'user' && content.some(c => c && c.type === 'text');
    if (!isPrompt) return;
    delete S.fileAgent[agentFile]; id = null;
  }
  if (!id && agentFile) {
    const prompt = o.type === 'user' ? content.filter(c => c && c.type === 'text').map(c => c.text).join(' ').trim() : '';
    const free = Object.values(S.agents).filter(a => !a.file);
    let a = prompt && free.find(x => x.prompt && (prompt.startsWith(x.prompt.slice(0, 80)) || x.prompt.startsWith(prompt.slice(0, 80))));
    if (!a) a = free[0];
    if (!a && live) { // 서버가 켜지기 전에 출근한 에이전트
      ev(S, live, { k: 'spawn', id: 'f:' + agentFile, type: o.agentType || 'general-purpose', desc: snip(prompt, 40) });
      a = S.agents['f:' + agentFile]; if (a) a.bg = true;
    }
    if (a) { a.file = agentFile; id = a.id; S.fileAgent[agentFile] = id; }
  }
  if (!id && !agentFile) { const list = Object.values(S.agents); id = list.length ? list[list.length - 1].id : null; }
  const A = id && S.agents[id];
  if (!A) return;
  A.seen = Date.now();
  if (o.type === 'assistant') {
    for (const c of content) {
      if (c && c.type === 'tool_use') ev(S, live, { k: 'agentTool', id, tool: c.name, room: roomOf(c.name) === 'phone' ? 'desk' : roomOf(c.name), detail: detailOf(c.input) });
    }
  } else if (o.type === 'user') {
    for (const c of content) if (c && c.type === 'tool_result' && c.is_error) ev(S, live, { k: 'agentErr', id, text: snip(textOf(c.content), 60) });
  }
}

// ───────── 출퇴근 기록부: 오늘 일한 5분 칸 ─────────
// 기록 줄마다 붙은 시각(timestamp)으로 '오늘 몇 시 몇 분대에 움직였나'를 5분 단위로 모음
const dayKey = (t) => { const d = new Date(t); return d.getFullYear() * 1e4 + (d.getMonth() + 1) * 100 + d.getDate(); };
const TS_RE = /"timestamp":"([^"]+)"/g;
const monthKey = (t) => Math.floor(dayKey(t) / 100);
function markWork(S, ts) { // 오늘 칸(출퇴근 기록부) + 이번 달 칸(이달의 직원)
  const t = typeof ts === 'number' ? ts : Date.parse(ts); if (!t) return;
  const now = Date.now(), d = new Date(t), b = Math.floor((d.getHours() * 60 + d.getMinutes()) / 5);
  if (monthKey(t) !== monthKey(now)) return;
  if (S.monthOf !== monthKey(now)) { S.monthOf = monthKey(now); S.month = new Set(); }
  S.month.add(d.getDate() * 288 + b);
  const today = dayKey(now); if (dayKey(t) !== today) return;
  if (S.workDay !== today) { S.workDay = today; S.work = new Set(); }
  S.work.add(b);
}
function scanToday(S, fp, size) { // 이번 달에 바뀐 파일은 처음 한 번 통째로 훑어서 이번 달 시각만 모음
  const CH = 1 << 20;
  for (let pos = 0; pos < size; pos += CH) {
    const txt = readRange(fp, pos, Math.min(size, pos + CH + 64)); // 경계에 걸친 시각도 잡히게 조금 겹쳐 읽음
    for (const m of txt.matchAll(TS_RE)) markWork(S, m[1]);
  }
}
const monthMin = (S) => S.monthOf === monthKey(Date.now()) && S.month ? S.month.size * 5 : 0;
// ───────── 하루 요약 리포트: 오늘 한 일 모으기 ─────────
// 오늘 줄만 골라서 방(도구 종류)별 횟수 · 고친 파일 · 내가 시킨 일 · 에러 수를 모음 (AI 없음)
function dayRec(S) { const k = dayKey(Date.now()); if (!S.day || S.day.k !== k) S.day = { k, tools: {}, files: new Set(), prompts: [], errors: 0 }; return S.day; }
const SKIP_TXT = /^<(command|local-command|system-reminder|bash-|user-memory|task-notification)/;
function noteDay(S, o, F) {
  const t = Date.parse(o && o.timestamp); if (!t || dayKey(t) !== dayKey(Date.now())) return;
  const D = dayRec(S), tool = (room) => { D.tools[room] = (D.tools[room] || 0) + 1; };
  const say = (tx) => { D.prompts.push(snip(tx, 60)); if (D.prompts.length > 20) D.prompts.shift(); };
  if (F.codex) {
    const pl = o.payload; if (!pl || F.child) return;
    if (o.type === 'response_item' && (pl.type === 'custom_tool_call' || pl.type === 'function_call')) { const a = codexCallOf(pl); if (!a) return; tool(a.room); if (a.room === 'dev' && a.detail) D.files.add(a.detail); }
    else if (o.type === 'event_msg' && pl.type === 'item_completed' && pl.item) {
      const it = pl.item;
      if (it.type === 'UserMessage') { const tx = textItems(it.content); if (tx) say(tx); }
      else if (it.type === 'FileChange') for (const f of Object.keys(it.changes || {})) D.files.add(path.basename(f));
      else if (it.type === 'CommandExecution' && it.exit_code) D.errors++;
    }
    return;
  }
  const content = contentArr(o.message);
  if (o.type === 'assistant') for (const c of content) if (c && c.type === 'tool_use') {
    const r = roomOf(c.name), inp = c.input || {}; tool(r);
    if (r === 'dev' && (inp.file_path || inp.notebook_path)) D.files.add(path.basename(String(inp.file_path || inp.notebook_path)));
  }
  if (o.type === 'user' && !F.agentFile && !o.isSidechain) for (const c of content) {
    if (c && c.type === 'tool_result' && c.is_error) D.errors++;
    else if (c && c.type === 'text' && !o.isMeta) { const tx = String(c.text || '').trim(); if (tx && !SKIP_TXT.test(tx) && !tx.startsWith('Caveat:') && !tx.includes('<task-notification>')) say(tx); }
  }
}
function scanDayLines(S, fp, size, F) { // 오늘 바뀐 파일: 오늘 시각이 붙은 줄만 풀어서 noteDay
  const CH = 1 << 20; let rem = '';
  for (let pos = 0; pos < size; pos += CH) {
    const lines = (rem + readRange(fp, pos, Math.min(size, pos + CH))).split('\n'); rem = lines.pop();
    for (const l of lines) {
      const m = l.match(/"timestamp":"([^"]+)"/); if (!m || dayKey(Date.parse(m[1])) !== dayKey(Date.now())) continue;
      try { noteDay(S, JSON.parse(l), F); } catch { }
    }
  }
}
const dayOf = (S) => S.day && S.day.k === dayKey(Date.now()) ? { tools: S.day.tools, files: [...S.day.files].slice(-40), prompts: S.day.prompts.slice(-12), errors: S.day.errors } : null;
const workOf = (S) => S.workDay === dayKey(Date.now()) && S.work ? [...S.work].sort((a, b) => a - b) : [];

// ───────── 파일 따라 읽기 ─────────
function readRange(fp, start, end) {
  const len = Math.max(0, end - start);
  if (!len) return '';
  const fd = fs.openSync(fp, 'r');
  try { const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, start); return buf.toString('utf8'); }
  finally { fs.closeSync(fd); }
}
function feed(F, text, live) {
  const S = sessions.get(F.key);
  const chunk = F.rem + text;
  const lines = chunk.split('\n');
  F.rem = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (live && o && o.timestamp) { markWork(S, o.timestamp); noteDay(S, o, F); }
    if (F.codex) applyCodexLine(S, o, live, F); else applyLine(S, o, live, F.agentFile);
  }
}
function track(fp, proj, sid, agentFile) {
  let st; try { st = fs.statSync(fp); } catch { return; }
  let F = files.get(fp);
  const S = getSession(proj, sid);
  if (!agentFile) S.mtime = Math.max(S.mtime, st.mtimeMs);
  if (F) { F.mtime = st.mtimeMs; return; }
  F = { fp, key: S.key, agentFile, offset: 0, rem: '', mtime: st.mtimeMs };
  files.set(fp, F);
  try {
    if (!agentFile) { // 제목·작업 폴더를 얻으려고 앞부분만 훑기
      const head = readRange(fp, 0, Math.min(st.size, 48 * 1024)).split('\n');
      for (const l of head) {
        let o; try { o = JSON.parse(l); } catch { continue; }
        if (o.cwd && !S.cwd) S.cwd = o.cwd;
        if (o.timestamp && !S.started) S.started = Date.parse(o.timestamp) || 0;
        if (o.type === 'summary' && o.summary && !S.summary) S.summary = snip(o.summary, 40);
        if (!S.firstPrompt && o.type === 'user' && !o.isMeta) {
          const t = contentArr(o.message).filter(c => c && c.type === 'text').map(c => c.text).join(' ').trim();
          if (t && !/^<(command|local-command|system-reminder)/.test(t) && !t.startsWith('Caveat:')) S.firstPrompt = snip(t, 40);
        }
      }
    }
    if (monthKey(st.mtimeMs) === monthKey(Date.now())) scanToday(S, fp, st.size);
    if (dayKey(st.mtimeMs) === dayKey(Date.now())) scanDayLines(S, fp, st.size, F);
    if (Date.now() - st.mtimeMs < HOT_MS) { // 지금 상태를 복원 (애니메이션 없이)
      const start = Math.max(0, st.size - BOOT_BYTES);
      let txt = readRange(fp, start, st.size);
      if (start > 0) txt = txt.slice(txt.indexOf('\n') + 1);
      feed(F, txt, false);
    }
  } catch { /* 읽기 실패는 무시 */ }
  F.offset = st.size;
  F.rem = '';
}

function scan() {
  let dirs = [];
  try { dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { }
  for (const d of dirs) {
    const pdir = path.join(ROOT, d.name);
    if (!projects.has(d.name)) projects.set(d.name, { dir: d.name });
    let ents = [];
    try { ents = fs.readdirSync(pdir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isFile() && e.name.endsWith('.jsonl')) track(path.join(pdir, e.name), d.name, e.name.slice(0, -6));
      else if (e.isDirectory()) {
        const sub = path.join(pdir, e.name, 'subagents');
        let subs = [];
        try { subs = fs.readdirSync(sub).filter(n => n.endsWith('.jsonl')); } catch { }
        for (const n of subs) track(path.join(sub, n), d.name, e.name, n);
      }
    }
  }
  scanCodex(); codexKidsTick();
  // 백그라운드 에이전트: 한동안 조용하면 퇴근 처리
  const now = Date.now();
  for (const S of sessions.values()) {
    for (const a of Object.values(S.agents)) if (a.bg && now - (a.seen || 0) > 45e3) ev(S, true, { k: 'agentDone', id: a.id });
  }
  sendSnapshot();
}

function tail() {
  const now = Date.now();
  for (const F of files.values()) {
    if (now - F.mtime > HOT_MS) continue;
    let st; try { st = fs.statSync(F.fp); } catch { continue; }
    F.mtime = st.mtimeMs;
    if (st.size < F.offset) { F.offset = 0; F.rem = ''; }
    if (st.size > F.offset) {
      const S = sessions.get(F.key);
      if (!F.agentFile || F.codex) S.mtime = Math.max(S.mtime, st.mtimeMs);
      try { feed(F, readRange(F.fp, F.offset, st.size), true); } catch { }
      F.offset = st.size;
    }
  }
}

// ───────── Codex (데스크톱 앱 · CLI) ─────────
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl 을 같은 방식으로 따라 읽음 (압축된 .zst 는 지난 기록이라 건너뜀)
const codexTitles = new Map(); let codexIndexM = 0;
function loadCodexIndex() {
  let st; try { st = fs.statSync(CODEX_INDEX); } catch { return; }
  if (st.mtimeMs === codexIndexM) return; codexIndexM = st.mtimeMs;
  try { for (const l of fs.readFileSync(CODEX_INDEX, 'utf8').split('\n')) { try { const o = JSON.parse(l); if (o.id && o.thread_name) codexTitles.set(o.id, snip(o.thread_name, 40)); } catch { } } } catch { }
}
function firstLine(fp) {
  const fd = fs.openSync(fp, 'r'); const CH = 256 * 1024; let out = '', pos = 0;
  try {
    while (pos < 16 * 1024 * 1024) {
      const buf = Buffer.alloc(CH); const n = fs.readSync(fd, buf, 0, CH, pos); if (!n) break;
      const s = buf.slice(0, n).toString('utf8'); const i = s.indexOf('\n');
      if (i >= 0) return out + s.slice(0, i);
      out += s; pos += n;
    }
  } finally { fs.closeSync(fd); }
  return out;
}
const textItems = (arr) => (Array.isArray(arr) ? arr : [arr]).map(c => typeof c === 'string' ? c : (c && (c.text || ''))).join(' ').trim();
const READ_CMD = /^(cat|sed|head|tail|nl|less|more|rg|grep|ag|ls|find|fd|tree|wc|stat|file|du|pwd|realpath|jq|git (show|log|diff|status|blame|grep|ls-files))\b/;
function codexCmd(cmd) {
  cmd = String(cmd || '').replace(/^(bash|zsh|sh)\s+-l?c\s+/, '').replace(/^['"]/, '').trim();
  if (/apply_patch|\*\*\* Begin Patch/.test(cmd)) return { tool: '수정', room: 'dev', detail: '' };
  return READ_CMD.test(cmd) ? { tool: '읽기', room: 'library', detail: snip(cmd, 48) } : { tool: '실행', room: 'server', detail: snip(cmd, 48) };
}
function codexCallOf(pl) { // 도구를 부르는 순간 (실시간)
  const name = String(pl.name || '');
  const raw = String(pl.input != null ? pl.input : (pl.arguments || ''));
  if (name === 'exec' || name === 'shell' || name === 'exec_command' || name === 'local_shell') {
    let cmd = '';
    const m = raw.match(/\bcmd\s*:\s*"((?:[^"\\]|\\.)*)"/) || raw.match(/\bcmd\s*:\s*'((?:[^'\\]|\\.)*)'/) || raw.match(/\bcmd\s*:\s*`([^`]*)`/);
    if (m) cmd = m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"');
    else { try { const a = JSON.parse(raw); cmd = Array.isArray(a.command) ? a.command.join(' ') : (a.cmd || a.command || ''); } catch { } }
    if (/apply_patch|\*\*\* (Update|Add) File/.test(raw)) { const f = raw.match(/\*\*\* (?:Update|Add|Delete) File: ([^\\\n"]+)/); return { tool: '수정', room: 'dev', detail: f ? path.basename(f[1].trim()) : '' }; }
    if (cmd) return codexCmd(cmd);
    const t = raw.match(/\btools\.(\w+)\s*\(/); // 코드 안에서 다른 도구를 부름 (mcp__… 등)
    if (t && t[1] !== 'exec_command') return codexCallOf({ name: t[1].replace(/^mcp__/, '').replace(/__/, '.'), input: raw });
    return { tool: '실행', room: 'server', detail: '' };
  }
  if (name === 'wait' || name === 'write_stdin') return null; // 이미 돌고 있는 명령을 기다리는 중 — 방은 그대로
  if (name === 'run') { // 웹 검색·열기 묶음
    let q = ''; try { const a = JSON.parse(raw); const x = (a.search_query || a.open || a.find || [])[0] || {}; q = x.q || x.ref_id || x.pattern || ''; } catch { }
    return { tool: '웹 검색', room: 'web', detail: snip(q, 48) };
  }
  if (name === 'apply_patch') { const f = raw.match(/\*\*\* (?:Update|Add|Delete) File: ([^\\\n"]+)/); return { tool: '수정', room: 'dev', detail: f ? path.basename(f[1].trim()) : '' }; }
  if (name === 'update_plan') return { tool: '계획', room: 'meeting', detail: '' };
  if (/spawn|agent/i.test(name)) return { tool: '도우미 호출', room: 'phone', detail: '' };
  if (/search|fetch|browse/i.test(name)) return { tool: name, room: 'web', detail: '' };
  if (name.includes('__') || name.includes('.')) return { tool: name, room: 'web', detail: '' };
  return { tool: name || '도구', room: 'desk', detail: '' };
}
function codexItemOf(it) { // 끝난 작업 (item_completed)
  switch (it.type) {
    case 'FileChange': { const fs_ = Object.keys(it.changes || {}); return { tool: '파일 수정', room: 'dev', detail: fs_.length ? path.basename(fs_[0]) + (fs_.length > 1 ? ` 외 ${fs_.length - 1}개` : '') : '' }; }
    case 'McpToolCall': return { tool: `${it.server || 'mcp'}.${it.tool || ''}`, room: 'web', detail: '', err: it.result && it.result.isError };
    case 'Extension': return /search/.test(it.kind || '') ? { tool: '웹 검색', room: 'web', detail: snip(it.query || ((it.action && it.action.queries) || [])[0], 48) } : null;
    case 'WebSearch': return { tool: '웹 검색', room: 'web', detail: snip(it.query, 48) };
    case 'CommandExecution': {
      const pc = (it.parsed_cmd || [])[0] || {};
      const read = /read|list|search/.test(pc.type || '');
      return { tool: read ? '읽기' : '실행', room: read ? 'library' : 'server', detail: snip(pc.path ? path.basename(pc.path) : (pc.cmd || (it.command || []).join(' ')), 48), exit: it.exit_code, out: it.stderr || it.aggregated_output, cmd: true };
    }
  }
  return null;
}
function codexSubType(meta) {
  const ts = String(meta.thread_source || ''), sub = meta.source && meta.source.subagent;
  const other = sub && (sub.other || Object.keys(sub)[0]);
  return (/guardian/i.test(ts) || other === 'guardian') ? 'Guardian' : 'Helper';
}
const firstMeaningful = (t) => String(t || '').split('\n').map(x => x.trim()).find(Boolean) || '';

function applyCodexLine(S, o, live, F) {
  const pl = o && o.payload; if (!pl || typeof pl !== 'object') return;
  if (o.type === 'turn_context' && pl.cwd && !S.cwd) S.cwd = pl.cwd;
  if (F.child) return applyCodexChild(S, o, pl, live, F.child);
  if (o.type === 'response_item' && (pl.type === 'custom_tool_call' || pl.type === 'function_call')) {
    const a = codexCallOf(pl); if (!a) return;
    ev(S, live, { k: 'tool', tool: a.tool, room: a.room, detail: a.detail });
    if (pl.name === 'update_plan') { try { const args = JSON.parse(pl.arguments || pl.input || '{}'); if (Array.isArray(args.plan)) ev(S, live, { k: 'board', items: args.plan.slice(0, 8).map(x => ({ t: snip(x.step, 34), s: x.status })) }); } catch { } }
    return;
  }
  if (o.type === 'event_msg' && pl.type === 'token_count') { codexRate(pl, o.timestamp); return; }
  if (o.type === 'event_msg' && (pl.type === 'task_complete' || pl.type === 'turn_aborted')) { ev(S, live, { k: 'wait', since: Date.parse(o.timestamp) || Date.now() }); return; }
  if (o.type === 'event_msg' && pl.type === 'item_completed' && pl.item) {
    const it = pl.item;
    if (it.type === 'UserMessage') { const t = textItems(it.content); if (t) { if (!S.firstPrompt) S.firstPrompt = snip(t, 40); ev(S, live, { k: 'user', text: snip(t, 70) }); } return; }
    if (it.type === 'AgentMessage') { const t = textItems(it.content); if (t) ev(S, live, { k: 'say', text: snip(t.replace(/[*#`]/g, ''), 90) }); return; }
    if (it.type === 'Reasoning') { const t = textItems(it.summary_text).replace(/\*\*/g, ''); ev(S, live, { k: 'think', text: snip(t, 90) || '생각 중…' }); return; }
    const a = codexItemOf(it); if (!a) return;
    if (a.cmd) { // exec 로 이미 움직였으면 방이 바뀔 때만
      if (a.room !== S.room) ev(S, live, { k: 'tool', tool: a.tool, room: a.room, detail: a.detail });
      if (a.exit) ev(S, live, { k: 'error', text: snip(firstMeaningful(a.out), 70) || `종료 코드 ${a.exit}` });
      return;
    }
    ev(S, live, { k: 'tool', tool: a.tool, room: a.room, detail: a.detail });
    if (a.err) ev(S, live, { k: 'error', text: '도구 실패' });
  }
}
const codexKids = []; // [S, C] — 검토 요원은 한 명이 머물다가 조용해지면 퇴근
function applyCodexChild(S, o, pl, live, C) {
  const aid = () => `cx:${C.id}:${C.n}`;
  const start = () => {
    C.last = Date.now(); C.pendingDone = false;
    if (C.active) return; C.n++; C.active = true;
    ev(S, live, { k: 'spawn', id: aid(), type: C.type, desc: C.type === 'Guardian' ? '작업 검토' : 'Codex 도우미', since: Date.parse(o.timestamp) || Date.now() });
  };
  if (o.type === 'event_msg' && pl.type === 'task_started') { const was = C.active; start(); if (was) ev(S, live, { k: 'agentTool', id: aid(), tool: C.type === 'Guardian' ? '검토' : '작업', room: 'dev', detail: '' }); return; }
  if (o.type === 'event_msg' && pl.type === 'task_complete') {
    if (!C.active) return;
    if (!live) { C.active = false; ev(S, false, { k: 'agentDone', id: aid() }); return; }
    C.pendingDone = true; C.last = Date.now(); return;
  }
  let a = null;
  if (o.type === 'response_item' && (pl.type === 'custom_tool_call' || pl.type === 'function_call')) a = codexCallOf(pl);
  else if (o.type === 'event_msg' && pl.type === 'item_completed' && pl.item && pl.item.type !== 'CommandExecution') a = codexItemOf(pl.item);
  if (!a) return;
  start();
  ev(S, live, { k: 'agentTool', id: aid(), tool: a.tool, room: a.room === 'phone' ? 'desk' : a.room, detail: a.detail });
}
function codexKidsTick() {
  const now = Date.now();
  for (const [S, C] of codexKids) if (C.active && C.pendingDone && now - C.last > 20e3) { C.active = false; C.pendingDone = false; ev(S, true, { k: 'agentDone', id: `cx:${C.id}:${C.n}` }); }
}
function trackCodex(fp) {
  let st; try { st = fs.statSync(fp); } catch { return; }
  let F = files.get(fp);
  if (F) { F.mtime = st.mtimeMs; const S = sessions.get(F.key); if (S) S.mtime = Math.max(S.mtime, st.mtimeMs); return; }
  let meta = {};
  try { const o = JSON.parse(firstLine(fp)); if (o && o.type === 'session_meta') meta = o.payload || {}; } catch { }
  const fid = (path.basename(fp).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/) || [])[1];
  const id = meta.id || fid; if (!id) return;
  let S, child = null;
  if (meta.parent_thread_id) { S = getSession('codex', meta.parent_thread_id); if (!S.agent || S.agent === 'claude') { S.agent = 'codex'; if (!S.cwd) S.main = false; } child = { id, type: codexSubType(meta), n: 0, active: false }; codexKids.push([S, child]); }
  else { S = getSession('codex', id); S.agent = 'codex'; S.main = true; if (meta.cwd) S.cwd = meta.cwd; if (meta.timestamp) S.started = Date.parse(meta.timestamp) || 0; }
  S.mtime = Math.max(S.mtime, st.mtimeMs);
  F = { fp, key: S.key, codex: true, child, offset: 0, rem: '', mtime: st.mtimeMs };
  if (!child && Date.now() - st.mtimeMs < 8 * 864e5) { try { codexRateBoot(fp, st.size); } catch { } }
  files.set(fp, F);
  try {
    if (!child && !S.firstPrompt) {
      const head = readRange(fp, 0, Math.min(st.size, 512 * 1024)).split('\n');
      for (const l of head) { if (!l.includes('"UserMessage"')) continue; try { const t = textItems(JSON.parse(l).payload.item.content); if (t) { S.firstPrompt = snip(t, 40); break; } } catch { } }
    }
    if (monthKey(st.mtimeMs) === monthKey(Date.now())) scanToday(S, fp, st.size);
    if (dayKey(st.mtimeMs) === dayKey(Date.now())) scanDayLines(S, fp, st.size, F);
    if (Date.now() - st.mtimeMs < HOT_MS) {
      const start = Math.max(0, st.size - BOOT_BYTES);
      let txt = readRange(fp, start, st.size);
      if (start > 0) txt = txt.slice(txt.indexOf('\n') + 1);
      feed(F, txt, false);
    }
  } catch { }
  F.offset = st.size; F.rem = '';
}
function scanCodex() {
  if (!CODEX_ON) return;
  loadCodexIndex();
  const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
  for (const y of ls(CODEX_DIR)) { if (!/^\d{4}$/.test(y)) continue;
    for (const m of ls(path.join(CODEX_DIR, y))) for (const d of ls(path.join(CODEX_DIR, y, m))) {
      const dir = path.join(CODEX_DIR, y, m, d);
      for (const f of ls(dir)) if (f.endsWith('.jsonl')) trackCodex(path.join(dir, f));
    }
  }
}

// ───────── 사용량 (항상 화면 오른쪽 위) ─────────
// Codex: 기록의 token_count 에 rate_limits(5시간 primary · 주간 secondary)가 그대로 있음 → 가장 최근 것
// Claude: 기록엔 없음. statusline.js(Claude Code 상태줄)가 받은 rate_limits 를 usage.json 에 적어 둔 걸 읽음
let codexUsage = null;
function codexRate(pl, ts) {
  const r = pl.rate_limits; if (!r) return;
  const at = Date.parse(ts) || Date.now(); if (codexUsage && codexUsage.at > at) return;
  const win = (w) => w && typeof w.used_percent === 'number' ? { used: w.used_percent, resets_at: w.resets_at || 0 } : null;
  codexUsage = { five_hour: win(r.primary), seven_day: win(r.secondary), plan: r.plan_type || '', at };
}
function codexRateBoot(fp, size) { // 가장 최근 Codex 파일 끝부분에서 마지막 사용량 찾기
  const txt = readRange(fp, Math.max(0, size - 256 * 1024), size).split('\n');
  for (let i = txt.length - 1; i >= 0; i--) {
    if (!txt[i].includes('"token_count"') || !txt[i].includes('rate_limits')) continue;
    try { const o = JSON.parse(txt[i]); codexRate(o.payload, o.timestamp); return; } catch { }
  }
}
const USAGE = path.join(__dirname, 'usage.json');
function usageNow() {
  let claude = null; try { claude = JSON.parse(fs.readFileSync(USAGE, 'utf8')).claude || null; } catch { }
  const fresh = (u) => { // 초기화 시각이 지난 칸은 0% 로
    if (!u) return null;
    const fix = (w) => w && w.resets_at && w.resets_at * 1000 < Date.now() ? { used: 0, resets_at: 0 } : w;
    return Object.assign({}, u, { five_hour: fix(u.five_hour), seven_day: fix(u.seven_day) });
  };
  return { claude: fresh(claude), codex: fresh(codexUsage) };
}

// ───────── 지금 열려 있는 Claude Code 세션 ─────────
// Claude Code 는 실행 중인 세션마다 ~/.claude/sessions/<pid>.json 을 두고, 끄면 지움. (.key 파일은 열지 않음)
// 이걸로 '터미널을 닫은 세션'은 답변 대기에서 뺌. 폴더가 없는 옛 버전이면 null → 거르지 않음
const LIVE_DIR = path.join(path.dirname(ROOT), 'sessions');
function liveClaude() {
  let names; try { names = fs.readdirSync(LIVE_DIR).filter(n => /^\d+\.json$/.test(n)); } catch { return null; }
  const live = new Set();
  for (const n of names) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(LIVE_DIR, n), 'utf8'));
      if (o.sessionId && o.pid) { process.kill(o.pid, 0); live.add(o.sessionId); } // 프로세스가 진짜 살아 있을 때만
    } catch { }
  }
  return live;
}

// ───────── 층 안내판 ─────────
const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
const depth = (p) => p.split('/').filter(Boolean).length;
function projName(p, list) {
  if (!p.startsWith('dir:')) return path.posix.basename(p) || p;
  const parts = p.slice(4).split('-').filter(Boolean);
  return parts[parts.length - 1] || p;
}
// 건물 이름 · 사용자 이름 (office.json, 없으면 기본값) — 처음 시작할 때 Claude 가 물어보고 만들어 줌
const CONF = path.join(__dirname, 'office.json');
function readConf() { try { return JSON.parse(fs.readFileSync(CONF, 'utf8')); } catch { return {}; } }
// 처음 설정이 필요한가: office.json 이 없거나, 이름이 비었거나, 다른 컴퓨터(홈 폴더)에서 쓰던 것
const needSetup = (c) => !c.building || !c.user || (c.home && c.home !== os.homedir());

// ───────── 처음 설정 (브라우저 설정 창 → POST /setup) ─────────
// 사용량 표시를 원하면 ~/.claude/settings.json 에 statusLine 을 추가 (다른 상태줄이 이미 있으면 건드리지 않음, 고치기 전에 백업)
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const SL_CMD = `node "${path.join(__dirname, 'statusline.js')}"`;
function statusLineState() {
  if (!fs.existsSync(path.dirname(SETTINGS))) return 'noclaude';
  let j; try { j = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch (e) { return e.code === 'ENOENT' ? 'none' : 'broken'; }
  const sl = j && j.statusLine; if (!sl) return 'none';
  return String(sl.command || '').includes(path.join(__dirname, 'statusline.js')) ? 'ours' : 'other';
}
function addStatusLine() {
  const st = statusLineState(); if (st !== 'none') return st;
  let j = {};
  if (fs.existsSync(SETTINGS)) { fs.copyFileSync(SETTINGS, SETTINGS + '.before-claude-office'); j = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); }
  j.statusLine = { type: 'command', command: SL_CMD };
  fs.writeFileSync(SETTINGS, JSON.stringify(j, null, 2) + '\n');
  return 'added';
}
const AGY_HOOKS = path.join(os.homedir(), '.gemini', 'config', 'hooks.json');
function agyHookState() { try { return JSON.parse(fs.readFileSync(AGY_HOOKS, 'utf8'))['claude-office'] ? 'on' : 'off'; } catch { return 'off'; } }
function setupInfo(c) {
  return { need: needSetup(c), statusLine: statusLineState(), hasClaude: fs.existsSync(ROOT), hasCodex: fs.existsSync(CODEX_DIR), agyHook: agyHookState() };
}
function handleSetup(req, res) {
  // 다른 웹사이트가 몰래 보내는 요청 막기: 이 서버 주소에서 온 JSON 만 받음
  const origin = req.headers.origin || '', host = req.headers.host || '';
  if ((origin && origin !== `http://${host}`) || !/^(localhost|127\.0\.0\.1):\d+$/.test(host) || !/json/.test(req.headers['content-type'] || '')) { res.writeHead(403); return res.end(); }
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on('end', () => {
    let d = {}; try { d = JSON.parse(body); } catch { }
    const clean = (t) => String(t || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
    const building = clean(d.building), user = clean(d.user);
    const out = { ok: false };
    if (!building || !user) { out.msg = '건물 이름과 내 이름을 둘 다 적어 주세요'; }
    else {
      try { fs.writeFileSync(CONF, JSON.stringify({ building, user, home: os.homedir() }, null, 2) + '\n'); out.ok = true; }
      catch (e) { out.msg = '설정 파일을 못 썼어요: ' + e.message; }
      if (out.ok && d.statusLine) { try { out.statusLine = addStatusLine(); } catch (e) { out.statusLine = 'error'; out.msg = e.message; } }
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(out));
    if (out.ok) sendSnapshot(true);
  });
}

// ───────── Antigravity (훅 → POST /agy) ─────────
// Antigravity 는 기록 파일 형식이 공개돼 있지 않아서, 훅이 보내 주는 신호를 받아요. (agy-hook.js 가 보냄)
// 쓰는 훅: SessionStart · PreInvocation(생각 시작) · PostToolUse(도구 하나 끝) · PostInvocation(답 끝)
const AGY_ROOM = {
  view_file: 'library', view_file_outline: 'library', view_code_item: 'library', list_dir: 'library',
  find_by_name: 'library', grep_search: 'library', codebase_search: 'library', view_content_chunk: 'library',
  write_to_file: 'dev', replace_file_content: 'dev', multi_replace_file_content: 'dev', generate_image: 'dev',
  run_command: 'server', command_status: 'server', send_command_input: 'server', read_terminal: 'server',
  search_web: 'web', read_url_content: 'web', read_browser_page: 'web', browser_subagent: 'web', call_mcp_tool: 'web',
  task_boundary: 'meeting', notify_user: 'boss',
};
const agyRoom = (n) => AGY_ROOM[n] || (/mcp|browser|web|url/i.test(n) ? 'web' : /file|edit|write|replace/i.test(n) ? 'dev' : /command|terminal/i.test(n) ? 'server' : /search|find|view|list|read/i.test(n) ? 'library' : 'desk');
const agyPath = (p) => { p = String(p || ''); if (p.startsWith('file://')) { try { p = decodeURIComponent(new URL(p).pathname); } catch { } } return p.replace(/^\/([A-Za-z]:\/)/, '$1'); };
function agyDetail(a) {
  a = a || {};
  const f = a.AbsolutePath || a.TargetFile || a.File || a.FilePath || a.DirectoryPath || a.SearchPath;
  if (a.CommandLine) return snip(a.CommandLine, 48);
  if (a.Query) return snip(a.Query, 48);
  if (a.Url) { try { return new URL(a.Url).host; } catch { return snip(a.Url, 40); } }
  if (a.Pattern) return snip(a.Pattern, 40);
  if (f) return path.basename(agyPath(f));
  if (a.ToolName || a.toolName) return snip(a.ToolName || a.toolName, 40);
  if (a.TaskName) return snip(a.TaskName, 40);
  return '';
}
const agySeen = new Map(); // 같은 신호가 두 곳(공통·CLI 전용 훅 파일)에서 두 번 오면 한 번만 처리
function agyDup(id, evName, d) {
  const tc = d.toolCall || {}, now = Date.now();
  const k = [id, evName, d.stepIdx, d.invocationNum, d.executionNum, tc.name, JSON.stringify(tc.args || {}).slice(0, 300)].join('|');
  for (const [x, t] of agySeen) if (now - t > 5000) agySeen.delete(x);
  if (agySeen.has(k)) return true;
  agySeen.set(k, now); return false;
}
function handleAgy(d, evName) {
  const id = String(d.conversationId || d.conversation_id || '').slice(0, 80); if (!id) return;
  if (agyDup(id, evName, d)) return;
  const S = getSession('agy', id); S.agent = 'agy'; S.main = true;
  const ws = Array.isArray(d.workspacePaths) ? d.workspacePaths[0] : d.workspacePaths;
  const tc = d.toolCall || {}, args = tc.args || {};
  if (!S.cwd) S.cwd = agyPath(ws || args.Cwd || '');
  const now = Date.now();
  if (!S.started) S.started = now;
  S.mtime = now; markWork(S, now);
  switch (evName) {
    case 'SessionStart': break;
    case 'PreInvocation': ev(S, true, { k: 'think', text: '생각 중…' }); break;
    case 'PostToolUse': {
      const name = String(tc.name || 'tool'), room = agyRoom(name), detail = agyDetail(args);
      const D = dayRec(S); D.tools[room] = (D.tools[room] || 0) + 1; if (room === 'dev' && detail) D.files.add(detail);
      ev(S, true, { k: 'tool', tool: name, room, detail });
      if (d.error) { D.errors++; ev(S, true, { k: 'error', text: snip(typeof d.error === 'string' ? d.error : (d.error.message || JSON.stringify(d.error)), 70) || '도구 실패' }); }
      break;
    }
    case 'PostInvocation': ev(S, true, { k: 'wait', since: now }); break;
  }
  sendSnapshot();
}
function receiveAgy(req, res, evName) {
  // 이 컴퓨터 안의 훅만 받음 (브라우저에서 다른 사이트가 보내는 건 Origin 이 붙어서 막힘)
  const host = req.headers.host || '';
  if (req.headers.origin || !/^(localhost|127\.0\.0\.1):\d+$/.test(host)) { res.writeHead(403); return res.end(); }
  let body = '', big = false;
  req.on('data', (c) => { if (big) return; body += c; if (body.length > 4e6) { big = true; body = ''; } }); // 파일 내용이 통째로 올 수 있어서 넉넉히
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
    if (big) return;
    try { handleAgy(JSON.parse(body || '{}'), evName); } catch { }
  });
}
function snapshot() {
  const conf = readConf(), live = liveClaude();
  const waitOf = (S) => !S.waiting ? 0 : (S.agent === 'claude' && live && !live.has(S.sid)) ? 0 : S.waiting; // 닫힌 세션은 대기 아님
  const now = Date.now();
  const list = [...sessions.values()].filter(S => S.main !== false);
  // 작업 폴더가 같으면 (또는 한쪽이 다른 쪽 안이면) 같은 층 — Claude 와 Codex 가 한 사무실에서 일함
  const keyOf = new Map(list.map(S => [S, normPath(S.cwd) || ('dir:' + S.proj)]));
  const paths = [...new Set(keyOf.values())].filter(k => !k.startsWith('dir:')).sort((a, b) => a.length - b.length);
  const canon = new Map();
  for (const k of paths) {
    let c = k;
    for (const a of paths) { if (a.length >= k.length) break; if (depth(a) >= 3 && k.startsWith(a + '/')) { c = canon.get(a) || a; break; } }
    canon.set(k, c);
  }
  const byProj = new Map();
  for (const S of list) {
    const k0 = keyOf.get(S), k = canon.get(k0) || k0;
    if (!byProj.has(k)) byProj.set(k, []);
    byProj.get(k).push(S);
  }
  const floors = [...byProj.entries()]
    .map(([p, list]) => ({ p, list, name: projName(p, list) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.p.localeCompare(b.p))
    .map((f, i) => {
      const list = f.list.sort((a, b) => b.mtime - a.mtime);
      const mtime = list[0] ? list[0].mtime : 0;
      return {
        n: i + 1, proj: f.p, name: f.name, mtime, active: now - mtime < ACTIVE_MS, total: list.length,
        sessions: list.slice(0, 40).map(S => ({
          key: S.key, sid: S.sid, agent: S.agent, work: workOf(S), month: monthMin(S), day: dayOf(S), waiting: waitOf(S), cwd: S.cwd, tools: S.tools, started: S.started, mtime: S.mtime, active: now - S.mtime < ACTIVE_MS,
          label: S.summary || codexTitles.get(S.sid) || S.firstPrompt || new Date(S.mtime).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
          state: now - S.mtime < HOT_MS ? {
            room: S.room, tool: S.tool, detail: S.detail, mood: S.mood, bubble: S.bubble,
            board: S.board, agents: Object.values(S.agents).map(publicAgent), idle: now - S.mtime > 25e3,
          } : null,
        })),
      };
    });
  return { root: ROOT, codex: CODEX_ON ? CODEX_DIR : null, user: (!needSetup(conf) && conf.user) || USER, building: (!needSetup(conf) && conf.building) || '클로드 오피스', setup: setupInfo(conf), usage: usageNow(), self: normPath(__dirname), floors };
}
let lastSnap = '';
function sendSnapshot(force) {
  const s = JSON.stringify(snapshot());
  if (!force && s === lastSnap) return;
  lastSnap = s;
  broadcast('snap', JSON.parse(s));
}

// ───────── HTTP ─────────
const HTML = path.join(__dirname, 'office.html');
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: snap\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url === '/setup' && req.method === 'POST') return handleSetup(req, res);
  if (url === '/agy' && req.method === 'POST') return receiveAgy(req, res, (new URL(req.url, 'http://x').searchParams.get('e') || '').slice(0, 30));
  if (url === '/' || url === '/index.html') {
    fs.readFile(HTML, (err, buf) => {
      if (err) { res.writeHead(500); return res.end('office.html 을 찾을 수 없어요'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(buf);
    });
    return;
  }
  res.writeHead(404); res.end();
});
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15e3);

scan();
setInterval(scan, SCAN_MS);
setInterval(tail, TAIL_MS);

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n🏢 클로드 오피스 개장!  ${url}`);
  console.log(`   지켜보는 폴더: ${ROOT}`);
  if (CODEX_ON) console.log(`   Codex 기록: ${CODEX_DIR}${fs.existsSync(CODEX_DIR) ? '' : ' (없음 — Codex 를 안 쓰면 그냥 넘어가요)'}`);
  console.log(`   층 수: ${new Set([...sessions.values()].map(s => s.proj)).size}  (끄려면 Ctrl+C)\n`);
  if (!process.argv.includes('--no-open')) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => { });
  }
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`포트 ${PORT}이(가) 이미 쓰이고 있어요. 다른 포트로: PORT=4778 node server.js`);
  else console.error(e);
  process.exit(1);
});
