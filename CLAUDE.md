# 클로드 오피스 — 작업 안내

Claude Code와 Codex가 남기는 작업 기록을 읽어서, 브라우저 속 미니어처 사무실 캐릭터를 실시간으로 움직이는 개인용 도구.
사용자는 한국어로 대화하고, 화면 문구도 전부 한국어. 설명은 쉬운 말로. 사용자 이름은 `office.json`의 `user`.

## 처음 시작할 때 (가장 먼저)

이 도구는 Claude Code를 처음 써 보는 사람도 쓰게 만든 것이다. 어려운 말(JSON, 경로, 환경 변수 등)은 풀어서 말하고, 한 번에 한 단계씩 안내한다.

**대화를 시작하면 다른 일보다 먼저 `office.json`을 본다.** 아래 중 하나면 **새 사람·새 컴퓨터**로 보고 처음 설정을 돕는다:
- `office.json`이 없거나, `building`·`user`가 비어 있음
- `home`이 지금 컴퓨터의 홈 폴더(`echo ~`)와 다름 → 다른 사람이 쓰던 걸 넘겨받은 것. 예전 이름을 그대로 쓰지 말고 새로 묻는다

처음 설정:
0. `node -v`로 Node.js 18+ 가 있는지 확인. 없으면 [nodejs.org](https://nodejs.org/ko) LTS 설치부터 쉬운 말로 안내.
1. 반갑게 인사하고 **건물 이름**을 물어본다 (예: "우리집 오피스"). 화면 지붕 간판과 브라우저 탭에 나온다고 알려줌.
2. **사용자 이름**(대표실 이름과 업무 일지에 쓸 이름)을 물어본다.
3. `office.json`을 **새로 덮어쓴다**: `{"building": "…", "user": "…", "home": "<지금 홈 폴더>"}`. 서버 재시작 없이 2초 안에 화면에 반영됨.
4. **사용량 표시**를 원하면(허락받고) `~/.claude/settings.json`에 `"statusLine": {"type": "command", "command": "node \"<이 폴더 절대경로>/statusline.js\""}`를 추가. 고치기 전에 `settings.json.before-claude-office`로 백업. 이미 다른 statusLine이 있으면 덮어쓰지 말고 물어볼 것. 추가했으면 Claude Code를 껐다 켜야 보인다고 알려줌.
5. 실행 방법을 짧게 알려준다: 이 폴더에서 `node server.js` → 브라우저가 열림 → **터미널을 하나 더 열어** 아무 프로젝트에서 `claude` 실행. 끌 땐 `Ctrl+C`.

사용자가 Claude 없이 `node server.js`부터 켜도 괜찮다: 서버가 `office.json`이 없으면 브라우저에 **처음 설정 창**을 띄워 위 1~4를 화면에서 끝낸다 (아래 '처음 설정 창').
이미 설정돼 있으면 묻지 않고, 그 이름으로 사용자를 부른다. 이름을 바꾸고 싶다고 하면 `office.json`만 고치거나 화면의 ⚙️ 를 알려준다.

## 파일

| 파일 | 역할 |
|---|---|
| `server.js` | 기록 폴더를 0.25초마다 따라 읽고 이벤트로 바꿔서 `/events`(SSE)로 보냄. 의존성 없음(Node 18+) |
| `office.html` | 화면 전부(HTML+CSS+JS 한 파일). 캔버스에 아이소메트릭 사무실을 그림 |
| `demo.js` | 가짜 기록을 만들어 서버를 띄움 — 화면 확인용. `node demo.js` |
| `README.md` | 사용자용 설명서 |
| `statusline.js` | Claude Code 상태줄. 받은 `rate_limits`(5시간·주간 사용률)를 `usage.json`에 적고 터미널에 한 줄 표시. `~/.claude/settings.json`의 `statusLine`으로 연결 |
| `usage.json` | Claude 사용량(상태줄이 씀). 서버가 Codex 사용량(기록의 `token_count` → `rate_limits`)과 합쳐 snap `usage`로 보냄 → 화면 오른쪽 위 `#usage` |
| `office.json` | 건물 이름(`building`) · 사용자 이름(`user`) · 홈 폴더(`home`). 없으면 '클로드 오피스' · 컴퓨터 계정 이름 + 처음 설정 창. 서버가 snap 마다 읽음. `.gitignore`에 있음 |

실행: `node server.js` (포트 4777, 브라우저 자동 열림). `--no-open`, `PORT=`, `CLAUDE_PROJECTS_DIR=`, `CODEX_SESSIONS_DIR=`, `NO_CODEX=1`.
`office.html`만 고쳤으면 브라우저 새로고침, `server.js`를 고쳤으면 서버 재시작.

## 절대 규칙

- **기록 파일은 읽기만.** `~/.claude/projects`, `~/.codex` 안의 어떤 파일도 쓰거나 지우거나 옮기지 않는다. `~/.codex/auth.json` 등 인증 파일은 열지도 않는다.
- **사용자 컴퓨터의 파일을 지우지 않는다.** 정리가 필요하면 `_to_delete/` 폴더로 옮기고 사용자가 직접 지우게 한다.
- 토큰을 쓰는 기능(API 호출)은 넣지 않는다. 로컬 파일만 읽는 도구라는 게 핵심.
- 서버는 `127.0.0.1`에만 연다.

## 서버 구조 (`server.js`)

- **Claude 기록**: `~/.claude/projects/<인코딩된 폴더>/<세션>.jsonl`, 서브에이전트는 `<세션>/subagents/*.jsonl`. `applyLine()` / `applySub()`가 해석.
- **Codex 기록**: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (`.zst`는 압축된 지난 기록이라 건너뜀). 첫 줄 `session_meta`에 `id`, `cwd`, 하위 에이전트면 `parent_thread_id`.
  - 실시간 이동은 `response_item` 의 `custom_tool_call`(name `exec`, input은 JS 코드 — `cmd:"..."`를 정규식으로 뽑음)
  - 끝난 작업은 `event_msg` → `item_completed` 의 `item.type`: `UserMessage`, `AgentMessage`, `Reasoning`(summary_text), `CommandExecution`(parsed_cmd, exit_code), `FileChange`, `McpToolCall`, `Extension`(웹 검색)
  - 하위 스레드(`thread_source: guardian_review`)는 **검토 요원**(Guardian). 한 명이 머물다 20초 조용하면 퇴근(`codexKidsTick`).
  - 세션 제목은 `~/.codex/session_index.jsonl`의 `thread_name`.
- **Antigravity**: 기록 파일 대신 훅. `agy-hook.js <이벤트>` 가 stdin JSON 을 `POST /agy?e=<이벤트>` 로 넘김(항상 `{}` 출력, 1.5초 안에 종료). 서버 `receiveAgy`(Origin 있으면 403, Host 는 localhost만) → `handleAgy` → `getSession('agy', conversationId)`, `S.agent = 'agy'`, cwd 는 `workspacePaths[0]`(file:// 풀어서). 도구 → 방은 `AGY_ROOM`/`agyRoom()`, 자세히는 `agyDetail()`. 설치는 `install-agy.js`(→ `~/.gemini/config/hooks.json` 의 `claude-office` 키). **`PreToolUse`·`Stop` 훅은 쓰지 말 것** — 답(decision)으로 도구 허락/거절·멈춤 방지가 되어 버림.
- 이벤트 종류(`k`): `tool`(room, tool, detail), `think`, `say`, `error`, `user`, `spawn`, `agentTool`, `agentErr`, `agentDone`, `board`.
- **층 = 작업 폴더(cwd)**. Claude와 Codex의 cwd가 같거나 한쪽이 다른 쪽 안이면 같은 층으로 합침(홈 폴더 수준은 합치지 않음). 층 번호는 이름순.
- 가리기 모드(캡처용): `#privBtn` → `body.priv`, 이름·층/세션 이름·일지·말풍선 등을 `filter: blur`. 새 화면 요소에 개인 내용이 들어가면 `body.priv` 선택자 목록에 추가할 것.
- 층 꾸미기: `layout.deco[proj]` = { theme, cat, fish, flower }. `THEMES`(grass·floor·wall 덧칠), `decoItems()`가 소품을 깊이순 목록에 넣음. 층 정리 창의 '꾸미기' 줄.
- 날씨: `weatherOn(e)`(think → 구름 `target`↑, error → `rainUntil`, wait/agentDone → `sunUntil`) + `drawWeather()`(구름 `CLOUDS`, 비, 해/밤엔 별). 지금 층(scene) 이벤트만.
- 대표님 방문: 층 카드·창문·로비·옥상을 **직접 누르면** `visit(where)`가 대표(`me`) 캐릭터를 엘리베이터에서 내리게 함(사무실은 `scene.me`, 로비·옥상은 그 화면 사람 목록). 다른 화면/층으로 가면 `dropVisitor()`. 자동 따라가기(`follow`)가 켜져 있으면 `followMe()`가 층이 바뀔 때마다 따라감. 대표님이 와 있는 층에선 질문·wait 때 `goUp` 대신 `reportToMe(W)`(대표님 옆으로 와서 보고), 도착하면 올라가 있던 직원 `comeDown`+보고, 떠나면 보고하던 직원 `goUp`.
- 대표실 디오라마: `view`('office'|'ceo'), `setView()`. 대표실은 따로 그린 작은 섬(`CEO` 12×10, `drawCeoRoom`, 가구 `ceoItems`). 기다리는 직원(`ceoWaiting`: floorAlert + waitingList)은 `syncCeo()`가 Actor(`ceo=true`)로 만들어 엘리베이터 → 책상 앞 줄(`ceoSlot`). 이 화면에선 `renderCrew` 대신 `renderCeoCrew`(결재함 카드, `data-goto`). Actor 이름표는 지금 화면 사람만 보임.
- 하루 요약: 서버 `noteDay()`가 오늘 줄에서 방별 도구 횟수 · 고친 파일 · 시킨 일 · 에러를 모음(처음엔 오늘 바뀐 파일을 `scanDayLines`로, 그 뒤엔 live 줄) → 세션마다 `day`. 화면은 로비 '오늘 요약' 탭(`dayData`, `dayReport`, 복사용 `dayMarkdown`).
- 로비 디오라마: `view === 'lobby'`, 섬 `LOBBY` 14×11, `drawLobbyRoom`(간판·층별 안내판·이달의 직원 액자·엘리베이터 2대), 가구 `lobbyItems`, 사람 `lobbyActors`(안내원 `guide` + `lobbyTick()`이 5초마다 층의 active 변화를 보고 쉬다 일 시작 → 출근, 일하다 멈춤 → 퇴근 `lobbyWalk`). Actor `scene`('ceo'|'lobby')이 지금 화면과 같을 때만 이름표 보임. 아래 카드 `renderLobbyCrew`(`data-ltab` → 안내판 탭).
- 옥상정원: `view === 'roof'`, 섬 `ROOF` 13×10, `drawRoof`/`roofItems`/`drawRoofLights`(밤 줄전구). 쉬는 직원 `roofResting()`(active 아님 · waiting 아님 · 30분 안) → `syncRoof()`가 엘리베이터 출입구(`RF.door`)에서 `ROOF_SPOTS`로. RF 카드 `data-rf`.
- 로비 카페: 앞쪽 왼편(원목 바닥 x .6~9, y 7.6~11), 바리스타 `barista`(앞치마 `apron`), 출근 직원 절반이 `CAFE_SPOT`에 들러 커피(`badge = 'coffee'`), `BARISTA` 혼잣말.
- 벽·물건 앞면 글씨는 `wallText(txt, x, y, z, 'y'|'x', font, color)`로 면 기울기에 맞춰 씀 (그냥 `fillText` 쓰면 기울기가 안 맞음).
- 밤 모드: `isNight()`(자동 19~6시 / 항상 밤 / 항상 낮, `localStorage` `office.night`, `#nightBtn`). 밤이면 `#center.night` 하늘 + `drawNight()`가 화면을 어둡게 덮고 방마다 불빛(`busy` 방은 더 밝게).
- 출퇴근 기록부: 서버가 기록 줄의 `timestamp`로 오늘 일한 5분 칸을 모음(`markWork`, 오늘 바뀐 파일은 처음에 `scanToday`로 통째로 훑음) → 세션마다 `work`(0~287 칸 번호)로 보냄. 이번 달 칸도 같이 모아(`S.month`, 이번 달에 바뀐 파일은 시작할 때 통째로 훑음 — 약 300MB에 1초) `month`(분)로 보냄 → 로비 '이달의 직원' 탭(`monthRank`, `starBoard`). 화면은 로비 안내판 '출퇴근 기록부' 탭(`workBook`)에서 층별로 합침.
- 스냅샷(`snap`)은 2초마다, 바뀐 게 있을 때만 보냄.
- 처음 설정 창: snap `setup` = { need(`needSetup`: office.json 없음·이름 빔·home 다름), statusLine('none'|'ours'|'other'|'broken'|'noclaude'), hasClaude, hasCodex }. 화면은 `need`면 `openSetup(true)` 한 번, `#setupBtn`(⚙️)으로 다시 염. 저장은 `POST /setup`(`handleSetup`: Origin·Host·JSON 확인) → office.json, 체크하면 `addStatusLine()`(백업 후 추가, 다른 상태줄 있으면 안 건드림).

## 화면 구조 (`office.html`)

- 디자인 방향: **하늘에 떠 있는 잔디 섬 위의 미니어처 디오라마**. 밝고 귀여운 장난감 느낌, 외곽선 있는 가구, 심즈처럼 낮게 잘린 벽. 흰 배경 SaaS 대시보드처럼 되지 않게 할 것.
- 글꼴: 제목 `Jua`(주아체), 본문 `IBM Plex Sans KR` (Google Fonts).
- 오른쪽 버튼 줄(`#tools`): 확대·축소·전체 · 밤 모드 · ⚙️ 설정 · 가리기.
- 레이아웃: 왼쪽 **건물 단면**(층 카드, 창문 하나 = 세션 하나, 노란 불 = 지금 일하는 중, 청록 줄 = Codex 세션) / 가운데 디오라마 + 아래 **근무표 카드** / 오른쪽 **업무 일지** 타임라인.
- 좌표: 타일 단위(`WORLD` 22×18), `P(x,y,z)`로 아이소 투영. 가구는 `add()`로 등록하고 `x+y` 깊이순 정렬해서 그림.
- 방(`ROOMS`): 자료실(읽기·검색) · 개발실(코드 수정, **Claude·Codex 자리**) · 서버실(명령·git) · 정보검색실(웹·MCP) · 회의실(계획·할 일, 화이트보드) · 휴게실(`rest`, 커피 카운터·소파 — 2분 넘게 쉬면 여기로). 각 층에 사용자 캐릭터(`scene.me`)는 없음 — 사용자는 **대표실**에 있음. 질문(서버 room `boss`)은 엘리베이터 타고 대표실로 올라감(`goUp`: `actor.away`면 안 그림, `W.upstairs`) → 다음 이벤트가 오면 `comeDown`으로 엘리베이터에서 다시 나옴. 말을 마치고 답을 기다릴 때(Claude `stop_reason: end_turn`, Codex `task_complete`/`turn_aborted`)도 서버가 `wait` 이벤트를 보내고 세션에 `waiting`(시각)을 실음 → 대표실로 올라감, 결재함 '💬 답변 대기'(3시간까지). 열린 Claude 세션은 `~/.claude/sessions/<pid>.json`(sessionId, pid)으로 확인(`liveClaude`) — 닫힌 세션은 대기 0. 같은 폴더의 `.key` 파일은 절대 열지 않음. 가운데 가로 복도(`LANE`), 왼쪽 벽에 엘리베이터.
- 자리(`HOME`): Claude = 개발실 앞쪽 주황 의자 책상(전화·명패·머그), Codex = 개발실 왼쪽 청록 명패 책상. 둘 다 책상 **뒤**에 서 있어서 개발실 안에서는 통로(`DEV_AISLE`)로 돌아 들어감(`route()`).
- 장면(`scene`): 한 층 = 한 사무실. `scene.workers`에 지금 보는 세션(primary)과, 같은 층에서 최근 일한 **다른 종류**(Claude·Codex·Antigravity 중 나머지, 종류마다 1명) 세션이 같이 들어감(`syncCompanion`). 종류는 `kindOf(s)`, 이름표 색은 `whoCls(s)`(cx/ag). 각 worker는 자기 서브에이전트(`agents`)를 가짐.
- 캐릭터(`PEOPLE`): claude(주황, ✳, 삐침머리), codex(남색, 헤드셋, ◇), agy(보라, ▲, `float` 둥둥 + `halo` 고리, 개발실 뒷줄 책상), Explore(초록 모자), Plan(보라 안경), general-purpose(파랑), Guardian(노란 옷 모자 = 검토 요원), Helper, me(사용자 = 대표: 여자, 긴 갈색 머리·노란 머리핀·핑크 재킷·남색 치마·속눈썹·핑크 입술 — `long`/`lady`/`pin`/`skirt`).
- 층 정리(`applySnap`, `#tidy` 창): 서버가 나눈 층을 브라우저에서 다시 묶음 — 이름 바꾸기·합치기(`merge`)·세션 옮기기(`moves`)·숨기기. `localStorage`의 `office.layout`, `office.hiddenFloors`에 저장. 층 번호는 정리 후 다시 매김. 이 도구 폴더(서버가 `snap.self`로 알려줌)는 지하 1층(`n = -1`, `fno()`가 `B1`로 표시) **관리실**로 `#base`에 그림. 1층은 **로비**(프로젝트 층은 2F부터): 누르면 가운데에 **로비 안내판**(`#lobbyV`, `renderLobby`) — 층별 현황, 줄 누르면 그 층으로. 층별 직원 이름은 `layout.workers[proj]`, 화면에 쓸 땐 `staff(kind)`. 맨 위 **RF 옥상정원**, 그 아래 **대표실**(`data-ceo`: 누르면 결재함 — 질문·에러 올라온 층 목록, `floorAlert`/`alertInfo`).
- 말풍선 종류: 일반 / think(보라, 고민 중) / error(빨강, 식은땀) / report(초록) / user(노랑).

## 작업할 때

- 화면을 고치면 `node demo.js --no-open`으로 띄워서 확인. 가능하면 스크린샷으로 직접 보고 겹침·잘림 확인.
- 실제 기록 형식이 버전마다 바뀔 수 있음 — 파싱 실패해도 서버가 죽지 않게 `try/catch` 유지.
- 바꾼 기능은 `README.md`에도 반영.
