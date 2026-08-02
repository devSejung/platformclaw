# PlatformClaw 운영자 위키

Ubuntu 22.04 서버에서 PlatformClaw를 설치하고, `openclaw.json`을 편집하고,
새 이미지를 배포하는 표준 절차다. Release의 deployment bundle을 서비스 계정으로
푼 디렉터리에서 실행한다.

> 실제 사내 주소, 계정, 비밀번호, API key는 이 문서나 Git에 기록하지 않는다.

## 먼저 구조 이해하기

메인 Gateway와 Control은 호스트의 일반 Docker에서 실행된다. Agent sandbox만 같은
서비스 계정의 rootless Docker에서 실행된다. 두 daemon을 합치지 않는다.

| 서비스                 | 역할                                                  | 외부 공개       |
| ---------------------- | ----------------------------------------------------- | --------------- |
| `platformclaw-control` | 로그인, 사용자 세션, 관리 UI, DB, Gateway 정책 프록시 | Web 포트만 공개 |
| `openclaw-gateway`     | Agent, 모델, 세션, 도구 실행 조정                     | 공개하지 않음   |

Control Web 포트는 VM 외부 접속을 위해 기본적으로 호스트의 모든 인터페이스
(`0.0.0.0`)에 bind된다. 사내 방화벽이나 승인된 reverse proxy로 접근 범위를 제한한다.
Gateway 포트는 계속 외부에 공개하지 않는다.

영구 데이터는 서비스 계정 홈 아래에 있다. 호스트 경로와 컨테이너 경로를 같게 유지해
rootless sandbox가 workspace와 materialized skill을 같은 절대경로로 찾게 한다.

```text
/home/<service-user>/platformclaw/
├── deployment.env
├── deployment.env.previous
├── data/
│   ├── gateway-home/.openclaw/openclaw.json
│   ├── control/platformclaw-control.sqlite
│   └── workspaces/
├── secrets/
├── certs/
└── releases/
```

## 1. 처음 설치하기

### 1.1 rootless Docker 준비

다음 작업만 서버 관리자 권한이 필요하다.

```bash
SERVICE_USER=platformclaw
RUNTIME_UID="$(id -u "$SERVICE_USER")"

sudo apt-get install -y uidmap dbus-user-session slirp4netns fuse-overlayfs
sudo apt-get install -y ./docker-ce-rootless-extras_<version>_amd64.deb

grep "^${SERVICE_USER}:" /etc/subuid
grep "^${SERVICE_USER}:" /etc/subgid

sudo loginctl enable-linger "$SERVICE_USER"
sudo systemctl start "user@${RUNTIME_UID}.service"
sudo -u "$SERVICE_USER" -H env \
  XDG_RUNTIME_DIR="/run/user/$RUNTIME_UID" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$RUNTIME_UID/bus" \
  dockerd-rootless-setuptool.sh install --force
sudo -u "$SERVICE_USER" -H env \
  XDG_RUNTIME_DIR="/run/user/$RUNTIME_UID" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$RUNTIME_UID/bus" \
  systemctl --user enable --now docker
```

`/etc/subuid`와 `/etc/subgid`에는 서비스 계정용 65,536개 이상의 겹치지 않는 범위가
있어야 한다. 임의 번호를 만들지 말고 서버 관리자에게 할당받는다.

### 1.2 반복 sudo 제거

deployment bundle 디렉터리에서 서버 관리자가 한 번 실행한다. 서비스 계정 자체가 sudoer일
필요는 없다.

```bash
sudo ./platformclaw-deploy --service-user platformclaw host-setup
```

이 명령은 한 번만 `sudo usermod`를 호출해 서비스 계정을 `docker` 그룹에 추가하고
CLI context를 `default`로 바꾼다. Docker 그룹은 호스트 root와 동급 권한이므로 이
전용 운영 계정에만 부여한다. 완료 후 로그아웃하고 다시 로그인한다.

확인:

```bash
docker context show
DOCKER_HOST=unix:///var/run/docker.sock docker info
DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock docker info
```

첫 번째는 메인 daemon, 두 번째는 `rootless` 보안 옵션이 보이는 sandbox daemon이다.

### 1.3 홈 레이아웃 생성

```bash
./platformclaw-deploy init
```

`~/platformclaw/deployment.env`가 처음 한 번 생성된다. 다음 값을 실제 환경에 맞춘다.

```dotenv
PLATFORMCLAW_IMAGE=platformclaw:<sha12>
PLATFORMCLAW_SANDBOX_IMAGE=platformclaw-sandbox:<sha12>
PLATFORMCLAW_PUBLIC_ORIGIN=https://<platformclaw-host>
PLATFORMCLAW_PUBLIC_PORT=19002
PLATFORMCLAW_EMPLOYEE_AUTH_LOGIN_URL=https://<employee-auth-host>/login
PLATFORMCLAW_TZ=Asia/Seoul
```

secret 경로는 `~/platformclaw/secrets`를 가리킨다. `init`은 경로만 기록하며, 첫
`up` 또는 image 업데이트가 누락된 secret 파일을 서비스 중지 전에 생성한다. 기존
non-empty secret은 다시 만들지 않는다. 특히 SSH credential master key를 잃으면
Control DB의 저장 credential을 복호화할 수 없다.

`setup`/`up`은 `~/platformclaw/certs/employee-auth-ca.pem`이 없을 때만 Ubuntu CA
bundle로 초기화한다. 사내 TLS
CA가 필요하면 승인된 PEM bundle로 이 파일을 교체한다. Gateway와 Control 모두 같은
파일을 `NODE_EXTRA_CA_CERTS`로 사용한다.

교체 후 두 Node process가 새 CA를 읽도록 적용한다.

```bash
./platformclaw-deploy ca apply
```

### 1.4 이미지 로드

Release의 단일 transfer tar에는 메인 이미지와 sandbox 이미지가 함께 들어 있다.

```bash
sha256sum --check platformclaw-<version>-<sha12>.tar.sha256
./platformclaw-deploy image load platformclaw-<version>-<sha12>.tar
```

스크립트가 같은 tar를 메인 daemon과 rootless sandbox daemon에 각각 로드한다.

### 1.5 기존 설치를 홈 아래로 이전하고 시작

기존 `/var/lib/platformclaw`, `/etc/platformclaw`, Docker named volume 설치만 실행한다.

#### 이전 설치나 migration을 실패한 적이 있을 때

실패 흔적을 신규 설치로 덮지 않는다. 기존 rootful Gateway/Control, named volume,
`/var/lib/platformclaw`, `/etc/platformclaw`, rootless sandbox가 하나라도 남아 있으면
`setup` 대신 아래 legacy migration 순서를 다시 따른다.

```bash
./platformclaw-deploy init
./platformclaw-deploy image load platformclaw-<version>-<sha12>.tar
```

`~/platformclaw/deployment.env`의 main/sandbox image가 방금 로드한 동일한 `<sha12>`
tag를 가리키고 public origin과 employee auth URL이 실제 값인지 확인한 뒤 실행한다.

```bash
sudo ./platformclaw-deploy --service-user platformclaw migrate-home
```

다음 규칙을 지킨다.

- `init`을 먼저 실행한다. `migrate-home`은 기존 `deployment.env`와 로드된 main image를
  요구한다.
- 기존 container, volume, `/var/lib/platformclaw`, `/etc/platformclaw`를 먼저 삭제하지
  않는다. migration이 기존 stack과 실행 중인 sandbox를 정지한다.
- `~/platformclaw`에 이전 시도 파일이 있어도 디렉터리를 통째로 삭제하거나 secret을
  다시 생성하지 않는다. 완료 marker와 일치하는 Gateway/Control 복사는 재실행 시
  유지된다.
- `Refusing migration`, `target is not empty`, `existing secret does not match`,
  `cannot verify existing` 오류가 나오면 중단한다. 해당 경로와 marker를 확인하기 전
  `setup`, 수동 덮어쓰기, secret 재생성을 실행하지 않는다.
- `migrate-home` 성공 메시지와 아래 데이터 경로를 확인한 뒤에만 서비스 계정으로
  `up`한다.

```bash
ls -la ~/platformclaw/data/gateway-home/.openclaw
ls -la ~/platformclaw/data/control
ls -la ~/platformclaw/data/workspaces
ls -la ~/platformclaw/secrets
./platformclaw-deploy up
./platformclaw-deploy status
```

`ls` 결과나 오류를 공유할 때 secret 파일 내용은 출력하지 않는다.

```bash
sudo ./platformclaw-deploy --service-user platformclaw migrate-home
./platformclaw-deploy up
```

이전 동작:

- Gateway와 Control을 중지한다.
- 전용 rootless daemon의 실행 중인 sandbox container를 정지해 workspace 쓰기를 멈춘다.
- 기존 Gateway/Control named volume을 빈 홈 디렉터리로 복사한다.
- 활성 `/var/lib/platformclaw/workspaces`를 우선 복사하고, 없거나 비었을 때만 이전
  workspace named volume을 fallback으로 사용한다.
- `/etc/platformclaw/secrets`의 5개 secret과 기존 사내 CA를 복사한다.
- 기존 volume과 원본 파일은 삭제하지 않는다.
- 대상이 비어 있지 않으면 덮어쓰지 않는다.

정지된 sandbox는 삭제하지 않는다. 새 Gateway가 이후 Agent run에서 필요한 sandbox를 다시
관리한다.

legacy file은 root-only이므로 `migrate-home`만 서버 관리자가 한 번 실행한다. 이 명령은
기존 stack과 sandbox를 정지하고 데이터를 옮기지만 새 stack을 시작하지 않는다. 확인 후
서비스 계정으로 `up`한다. 일상 운영에는 sudo가 필요 없다.

Compose project 이름은 실행 디렉터리와 무관하게 `platformclaw`로 고정된다. 기존 project
이름이 다르면 정확한 이름을 지정해서 volume과 실행 중인 stack을 찾게 한다.

```bash
sudo env PLATFORMCLAW_LEGACY_COMPOSE_PROJECT=<old-project-name> \
  ./platformclaw-deploy --service-user platformclaw migrate-home
```

Gateway/Control state가 발견됐는데 원래 5개 secret 중 하나라도 없으면 migration은 새 key를
만들지 않고 중단한다. migration marker가 남으므로 이후 `up`도 original secret이 완전하기
전에는 시작하지 않는다. durable target이 이미 비어 있지 않아도 추측해서 건너뛰지 않고
중단한다. 특히 기존 Control DB와 다른 SSH credential master key를 섞지 않는다.

새 설치는 legacy 관리자 파일을 조회하지 않으므로 다음 한 명령에 sudo가 필요 없다.

```bash
./platformclaw-deploy setup \
  --main-image platformclaw:<sha12> \
  --sandbox-image platformclaw-sandbox:<sha12> \
  --public-origin https://<platformclaw-host> \
  --employee-auth-login-url https://<employee-auth-host>/login
```

필수값에 `<...>` placeholder가 남으면 secret 생성이나 컨테이너 시작 전에 중단한다.

기존 secret이 없는 새 설치에서는 `setup`이 gateway token, Gateway identity, execution
token, SSH credential master key를 안전하게 생성하고 최초 관리자 account ID를 한 번
묻는다. 비대화식 설치는 관리자 ID를 한 줄 이상 담은 파일을 준비해 다음처럼 실행한다.

```bash
PLATFORMCLAW_INITIAL_ADMIN_IDS_SOURCE=/secure/path/initial-admin-ids \
  ./platformclaw-deploy setup \
    --main-image platformclaw:<sha12> \
    --sandbox-image platformclaw-sandbox:<sha12> \
    --public-origin https://<platformclaw-host> \
    --employee-auth-login-url https://<employee-auth-host>/login
```

정상이면 Gateway와 Control이 `healthy`이고 다음 요청이 성공한다.

```bash
curl -fsS http://127.0.0.1:19002/platformclaw/health
```

## 2. OpenClaw config 설정

### 2.1 호스트에서 직접 편집

활성 config 경로 확인:

```bash
./platformclaw-deploy config path
```

기본 경로:

```text
/home/platformclaw/platformclaw/data/gateway-home/.openclaw/openclaw.json
```

안전 편집:

```bash
EDITOR=nano ./platformclaw-deploy config edit
```

스크립트가 timestamp backup을 만든 뒤 편집기를 열고 `config validate`를 실행한다.
검증 성공 때만 Gateway를 재시작한다. 실패하면 원본 backup 경로를 출력한다.

### 2.2 Gateway 컨테이너에서 편집

config 디렉터리에서 바로 shell을 연다.

```bash
./platformclaw-deploy config shell
nano openclaw.json
exit
./platformclaw-deploy config apply
```

일반 Gateway shell:

```bash
./platformclaw-deploy shell
```

### 2.3 CLI로 설정

```bash
./platformclaw-compose --service-user platformclaw exec openclaw-gateway \
  node /app/openclaw.mjs config get agents.defaults.model --json

./platformclaw-compose --service-user platformclaw exec openclaw-gateway \
  node /app/openclaw.mjs config set agents.defaults.model.primary \
  'company/<MODEL_ID>'

./platformclaw-deploy config apply
```

`openclaw.json`의 모델, provider, channel, Agent 설정은 직접 관리할 수 있다. 다음
PlatformClaw 보안 정책은 시작 시 검증되며 임의 변경하면 Gateway가 기동을 거부한다.

- managed sandbox backend
- bridge network와 sandbox user
- host Docker socket 차단
- elevated/Gateway-host exec 차단
- 필수 private plugin 활성화

## 3. 저장 위치와 백업

| 데이터                   | 호스트 경로                                  | 컨테이너 경로                         | 백업           |
| ------------------------ | -------------------------------------------- | ------------------------------------- | -------------- |
| Gateway config/state     | `~/platformclaw/data/gateway-home/.openclaw` | 동일                                  | 필요           |
| Control DB/state         | `~/platformclaw/data/control`                | 동일                                  | 필요           |
| 사용자 workspace         | `~/platformclaw/data/workspaces`             | 동일                                  | 필요           |
| 배포 secret              | `~/platformclaw/secrets`                     | `/run/secrets/*`                      | 별도 보안 백업 |
| credential broker socket | Docker tmpfs volume                          | `/run/platformclaw-credential-broker` | 불필요         |

Control DB와 SSH credential master key는 같은 시점으로 백업한다. 다음 명령은 실행하지
않는다.

```bash
docker compose down --volumes
```

기존 migration 원본 volume은 새 홈 경로의 백업을 확인한 뒤 별도 변경 절차로 제거한다.

## 4. 이미지 업데이트와 롤백

### 4.1 업데이트

```bash
./platformclaw-deploy image update \
  platformclaw-<version>-<sha12>.tar \
  platformclaw:<sha12> \
  platformclaw-sandbox:<sha12>
```

스크립트가 두 daemon에 이미지를 로드하고 `deployment.env`의 image ref를 바꾼다. 서비스가
정지된 동안 전체 Gateway `.openclaw` 상태를 `~/platformclaw/backups/gateway-state/`에
백업하고, 새 이미지로 `openclaw doctor --fix --yes --non-interactive`를 실행한 뒤 Compose
health를 기다린다. health가 통과하면 기존 Agent sandbox를 모두 제거하여 다음 실행부터
새 sandbox 이미지로 다시 만들게 한다. Doctor, health, sandbox 제거 중 하나라도 실패하면
`deployment.env.previous`와 migration 전 Gateway 상태를 함께 복원한 뒤 이전 이미지로
재기동한다. 이전 이미지와 상태 백업은 rollback을 위해 자동 삭제하지 않는다.

이미 로드된 tag만 바꿀 때:

```bash
./platformclaw-deploy image set \
  platformclaw:<sha12> \
  platformclaw-sandbox:<sha12>
```

수동 롤백:

```bash
./platformclaw-deploy image rollback
```

롤백은 이전 main/sandbox image ref 두 값만 복원한다. 그 뒤 변경한 origin, auth URL,
CA, timezone, secret 경로는 되돌리지 않는다.

성공한 업데이트를 나중에 수동 롤백할 때는 출력된 migration 전 Gateway 상태 백업이
필요할 수 있다. DB schema migration이 포함된 Release는 해당 Release의 별도 롤백 지침을
먼저 따른다.

### 4.2 사용하지 않는 이미지 정리

새 버전이 안정화된 뒤 먼저 삭제 대상을 확인한다. 기본 명령은 아무것도 삭제하지 않는다.

```bash
./platformclaw-deploy image cleanup
```

출력된 목록이 맞으면 명시적으로 적용한다.

```bash
./platformclaw-deploy image cleanup --apply
```

정리 범위는 main daemon의 정확한 `platformclaw` repository와 rootless daemon의 정확한
`platformclaw-sandbox` repository뿐이다. 현재 `deployment.env`가 가리키는 image ID와 다른
container가 참조 중인 image ID는 유지한다. 전역 `docker image prune`이나 강제 삭제는 하지
않는다.

`--apply`는 이전 rollback 이미지도 제거한다. 정리 후 이전 버전으로 롤백하려면 해당 버전의
transfer archive를 다시 `image load`한 뒤 `image rollback`을 실행한다.

## 5. VM과 SafeConnect 관리

PlatformClaw는 VM을 생성하지 않는다. 이미 존재하는 VM의 Linux 계정을 사용자 Agent에
할당하고 SafeConnect endpoint를 통해 SSH 명령을 실행한다.

### 5.1 관리자가 endpoint 등록

1. 관리자 account로 Web 로그인한다.
2. 프로필 메뉴에서 **VM administration**을 연다.
3. **SafeConnect endpoints**에서 표시 이름, SafeConnect 호스트, SSH 포트, AD domain을
   입력하고 endpoint를 추가한다.
4. 서버 관리자에게 SSH host public key와 SHA-256 fingerprint를 별도 채널로 받는다.
5. UI에 algorithm, public key, verified fingerprint를 입력한다.
6. 두 값이 관리자가 받은 값과 정확히 일치할 때만 **Approve host key**를 누른다.

Host-key 승인은 “이 주소의 SSH 서버가 앞으로도 이 공개키를 제시해야 한다”는 pinning이다.
처음 접속해서 관찰한 키를 자동 승인하지 않는다. 키가 달라지면 연결을 차단하고 VM/SafeConnect
관리자에게 변경 여부를 확인한다.

### 5.2 관리자가 VM과 사용자 계정 할당

1. **Development VMs**에서 승인된 endpoint를 선택한다.
2. VM 표시 이름과 실제 target VM 주소를 등록한다.
3. **Employee assignments**에서 개인 Agent, VM, 해당 VM의 Linux account를 선택한다.
4. **Assign VM**을 누른다.

SafeConnect endpoint와 target VM 주소는 서로 다르다. 예를 들어 SSH는 SafeConnect
호스트와 포트로 접속하지만 username 안에 AD account, Linux account, target VM 주소가
결합된다. 사용자는 임의의 host나 Linux account를 입력할 수 없다.

### 5.3 사용자가 AD 비밀번호 등록하고 연결

1. 사용자가 Web에 로그인한다.
2. **Work location**을 연다.
3. 관리자가 할당한 VM과 Linux account를 확인한다.
4. AD 비밀번호를 입력하고 **Save after connection test**를 실행한다.
5. 성공한 뒤 **My development VM**으로 명시적으로 전환한다.

비밀번호는 Control DB에 AES-256-GCM으로 암호화되고 Gateway에는 저장되지 않는다.
실행 시 `sshpass -d <fd>`의 일회성 파일 descriptor로만 전달된다.

전환은 실행 중인 Agent run이 없을 때 run 사이에서만 가능하다. 대화와 Agent 설정은
유지되지만 기본 workspace와 VM workspace의 파일·패키지·프로세스는 이동하거나
동기화되지 않는다.

### 5.4 실제 SSH 연결 형태

```text
ssh -p <safeconnect-port> \
  '<AD-domain>\<AD-account>+<Linux-account>+<target-VM-address>@<safeconnect-host>'
```

인증 방식은 `keyboard-interactive`이고 host-key 검증은 반드시 활성화된다. 운영 코드에서
비밀번호를 명령 인자, 환경변수, 파일에 넣지 않는다. `sshpass -p`, `sshpass -e`, password
file은 금지한다.

### 5.5 장애 처리

- VM 연결 실패 시 기본 workspace로 자동 전환하지 않는다.
- 사용자가 비밀번호를 갱신하거나 명시적으로 **Basic workspace**를 선택한다.
- `Authentication failed`는 비밀번호 오류와 AD 비밀번호 만료를 모두 포함할 수 있다.
- Knox 그룹 Agent는 개인 VM을 사용하지 않고 항상 서버 Docker sandbox를 사용한다.

## 6. 자주 쓰는 운영 명령

```bash
./platformclaw-deploy status
./platformclaw-deploy logs
./platformclaw-deploy shell
./platformclaw-deploy config edit
./platformclaw-deploy config validate
./platformclaw-deploy config apply
./platformclaw-deploy down
./platformclaw-deploy up
```

Docker 확장에서 메인 컨테이너가 안 보이면 context를 확인한다.

```bash
docker context use default
docker ps
```

rootless sandbox 목록만 볼 때:

```bash
DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock" docker ps -a
```

## 7. 증상별 확인

| 증상                                    | 먼저 확인할 것                                           |
| --------------------------------------- | -------------------------------------------------------- |
| Docker 확장에 Gateway/Control이 안 보임 | context가 `default`인지 확인                             |
| sandbox가 `created`에서 멈춤            | Gateway state/workspace의 호스트·컨테이너 절대경로 일치  |
| config 편집 후 Gateway 종료             | `./platformclaw-deploy config validate`, managed policy  |
| Web 로그인 503                          | Control 내부 TLS/DNS 연결, 사내 CA                       |
| `SELF_SIGNED_CERT_IN_CHAIN`             | `NODE_EXTRA_CA_CERTS`와 CA mount, Control 재생성         |
| `origin not allowed`                    | 브라우저 origin과 `PLATFORMCLAW_PUBLIC_ORIGIN` 완전 일치 |
| 이미지 pull 시도                        | 두 daemon에 tag가 로드됐는지 확인                        |
| rootless socket 연결 실패               | `/run/user/<uid>/docker.sock`, user systemd 상태         |
| VM 인증 실패                            | host-key 승인, 할당, AD 비밀번호, SafeConnect 연결 검사  |

로그를 공유할 때 AD 비밀번호, API key, token, 직원정보를 제거한다.
