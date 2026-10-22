#!/usr/bin/env node
// 클로드 오피스 — Antigravity 직원 채용 (훅 설치)
//   node install-agy.js           설치
//   node install-agy.js --remove  제거
// ~/.gemini/config/hooks.json (Antigravity 앱·IDE·CLI 공통 전역 훅 파일) 에 "claude-office" 묶음 하나만 넣고 빼요.
// 다른 훅은 건드리지 않고, 고치기 전에 hooks.json.before-claude-office 로 백업해요.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');

// 앱·IDE·CLI 공통 위치 + CLI 전용 위치 (버전에 따라 CLI 는 자기 위치만 보기도 해서 둘 다 넣음. 같은 신호가 두 번 와도 서버가 걸러냄)
const FILES = [path.join(os.homedir(), '.gemini', 'config', 'hooks.json'), path.join(os.homedir(), '.gemini', 'antigravity-cli', 'hooks.json')];
const HOOK = path.join(__dirname, 'agy-hook.js');
const KEY = 'claude-office';
// PreToolUse · Stop 은 일부러 안 써요 — 그 둘은 답(decision)에 따라 도구를 허락/거절하거나 멈춤을 막을 수 있어서.
const EVENTS = ['SessionStart', 'PreInvocation', 'PostToolUse', 'PostInvocation'];
const remove = process.argv.includes('--remove');

function apply(FILE) {
  let j = {};
  if (fs.existsSync(FILE)) {
    try { j = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
    catch (e) { console.error(`❌ ${FILE} 를 읽을 수 없어요 (JSON 형식 오류). 손대지 않고 끝낼게요.\n   ${e.message}`); return false; }
    if (!fs.existsSync(FILE + '.before-claude-office')) fs.copyFileSync(FILE, FILE + '.before-claude-office');
  } else if (remove) return null;

  if (remove) delete j[KEY];
  else {
    // Mac 앱(Antigravity)은 터미널과 PATH 가 달라서 'node' 를 못 찾을 수 있음 → 지금 쓰는 node 의 진짜 경로를 박아 둠
    const cmd = `"${process.execPath}" "${HOOK}"`;
    // 공식 문서 형식: 도구 훅(PostToolUse)은 { matcher, hooks: [명령] }, 나머지 훅은 [명령] 을 바로 적음
    j[KEY] = { enabled: true };
    for (const e of EVENTS) {
      const h = { type: 'command', command: `${cmd} ${e}`, timeout: 5 };
      j[KEY][e] = e === 'PostToolUse' ? [{ matcher: '.*', hooks: [h] }] : [h];
    }
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(j, null, 2) + '\n');
  return true;
}
const results = FILES.map(f => [f, apply(f)]);
if (!remove) console.log(`   node 경로: ${process.execPath}  (Node 를 새로 깔거나 폴더를 옮기면 이 명령을 다시 실행해 주세요)\n   훅이 불렸는지 확인: ${path.join(__dirname, 'agy-hook.log')}`);
for (const [f, r] of results) console.log(r === null ? `   (없음) ${f}` : r ? `   ${remove ? '🧹 뺐어요' : '✅ 넣었어요'}: ${f}` : `   ❌ 못 고쳤어요: ${f}`);
if (!remove) console.log('✅ Antigravity 직원 채용 완료! Antigravity(앱·agy)를 껐다 켜면 반영돼요. 오피스 서버가 켜져 있어야 출근해요.\n   확인: 앱은 Settings > Customizations > Hooks, agy 는 /hooks 에서 claude-office 가 보이면 성공');
