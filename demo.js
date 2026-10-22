#!/usr/bin/env node
// 데모: 가짜 세션 기록을 만들어서 사무실이 움직이는 모습을 미리 보여줌.
// 사용법: node demo.js   (Claude Code 없이도 동작, 실제 기록은 건드리지 않음)
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), { spawn } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-office-demo-'));
const mk = (name) => { const p = path.join(dir, '-Users-me-' + name); fs.mkdirSync(p, { recursive: true }); return p; };
const projA = mk('gagyebu'), projB = mk('pengrumarble'); mk('old-project');
fs.writeFileSync(path.join(dir, '-Users-me-old-project', 'old.jsonl'),
  JSON.stringify({ type: 'user', cwd: '/Users/me/old-project', message: { role: 'user', content: '옛날 프로젝트' } }) + '\n');
const old = Date.now() / 1000 - 5 * 86400; fs.utimesSync(path.join(dir, '-Users-me-old-project', 'old.jsonl'), old, old);

const sid = 'demo-session-1';
const file = path.join(projA, sid + '.jsonl');
const fileB = path.join(projB, 'demo-b.jsonl');
const cwd = '/Users/me/gagyebu';
let n = 0;
const line = (f, o) => fs.appendFileSync(f, JSON.stringify(Object.assign({ cwd: f === file ? cwd : '/Users/me/pengrumarble', sessionId: sid, timestamp: new Date().toISOString() }, o)) + '\n');
const A = (content) => line(file, { type: 'assistant', message: { role: 'assistant', content } });
const U = (content) => line(file, { type: 'user', message: { role: 'user', content } });
const tool = (name, input) => { const id = 'toolu_' + (++n); A([{ type: 'tool_use', id, name, input }]); return id; };
const result = (id, text, err) => U([{ type: 'tool_result', tool_use_id: id, content: text, is_error: !!err }]);
const sub = (agentName, o) => { const d = path.join(projA, sid, 'subagents'); fs.mkdirSync(d, { recursive: true }); line(path.join(d, agentName + '.jsonl'), Object.assign({ isSidechain: true }, o)); };

line(fileB, { type: 'user', message: { role: 'user', content: '보드 칸 효과 정리해줘' } });

const script = [
  () => U('지출 카테고리별 통계 화면 만들어줘'),
  () => A([{ type: 'thinking', thinking: '먼저 지금 구조를 파악하고 통계 화면을 어디에 넣을지 정해야겠다' }]),
  () => { const id = tool('TodoWrite', { todos: [{ content: '기존 코드 구조 파악', status: 'in_progress' }, { content: '통계 계산 함수 작성', status: 'pending' }, { content: '차트 화면 추가', status: 'pending' }, { content: '테스트 실행', status: 'pending' }] }); result(id, 'ok'); },
  () => { const id = tool('Glob', { pattern: 'src/**/*.tsx' }); result(id, 'src/App.tsx\nsrc/List.tsx'); },
  () => { const id = tool('Read', { file_path: '/Users/me/gagyebu/src/App.tsx' }); result(id, '...'); },
  () => { global.ag = tool('Agent', { subagent_type: 'Explore', description: '차트 라이브러리 사용처 찾기', prompt: '프로젝트에서 차트 라이브러리를 쓰는 곳을 찾아줘' }); },
  () => sub('agent-a1', { type: 'user', message: { role: 'user', content: '프로젝트에서 차트 라이브러리를 쓰는 곳을 찾아줘' } }),
  () => sub('agent-a1', { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x1', name: 'Grep', input: { pattern: 'recharts' } }] } }),
  () => { const id = tool('WebSearch', { query: 'recharts 도넛 차트 예제' }); result(id, '...'); },
  () => sub('agent-a1', { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x2', name: 'Read', input: { file_path: '/x/Chart.tsx' } }] } }),
  () => result(global.ag, '차트는 src/Chart.tsx 한 곳에서만 씁니다.'),
  () => { global.pl = tool('Agent', { subagent_type: 'Plan', description: '통계 화면 설계', prompt: '통계 화면 구현 계획을 세워줘' }); },
  () => sub('agent-p1', { type: 'user', message: { role: 'user', content: '통계 화면 구현 계획을 세워줘' } }),
  () => sub('agent-p1', { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'y1', name: 'Read', input: { file_path: '/x/stats.ts' } }] } }),
  () => { const id = tool('Edit', { file_path: '/Users/me/gagyebu/src/stats.ts' }); result(id, 'ok'); },
  () => result(global.pl, '계획: 1) 집계 2) 차트 3) 탭 추가'),
  () => { const id = tool('Write', { file_path: '/Users/me/gagyebu/src/StatsScreen.tsx' }); result(id, 'ok'); },
  () => { const id = tool('Bash', { command: 'npm test' }); result(id, 'FAIL src/stats.test.ts — expected 3 but got 2', true); },
  () => A([{ type: 'thinking', thinking: '테스트가 실패했네. 날짜 경계 처리를 확인해보자' }]),
  () => { const id = tool('Edit', { file_path: '/Users/me/gagyebu/src/stats.ts' }); result(id, 'ok'); },
  () => { const id = tool('Bash', { command: 'npm test' }); result(id, 'PASS'); },
  () => { const id = tool('AskUserQuestion', { questions: [{ question: '차트는 도넛형과 막대형 중 무엇이 좋을까요?' }] }); result(id, '도넛'); },
  () => { const id = tool('Bash', { command: 'git commit -m "통계 화면 추가"' }); result(id, 'ok'); },
  () => A([{ type: 'text', text: '통계 화면을 추가했어요. 카테고리별 도넛 차트와 월별 합계가 보여요.' }]),
];

// ── Codex 도 같은 프로젝트(가계부)에서 일하는 척 ──
const cxDir = path.join(dir, 'codex', 'sessions', '2026', '10', '20');
fs.mkdirSync(cxDir, { recursive: true });
const CXID = '01a15a00-0000-7000-8000-00000000c0de', GID = '01a15a00-0000-7000-8000-00000000a11d';
const cxFile = path.join(cxDir, `rollout-2026-10-20T10-00-00-${CXID}.jsonl`);
const gFile = path.join(cxDir, `rollout-2026-10-20T10-00-05-${GID}.jsonl`);
const cx = (f, type, payload) => fs.appendFileSync(f, JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n');
cx(cxFile, 'session_meta', { id: CXID, cwd, originator: 'Codex Desktop', source: 'vscode' });
cx(gFile, 'session_meta', { id: GID, parent_thread_id: CXID, cwd, thread_source: 'guardian_review', source: { subagent: { other: 'guardian' } } });
const item = (it) => cx(cxFile, 'event_msg', { type: 'item_completed', item: it });
const exec = (cmd) => cx(cxFile, 'response_item', { type: 'custom_tool_call', name: 'exec', input: `const r = await tools.exec_command({cmd:"${cmd}"}); text(r);` });
let cxi = 0;
const cxScript = [
  () => item({ type: 'UserMessage', content: [{ type: 'text', text: '가계부 내역을 CSV로 내보내는 기능 추가해줘' }] }),
  () => item({ type: 'Reasoning', summary_text: ['**내보내기 위치 찾기** 설정 화면에 버튼을 넣는 게 좋겠다'] }),
  () => { exec('rg -n export src'); item({ type: 'CommandExecution', parsed_cmd: [{ type: 'search', cmd: 'rg -n export src' }], exit_code: 0 }); },
  () => { exec('sed -n 1,80p src/Settings.tsx'); item({ type: 'CommandExecution', parsed_cmd: [{ type: 'read', path: 'src/Settings.tsx' }], exit_code: 0 }); },
  () => cx(gFile, 'event_msg', { type: 'task_started' }),
  () => item({ type: 'FileChange', changes: { '/Users/me/gagyebu/src/exportCsv.ts': { type: 'add' } } }),
  () => cx(gFile, 'event_msg', { type: 'task_complete' }),
  () => { exec('npm run build'); },
  () => item({ type: 'CommandExecution', parsed_cmd: [{ type: 'unknown', cmd: 'npm run build' }], exit_code: 1, stderr: "TS2345: Argument of type 'string' is not assignable" }),
  () => item({ type: 'Extension', kind: 'web.search', query: 'CSV 한글 깨짐 엑셀 BOM' }),
  () => item({ type: 'FileChange', changes: { '/Users/me/gagyebu/src/exportCsv.ts': { type: 'update' } } }),
  () => { exec('npm run build'); item({ type: 'CommandExecution', parsed_cmd: [{ type: 'unknown', cmd: 'npm run build' }], exit_code: 0 }); },
  () => item({ type: 'AgentMessage', content: [{ type: 'text', text: 'CSV 내보내기 버튼을 설정 화면에 추가했어요. 엑셀에서 한글이 안 깨지게 BOM도 넣었어요.' }] }),
];

// ── Antigravity 도 같은 프로젝트에서 일하는 척 (훅이 서버로 보내는 신호를 흉내) ──
const AGID = 'demo-antigravity-1', agyWs = ['file:///Users/me/gagyebu'];
const agy = (e, extra) => {
  const body = JSON.stringify(Object.assign({ conversationId: AGID, workspacePaths: agyWs, modelName: 'gemini-3-pro' }, extra || {}));
  const r = require('http').request({ host: '127.0.0.1', port: +process.env.PORT || 4777, method: 'POST', path: '/agy?e=' + e, headers: { 'Content-Type': 'application/json' } }, (res) => res.resume());
  r.on('error', () => { }); r.end(body);
};
const T = (name, args, error) => agy('PostToolUse', { toolCall: { name, args }, error });
let agi = 0;
const agyScript = [
  () => agy('SessionStart'),
  () => agy('PreInvocation', { invocationNum: 1 }),
  () => T('list_dir', { DirectoryPath: '/Users/me/gagyebu/src' }),
  () => T('view_file', { AbsolutePath: '/Users/me/gagyebu/src/Budget.tsx' }),
  () => T('search_web', { Query: '월 예산 진행 바 접근성' }),
  () => T('replace_file_content', { TargetFile: '/Users/me/gagyebu/src/Budget.tsx' }),
  () => T('run_command', { CommandLine: 'npm run lint', Cwd: '/Users/me/gagyebu' }, 'exit code 1: 2 problems'),
  () => T('replace_file_content', { TargetFile: '/Users/me/gagyebu/src/Budget.tsx' }),
  () => T('run_command', { CommandLine: 'npm run lint', Cwd: '/Users/me/gagyebu' }),
  () => agy('PostInvocation', { invocationNum: 1 }),
];

let i = 0;
const timer = setInterval(() => {
  if (i % 2 === 1) { if (agi < agyScript.length) agyScript[agi++](); else if (agi++ > agyScript.length + 10) agi = 1; }
  if (i < script.length) script[i++]();
  else if (i++ > script.length + 12) i = 0; // 잠깐 쉬었다가 반복
  if (i % 2 === 0) { if (cxi < cxScript.length) cxScript[cxi++](); else if (cxi++ > cxScript.length + 8) cxi = 0; }
}, 1600);

const srv = spawn(process.execPath, [path.join(__dirname, 'server.js'), ...process.argv.slice(2)], { stdio: 'inherit', env: Object.assign({}, process.env, { CLAUDE_PROJECTS_DIR: dir, CODEX_SESSIONS_DIR: path.join(dir, 'codex', 'sessions') }) });
const bye = () => { clearInterval(timer); srv.kill(); process.exit(0); };
process.on('SIGINT', bye); process.on('SIGTERM', bye);
console.log('🎬 데모 모드 — 가짜 세션 기록으로 움직입니다. (임시 폴더: ' + dir + ')');
