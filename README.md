# dooray

공공 Dooray(gov-dooray)를 기본으로 하는 Dooray 명령줄 도구입니다. 드라이브 동기화, 프로젝트·업무, 위키,
캘린더, 자원 예약, 메신저, 메일(IMAP/SMTP), 연락처, 활동 스트림까지 Dooray 공식 API가 제공하는 기능을 다룹니다.

```
dooray <명사> <동사> [인자] [옵션]
```

---

## 설치

Node.js 22 이상이 필요합니다.

### 1. npm (권장)

```bash
npm install -g @hkkimlab/dooray-cli
```

### 2. 저장소에서 직접

```bash
git clone https://github.com/hkkimlab/dooray-cli.git
cd dooray-cli
npm ci                                  # prepare 단계에서 dist/ 를 빌드
npm install -g "$(npm pack --silent)"
```

> `npm install -g git+ssh://git@github.com/hkkimlab/dooray-cli.git` 한 줄 설치는 쓰지 마세요.
> npm 11에서는 전역(`-g`) git 설치가 prepare 빌드를 망가뜨립니다(전역 설정이 clone의 의존성 설치로 새어 들어감,
> 2026-10-19 npm 11.16에서 실측). 전역이 아닌 `npm install git+ssh://…`는 정상 동작합니다.

`auth sso`는 TLS 인증서를 검사합니다. 기관 자체 인증서 때문에 막히면 `DOORAY_SSO_INSECURE_TLS=true`로만 끌 수 있습니다.
`auth sso`를 쓰려면 Playwright가 필요합니다. 선택 의존성으로 함께 설치되며, 설치된 Google Chrome이 있으면
그것을 쓰고 없으면 `npx playwright install chromium`으로 받은 Chromium을 씁니다.

---

## 설정

설정 파일은 `~/.config/dooray/config.yaml`(`$XDG_CONFIG_HOME` 반영)입니다. 파일은 권한 600, 폴더는 700으로 저장하며 토큰은 로그·오류·`--debug` 출력에 찍지 않습니다.

```yaml
default_profile: gov
profiles:
  gov:
    token: "..."                       # dooray auth login 으로 저장
    env: gov                           # gov | commercial, 비워 두면 gov
    base_url: ""                       # 지정하면 프리셋 대신 사용 (중계 서버 등)
    file_url: ""
    domain: "<도메인>"                 # https://<도메인>.gov-dooray.com, auth sso 가 처음 물어보고 저장
    drive:
      default_drive_id: "<드라이브 ID>"   # 드라이브 ID 또는 프로젝트 ID
    mail:                              # dooray mail login 으로 저장
      username: <이메일>
      password: "..."
      imap_host: imap.dooray.com       # 기본값 (생략 가능)
      imap_port: 993
      smtp_host: smtp.dooray.com
      smtp_port: 465
hooks:                                 # messenger send --hook <이름>
  alerts: "https://hook.dooray.com/services/..."
```

| env | API | 파일 서버 |
|---|---|---|
| `gov` (기본) | `https://api.gov-dooray.com` | `https://file-api.gov-dooray.com` |
| `commercial` | `https://api.dooray.com` | `https://file-api.dooray.com` |

- 프로필은 `--profile <이름>` 또는 `DOORAY_PROFILE`로 고릅니다. `--env`는 호스트 프리셋만 바꿉니다.
- 값은 파일을 직접 고치거나 `dooray config get/set <키>`로 바꿉니다(`-`를 주면 표준 입력에서 읽음).
- 조회 결과 캐시(프로젝트·태그·워크플로·위키 목록 등)는 `~/.cache/dooray/<프로필>/`에 있고, `dooray cache clear`로 지웁니다.

---

## 공통 옵션과 종료 코드

| 옵션 | 설명 |
|---|---|
| `--profile <이름>` | 설정 프로필 |
| `--env gov\|commercial` | 호스트 프리셋 덮어쓰기 |
| `-o, --format table\|json\|csv` | 출력 형식 (기본 table) |
| `--limit <n>` | 목록 최대 행 수 |
| `--quiet` | 진행 메시지(stderr) 숨김 |
| `--debug` | 요청·응답 줄 출력 (토큰 제외) |
| `-v, --version` | 버전 |

종료 코드: `0` 정상 · `1` 일반 오류 · `2` 사용법 오류(이름 후보가 여럿, 확인 필요 등) · `3` 인증·권한 · `4` 없음 · `5` API·네트워크

- 지우는 명령은 확인을 묻습니다. `-y, --yes`로 건너뛰며, 터미널이 아니면(파이프·cron) `--yes` 없이는 종료 코드 2로 멈춥니다.
- 요청 속도는 Dooray 응답 헤더(`x-ratelimit-*`)에 맞춘 토큰 버킷으로 조절합니다.
- 429는 모든 요청을, 5xx·네트워크 오류는 GET·PUT·DELETE만 최대 3회 다시 보냅니다.
- 날짜에 시간대가 없으면 한국 시간(KST)으로 봅니다. `--to 2026-10-20`처럼 날짜만 주면 그날 끝까지 포함합니다.

### 이름으로 지정하기

| 대상 | 받는 값 |
|---|---|
| 프로젝트 | ID, 코드(`개발팀`) |
| 업무 | 업무 URL, 업무 ID, `프로젝트/번호`(`개발팀/12`), 번호 + `--project` |
| 멤버 | ID, `me`, 이름, 이메일 |
| 태그 / 단계 / 워크플로 / 템플릿 / 멤버 그룹 | ID 또는 이름 (태그는 `그룹:이름`도) |
| 드라이브 | 드라이브 ID, 프로젝트 ID, 드라이브 이름 (`--drive`) |
| 드라이브 파일 | ID 또는 `/폴더/파일` 경로 |
| 위키 | 위키 ID, 프로젝트 ID, 위키 이름 (`--wiki`) |
| 위키 페이지 | 페이지 URL, ID, `/상위/하위` 제목 경로(`--wiki` 필요) |
| 캘린더 / 메신저 대화방 / 자원 분류 | ID 또는 이름(제목) |
| 메일 | UID, Dooray 메일 ID, 메일 URL |

이름이 여러 개와 맞으면 후보를 보여 주고 멈춥니다(종료 코드 2). 업무·위키·메일 URL은 `*.dooray.com`과 `*.gov-dooray.com` 모두 알아듣습니다.

---

## 명령

### auth · config · cache · doctor · completion

| 명령 | 설명 |
|---|---|
| `auth login` | 토큰 저장(숨김 입력 또는 파이프) |
| `auth sso [--id] [--token-name]` | 기관 SSO로 로그인해 토큰 발급·저장 (Dooray 도메인은 처음 실행할 때 묻고 저장) |
| `auth status` | `members/me`로 토큰 확인 |
| `auth list` / `auth remove <프로필>` | 프로필 목록 / 삭제 |
| `config get [키]` / `config set <키> <값>` | 설정 읽기(비밀 값 가림)·쓰기 |
| `cache clear` | 프로필 캐시 삭제 |
| `doctor` | 설정·파일 권한·프로필·API 연결 점검 |
| `completion bash\|zsh\|fish` | 셸 자동완성 스크립트 |

### drive

| 명령 | 설명 |
|---|---|
| `drive drives [--type] [--scope]` | 드라이브 목록 |
| `drive list [폴더]` | 폴더 목록 (기본: 루트) |
| `drive get <파일>` | 메타데이터 |
| `drive download <파일> [-O 경로]` | 내려받기 |
| `drive changes [--since 리비전]` | 변경 내역 (v2) |
| `drive link list <파일>` | 공유 링크 목록 |
| `drive pull <원격폴더> <로컬폴더> [--delete --dry-run --force --yes]` | 원격 → 로컬 동기화 |
| `drive upload <로컬> [--parent]` / `drive update <파일> <로컬>` | 올리기 / 새 버전 올리기 |
| `drive mkdir` · `rename` · `mv` · `cp` · `rm [--permanent]` | 폴더·이름·이동·복사·휴지통(영구 삭제) |
| `drive link create\|get\|update\|delete` | 공유 링크 관리 |
| `drive push <로컬폴더> <원격폴더> [--delete --dry-run --force]` | 로컬 → 원격 동기화 (하위 폴더 포함, `--delete`는 휴지통으로) |

### calendar · reservation

| 명령 | 설명 |
|---|---|
| `calendar list` / `calendar get <캘린더>` / `calendar members <캘린더>` | 캘린더 목록·조회·공유 멤버 |
| `calendar busy <멤버…> [--from --to]` | 바쁜 시간 |
| `calendar event list [--calendar --from --to --post-type --category]` | 일정 목록 (50일 넘으면 나눠 조회) |
| `calendar event get <ID> --calendar` | 일정 조회 |
| `calendar create` · `delete` · `members --member/--group` | 캘린더 만들기·지우기·공유 설정 |
| `calendar event create\|update\|delete` | 일정 만들기·고치기·지우기 (반복·알림·참석자) |
| `reservation resource list` | 자원 분류 목록 |
| `reservation resource reservable [--category]` | 예약 가능한 자원 |
| `reservation resource all` / `resource get <ID>` | 모든 자원 / 자원 조회 — 예약 관리자 권한 필요 |
| `reservation list [--resource --from --to]` / `reservation get <ID>` | 예약 목록·조회 |
| `reservation create` · `update` · `cancel` | 예약하기·고치기·취소 |

### member · project

| 명령 | 설명 |
|---|---|
| `member list --search\|--user-code\|--email` / `member get <멤버>` | 멤버 검색·조회 |
| `project list [--search --type --state]` / `project get` / `project categories` | 프로젝트 목록·조회·분류 |
| `project is-creatable <코드>` | 프로젝트 이름 사용 가능 여부 |
| `project workflow list` · `milestone list` · `tag list` · `template list\|get` | 프로젝트 하위 목록 |
| `project member list\|get` · `member-group list\|get` | 프로젝트 멤버·그룹 |
| `project create` · `update` · `archive` · `activate` | 프로젝트 만들기·고치기·보관·복원 |
| `project milestone create\|update\|delete` · `workflow create\|update\|delete` | 단계·워크플로 관리 |
| `project tag create` · `tag group` · `member add\|remove` | 태그·태그 그룹·멤버 관리 |
| `project template create\|update\|delete` | 업무 템플릿 관리 |
| `project hook create` · `wiki-hook create` · `email create\|get` | 웹훅·위키 웹훅·이메일 주소 |

### post (= task)

| 명령 | 설명 |
|---|---|
| `post list [프로젝트] [--to me --from --cc --tag --status --workflow --milestone --unassigned --parent --created --updated --due --order]` | 업무 목록 |
| `post search <프로젝트> <검색어>` | 제목 검색 |
| `post get <업무>` | 업무 조회 |
| `post comment list\|latest\|get <업무>` · `post file list <업무>` | 댓글·첨부 조회 |
| `post create [프로젝트]` | 만들기 (담당자·그룹·마감·태그·템플릿·임시저장 `--draft`·멘션·업무 링크·`--dry-run`) |
| `post update <업무>` | 고치기 (안 준 값은 유지, `--editor`) |
| `post replace <업무> --old --new [--all --dry-run]` | 본문 일부만 바꾸기 |
| `post done` · `reopen` · `workflow [--member]` · `move` · `parent` | 상태·이동·상위 업무 |
| `post comment add [--file]` · `update` · `delete` | 댓글 쓰기(첨부)·고치기·지우기 |
| `post file upload\|download\|download-all\|delete` | 첨부 관리 |

### wiki

| 명령 | 설명 |
|---|---|
| `wiki list` / `wiki tree <위키> [--depth]` | 위키 목록 / 페이지 트리 |
| `wiki page list --wiki [--parent]` / `wiki page get <페이지>` | 페이지 목록·조회 |
| `wiki page referrers` · `links` · `comment list\|get` · `file list\|download` | 참조자·공유 링크·댓글·첨부 조회 |
| `wiki file download <위키> <첨부ID>` | 위키 첨부 내려받기 |
| `wiki page create` · `update` (제목·본문, 참조자 보존) | 페이지 만들기·고치기 |
| `wiki page replace` · `move` · `delete` | 본문 일부 바꾸기·이동·삭제 |
| `wiki page referrers --set` · `comment add\|update\|delete` · `file upload\|delete` · `wiki file upload` | 쓰기 명령 |

### messenger · mail · 기타

| 명령 | 설명 |
|---|---|
| `messenger channel list [--type --search --all]` | 대화방 목록 |
| `messenger logs <대화방> [-n]` | 최신 메시지 n개 읽기 (기본 20, 비공개 API) |
| `messenger logs <대화방> -n <1000 초과>` · `--all` | 1000개씩 거슬러 이어 받기 / 처음 메시지까지 |
| `messenger logs <대화방> --since --until [-n]` | 보낸 시각 범위 (KST, 양 끝 포함, CLI가 거름) |
| `messenger logs <대화방> --count-only [--all \| --since --until]` | 개수만: 단독은 최신 seq(상한), 범위·`--all`은 정확한 개수와 type별 개수 |
| `messenger send [텍스트] --to\|--channel\|--hook [--stdin]` | 보내기 (1:1·대화방·웹훅) |
| `messenger thread` · `reply` · `edit` · `delete` | 스레드·답장·고치기·지우기 |
| `messenger channel create\|join\|leave` | 대화방 만들기·참여·나가기 |
| `mail login` / `mail logout` | 메일 계정 저장·삭제 |
| `mail list\|get` · `mail send` · `mail reply [--all]` | 메일 읽기·보내기·답장 |
| `stream list [--unread --all]` | 활동 피드 (최근 2주) |
| `contact list\|get\|search` | 연락처 |
| `incoming-hook create\|get\|delete` | 수신 웹훅(봇) 관리 |

---

## drive pull/push 규칙

- 크기가 같으면 받지(올리지) 않습니다. `--force`는 항상 전송합니다.
- 원격 폴더 구조를 그대로 받습니다. 특정 폴더 이름에 대한 규칙은 없습니다.
- `pull --delete`는 원격에 없는 로컬 파일과 빈 폴더를 지웁니다. 실행 전에 확인을 묻습니다(`--yes`로 건너뜀, cron에서는 `--yes` 필요).
- `push`는 하위 폴더까지 올리고 `.`으로 시작하는 파일·폴더(`.DS_Store`, `.git` 등)는 건너뜁니다.
  `--delete`는 원격에만 있는 항목을 휴지통으로 옮기며 확인을 묻습니다.

## messenger logs 규칙

- 공개 문서에 없는 `GET /messenger/v1/channels/{id}/logs`를 씁니다. 한 번에 최대 1000개, 최신 메시지부터 옵니다.
  더 오래된 메시지는 `logId`(받은 것 중 가장 오래된 메시지)로 이어 받고, 응답의 `hasMore`가 `false`가 되면 멈춥니다.
  같은 id는 한 번만 남기고, 출력은 오래된 메시지부터입니다.
- 서버는 날짜 조건을 받지 않습니다. `--since`/`--until`은 받은 메시지를 CLI가 `sentAt`으로 거릅니다.
  `--since`보다 오래된 메시지가 나오면 그만 받지만, `--until`보다 최신인 메시지는 받은 뒤 버리므로 `--until`만 주면 처음 메시지까지 받습니다.
  날짜만 준 `--until`은 그날 23:59:59.999까지 포함합니다. 범위를 주면 기본은 범위 전체, `-n`을 함께 주면 범위 안의 최신 n개입니다.
- `seq`는 방의 첫 메시지가 1이고 하나씩 늘지만 지운 메시지 등으로 비는 번호가 있습니다. `--count-only` 단독 결과(최신 seq)는 개수의 상한일 뿐입니다.
- 여러 번 요청하면 받은 개수와 가장 오래된 날짜를 stderr에 보여 줍니다(`--quiet`로 숨김). 스레드 안 답글은 따로 받지 않습니다.

## 라이선스

MIT (`LICENSE`). 일부 코드는 jon890/dooray-cli(MIT)를 참고했습니다(`THIRD_PARTY_NOTICES.md`).
