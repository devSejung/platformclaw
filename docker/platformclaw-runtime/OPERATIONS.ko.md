# PlatformClaw 운영자 위키

이 문서는 Ubuntu 22.04 서버에서 PlatformClaw를 처음 설치하고, 설정을 변경하고,
새 이미지를 배포하고, VM을 할당하는 운영 절차를 한곳에 정리한다. 명령은 Release에서
받은 `compose.yaml`, `platformclaw-compose`, `.env`가 같은 디렉터리에 있다고 가정한다.

> 실제 사내 주소, 계정, 비밀번호, API key는 이 문서나 Git에 기록하지 않는다.

## 먼저 구조 이해하기

운영자가 시작하는 것은 Compose 프로젝트 하나다. 내부적으로 역할이 다른 두 서비스가
실행된다.

| 서비스 | 역할 | 외부 공개 |
| --- | --- | --- |
| `platformclaw-control` | 로그인, 사용자 세션, 관리 UI, DB, Gateway 정책 프록시 | Web 포트만 공개 |
| `openclaw-gateway` | Agent, 모델, 세션, 도구 실행 조정 | 공개하지 않음 |

Agent의 기본 작업은 서비스 계정의 rootless Docker sandbox에서 실행된다. 개인 VM을
선택하면 같은 Agent의 `exec`, `process`, 파일 도구만 SafeConnect SSH를 통해 VM에서
실행된다. Gateway나 사용자별 proxy를 새로 만들지 않는다.

## 1. 처음 설치하기

### 1.1 서비스 계정과 변수 준비

```bash
SERVICE_USER=platformclaw
RUNTIME_UID="$(id -u "$SERVICE_USER")"
RUNTIME_GID="$(id -g "$SERVICE_USER")"

id "$SERVICE_USER"
./platformclaw-compose --service-user "$SERVICE_USER" environment
```

UID와 GID는 같을 필요가 없다. 둘 다 `0`만 아니면 된다. 서비스 계정을 바꾸면 기존
workspace의 소유권도 별도 절차로 이전해야 하므로 처음 정한 계정을 계속 사용한다.

### 1.2 서비스 계정용 rootless Docker 준비

일반 Docker는 Gateway와 Control을 실행하고, 서비스 계정의 rootless Docker는 Agent
sandbox만 실행한다. 회사 서버에서 외부 APT 접근이 안 되면 Ubuntu 의존성과
`docker-ce-rootless-extras` deb를 외부에서 받아 반입한다.

```bash
sudo apt-get install -y uidmap dbus-user-session slirp4netns fuse-overlayfs
sudo apt-get install -y ./docker-ce-rootless-extras_<version>_amd64.deb

grep "^${SERVICE_USER}:" /etc/subuid
grep "^${SERVICE_USER}:" /etc/subgid
```

두 파일에는 서비스 계정용 65,536개 이상의 겹치지 않는 범위가 있어야 한다. 없으면
임의 번호를 넣지 말고 서버 관리자에게 범위를 할당받는다.

```bash
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

확인:

```bash
test -S "/run/user/$RUNTIME_UID/docker.sock" && echo ROOTLESS_SOCKET_OK

sudo -u "$SERVICE_USER" -H env \
  XDG_RUNTIME_DIR="/run/user/$RUNTIME_UID" \
  DOCKER_HOST="unix:///run/user/$RUNTIME_UID/docker.sock" \
  docker info
```

`docker info`의 Server 보안 옵션에 `rootless`가 보여야 한다.

### 1.3 이미지 두 개 로드

메인 이미지는 일반 Docker에, sandbox 이미지는 서비스 계정의 rootless Docker에 각각
로드한다.

```bash
sudo docker load --input platformclaw-<version>.tar

sudo -u "$SERVICE_USER" -H env \
  XDG_RUNTIME_DIR="/run/user/$RUNTIME_UID" \
  DOCKER_HOST="unix:///run/user/$RUNTIME_UID/docker.sock" \
  docker load --input platformclaw-sandbox-<version>.tar
```

확인:

```bash
sudo docker image ls | grep platformclaw

sudo -u "$SERVICE_USER" -H env \
  XDG_RUNTIME_DIR="/run/user/$RUNTIME_UID" \
  DOCKER_HOST="unix:///run/user/$RUNTIME_UID/docker.sock" \
  docker image ls | grep platformclaw-sandbox
```

두 번 로드하는 이유는 같은 이미지를 중복 설치하기 위해서가 아니다. 메인 서비스와
sandbox가 서로 다른 Docker daemon을 사용하기 때문이다.

### 1.4 영구 디렉터리와 secret 준비

```bash
sudo install -d -o "$RUNTIME_UID" -g "$RUNTIME_GID" -m 0700 \
  /var/lib/platformclaw/workspaces
sudo install -d -o root -g root -m 0700 /etc/platformclaw/secrets
```

Release 가이드에 따라 다음 secret을 한 번만 만든다.

- Gateway token
- Gateway service identity
- execution service token
- 초기 관리자 account ID 목록
- SSH credential master key

이미지를 교체할 때 이 파일을 다시 만들지 않는다. 특히 SSH master key를 잃으면 DB에
저장된 AD credential을 복호화할 수 없다.

### 1.5 `.env` 작성

```dotenv
PLATFORMCLAW_IMAGE=platformclaw:<version>
PLATFORMCLAW_SANDBOX_IMAGE=platformclaw-sandbox:<version>
PLATFORMCLAW_PUBLIC_ORIGIN=http://127.0.0.1:19002
PLATFORMCLAW_PUBLIC_PORT=19002
PLATFORMCLAW_EMPLOYEE_AUTH_LOGIN_URL=https://<employee-auth-host>/login
PLATFORMCLAW_TZ=Asia/Seoul

PLATFORMCLAW_GATEWAY_TOKEN_SECRET_FILE=/etc/platformclaw/secrets/gateway-token
PLATFORMCLAW_GATEWAY_SERVICE_IDENTITY_SECRET_FILE=/etc/platformclaw/secrets/gateway-service-identity.pem
PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_SECRET_FILE=/etc/platformclaw/secrets/execution-service-token
PLATFORMCLAW_INITIAL_ADMIN_IDS_SECRET_FILE=/etc/platformclaw/secrets/initial-admin-ids
PLATFORMCLAW_SSH_CREDENTIAL_MASTER_KEY_SECRET_FILE=/etc/platformclaw/secrets/ssh-credential-master-key
```

브라우저에서 사용하는 origin과 `PLATFORMCLAW_PUBLIC_ORIGIN`은 scheme, 호스트, 포트까지
정확히 같아야 한다. 실제 사용자는 HTTPS reverse proxy를 통해 접속해야 한다. Gateway
포트 `18789`는 외부에 열지 않는다.

### 1.6 사내 CA 연결

호스트의 `curl`은 되지만 Web 로그인에서 503이 발생하고 Control 컨테이너에서
`SELF_SIGNED_CERT_IN_CHAIN`이 나오면 이미지가 사내 CA를 신뢰하지 않는 것이다.
`NODE_TLS_REJECT_UNAUTHORIZED=0`은 실제 AD 비밀번호를 중간자 공격에 노출할 수 있으므로
진단할 때만 잠깐 사용하고 운영에는 사용하지 않는다.

사내에서 제공한 Root/Intermediate CA를 PEM 형식으로 설치한다. 여러 인증서가 필요하면
하나의 PEM bundle로 이어 붙인다.

```bash
sudo install -d -o root -g root -m 0755 /etc/platformclaw/certs
sudo install -o root -g root -m 0444 <company-ca.pem> \
  /etc/platformclaw/certs/employee-auth-ca.pem
```

현재 Preview Compose에서는 `platformclaw-control`에 다음 두 항목을 추가한다.

```yaml
services:
  platformclaw-control:
    environment:
      NODE_EXTRA_CA_CERTS: /etc/platformclaw/certs/employee-auth-ca.pem
    volumes:
      - /etc/platformclaw/certs/employee-auth-ca.pem:/etc/platformclaw/certs/employee-auth-ca.pem:ro
```

적용 후 Control을 재생성한다.

```bash
sudo ./platformclaw-compose --service-user "$SERVICE_USER" \
  up -d --wait --force-recreate platformclaw-control

sudo ./platformclaw-compose --service-user "$SERVICE_USER" \
  exec platformclaw-control printenv NODE_EXTRA_CA_CERTS
```

CA 파일이나 환경변수를 바꾼 뒤에는 단순 `restart`가 아니라 컨테이너 재생성이 필요하다.

### 1.7 시작하고 확인

```bash
sudo ./platformclaw-compose --service-user "$SERVICE_USER" config --quiet
sudo ./platformclaw-compose --service-user "$SERVICE_USER" up -d --wait
sudo ./platformclaw-compose --service-user "$SERVICE_USER" ps
curl -fsS http://127.0.0.1:19002/platformclaw/health
```

정상이면 health 응답은 `{"ready":true}`이고 두 서비스가 `healthy`다.

## 2. Gateway에 들어가고 config 설정하기

### 2.1 Gateway shell 열기

```bash
sudo ./platformclaw-compose --service-user "$SERVICE_USER" \
  exec openclaw-gateway bash
```

이 shell은 점검용이다. Gateway 포트를 외부에 공개하거나 Gateway token을 브라우저에
입력하지 않는다. 나가려면 `exit`를 입력한다.

### 2.2 config 위치 확인

컨테이너 안의 활성 config는 다음 경로다.

```text
/var/lib/platformclaw/gateway-home/.openclaw/openclaw.json
```

호스트의 일반 디렉터리가 아니라 Docker named volume에 저장되므로 호스트에서 바로
파일이 보이지 않는 것이 정상이다. 직접 파일을 편집하기보다 OpenClaw CLI를 사용한다.

```bash
sudo ./platformclaw-compose --service-user "$SERVICE_USER" \
  exec openclaw-gateway node /app/openclaw.mjs config file

sudo ./platformclaw-compose --service-user "$SERVICE_USER" \
  exec openclaw-gateway node /app/openclaw.mjs config validate

sudo ./platformclaw-compose --service-user "$SERVICE_USER" \
  exec openclaw-gateway node /app/openclaw.mjs config get agents.defaults.model --json
```

### 2.3 OpenAI-compatible provider 설정

다음 예시는 구조를 보여주기 위한 것이다. 실제 provider 이름, URL, model ID와 context
크기는 사내 API 계약에 맞춘다.

```bash
sudo ./platformclaw-compose --service-user "$SERVICE_USER" exec openclaw-gateway \
  node /app/openclaw.mjs config set models.providers.company \
  '{"baseUrl":"https://<model-api-host>/v1","api":"openai-completions","apiKey":"<API_KEY>","models":[{"id":"<MODEL_ID>","name":"<MODEL_NAME>","input":["text"],"contextWindow":32768,"maxTokens":4096}]}' \
  --strict-json --merge

sudo ./platformclaw-compose --service-user "$SERVICE_USER" exec openclaw-gateway \
  node /app/openclaw.mjs config set agents.defaults.model.primary \
  'company/<MODEL_ID>'
```

API key를 명령행이나 Git에 남기는 방식은 운영용이 아니다. 초기 연결 확인 후에는
OpenClaw SecretRef와 별도 secret mount로 전환한다. 설정 후 검증하고 Gateway를 다시
시작한다.

```bash
sudo ./platformclaw-compose --service-user "$SERVICE_USER" \
  exec openclaw-gateway node /app/openclaw.mjs config validate
sudo ./platformclaw-compose --service-user "$SERVICE_USER" restart openclaw-gateway
sudo ./platformclaw-compose --service-user "$SERVICE_USER" ps
```

PlatformClaw가 관리하는 sandbox backend, bridge network, plugin 설정은 임의로 바꾸지
않는다. 시작 시 managed-policy 검증에 실패하면 Gateway가 의도적으로 기동을 거부한다.

## 3. 저장 위치와 볼륨

| 데이터 | 방식 | 컨테이너 경로 | 백업 |
| --- | --- | --- | --- |
| Gateway config/state | Docker named volume | `/var/lib/platformclaw/gateway-home/.openclaw` | 필요 |
| Control DB/state | Docker named volume | `/var/lib/platformclaw/control` | 필요 |
| 사용자 workspace | 호스트 bind mount | `/var/lib/platformclaw/workspaces` | 필요 |
| credential broker socket | 메모리 tmpfs volume | `/run/platformclaw-credential-broker` | 불필요 |
| 배포 secret | 호스트 파일 | `/etc/platformclaw/secrets` | 별도 보안 백업 |

볼륨 이름과 Docker 관리 위치 확인:

```bash
sudo docker volume ls | grep platformclaw
sudo docker volume inspect platformclaw_platformclaw-gateway-state
sudo docker volume inspect platformclaw_platformclaw-control-state
```

`Mountpoint` 아래 파일을 직접 수정하지 않는다. `docker volume`은 데이터 저장소이고,
컨테이너의 위 경로가 운영자가 사용하는 논리 경로다.

절대 실행하지 말 것:

```bash
sudo ./platformclaw-compose --service-user "$SERVICE_USER" down --volumes
```

이 명령은 Gateway와 Control의 영구 상태를 삭제한다.

## 4. 이미지가 바뀌었을 때 업그레이드하기

### 4.1 먼저 백업

업그레이드 전 다음을 같은 시점 기준으로 보관한다.

- `platformclaw-control-state` volume
- `platformclaw-gateway-state` volume
- `/var/lib/platformclaw/workspaces`
- `/etc/platformclaw/secrets`
- 현재 `.env`와 `compose.yaml`

Control DB와 SSH credential master key는 반드시 한 쌍으로 보관한다.

### 4.2 새 이미지 로드

새 메인 이미지와 sandbox 이미지를 처음 설치 때와 같은 두 daemon에 로드한다. 기존
이미지는 롤백이 끝날 때까지 삭제하지 않는다.

### 4.3 `.env`의 tag만 변경

```dotenv
PLATFORMCLAW_IMAGE=platformclaw:<new-version>
PLATFORMCLAW_SANDBOX_IMAGE=platformclaw-sandbox:<new-version>
```

secret을 다시 만들거나 volume을 지우지 않는다.

새 Release의 `compose.yaml`을 함께 교체할 때는 기존 파일과 먼저 비교한다. 현재 Preview에서
사내 CA block을 직접 추가했다면 새 Compose에도 같은 read-only CA mount와
`NODE_EXTRA_CA_CERTS`가 남아 있는지 확인한다. `NODE_TLS_REJECT_UNAUTHORIZED=0`을 새
배포로 옮기지 않는다.

### 4.4 설정 검증 후 교체

```bash
sudo ./platformclaw-compose --service-user "$SERVICE_USER" config --quiet
sudo ./platformclaw-compose --service-user "$SERVICE_USER" up -d --wait
sudo ./platformclaw-compose --service-user "$SERVICE_USER" ps
curl -fsS http://127.0.0.1:19002/platformclaw/health
```

Compose가 tag 변경을 감지해 필요한 컨테이너만 교체하고 named volume과 workspace는
그대로 연결한다.

### 4.5 롤백

문제가 있으면 `.env`의 두 image tag를 이전 값으로 되돌리고 다시 `up -d --wait`한다.
DB schema migration이 포함된 Release는 해당 Release의 별도 롤백 지침을 먼저 따른다.

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

### 5.2 관리자가 사용 가능한 VM 등록

1. **Development VMs**에서 승인된 endpoint를 선택한다.
2. VM 표시 이름과 실제 target VM 주소를 등록한다.
3. 활성화된 VM은 모든 개인 사용자에게 선택 가능한 목록으로 제공된다. 일반 사용자에게는
   VM 표시 이름만 보여주고 실제 주소와 SafeConnect endpoint는 노출하지 않는다.

SafeConnect endpoint와 target VM 주소는 서로 다르다. SSH는 SafeConnect 호스트와 포트로
접속하지만 username 안에 AD account, Linux account, target VM 주소가 결합된다. 사용자는
관리자가 등록하지 않은 host, port, target VM 주소를 입력할 수 없다.

### 5.3 사용자가 VM과 Linux 계정을 선택

1. 사용자가 Web에 로그인한다.
2. **Work location**을 연다.
3. 관리자가 활성화한 VM 중 하나를 선택한다.
4. Linux account는 로그인 `accountId`로 자동 입력된다. 실제 Linux 계정이 다르면 사용자가
   수정할 수 있다. `.`을 `_`로 바꾼 Agent ID를 Linux account로 사용하지 않는다.
5. AD 비밀번호를 입력하고 **Save after connection test**를 실행한다.
6. 연결 검사가 성공하면 할당을 저장하고 **My development VM**으로 명시적으로 전환한다.

같은 VM의 같은 Linux account는 두 개인 Agent에 동시에 할당할 수 없다. 사용자는 실행
중인 Agent run이 없을 때 다른 VM 또는 Linux account로 변경할 수 있다. 새 연결 검사가
성공해야 기존 할당을 폐기하고 새 할당으로 원자적으로 교체한다.

비밀번호는 Control DB에 AES-256-GCM으로 암호화되고 Gateway에는 저장되지 않는다.
실행 시 `sshpass -d <fd>`의 일회성 파일 descriptor로만 전달된다.

전환은 실행 중인 Agent run이 없을 때 run 사이에서만 가능하다. 대화와 Agent 설정은
유지되지만 기본 workspace와 VM workspace의 파일·패키지·프로세스는 이동하거나
동기화되지 않는다.

### 5.4 실제 SSH 연결 형태

개념적인 연결은 다음과 같다.

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

### 5.6 할당 해제와 VM 사용 중지

- 사용자는 실행 중인 Agent run이 없을 때 VM 사용을 해제하고 **Basic workspace**로
  명시적으로 전환할 수 있다.
- 관리자는 사용자 할당을 강제로 해제할 수 있다. 이 경우 실행 위치 변경이 감사기록과
  사용자 화면에 남는다.
- 할당 해제는 VM의 파일이나 백그라운드 프로세스를 삭제하지 않는다. 같은 환경으로 다시
  연결하면 기존 상태를 재사용할 수 있다.
- VM 제거는 DB 행을 물리 삭제하지 않고 **사용 중지**로 처리한다. 활성 할당이 있으면 먼저
  해제해야 한다.
- SafeConnect endpoint는 연결된 VM이 모두 사용 중지된 뒤에만 사용 중지할 수 있다.
- 사용 중지된 VM과 endpoint는 신규 선택에서 숨기되 감사기록에는 남긴다.

## 6. 자주 쓰는 운영 명령

```bash
# 상태
sudo ./platformclaw-compose --service-user "$SERVICE_USER" ps

# 최근 로그
sudo ./platformclaw-compose --service-user "$SERVICE_USER" \
  logs --tail 200 openclaw-gateway platformclaw-control

# 실시간 로그
sudo ./platformclaw-compose --service-user "$SERVICE_USER" \
  logs -f openclaw-gateway platformclaw-control

# Control만 재생성
sudo ./platformclaw-compose --service-user "$SERVICE_USER" \
  up -d --wait --force-recreate platformclaw-control

# Gateway 재시작
sudo ./platformclaw-compose --service-user "$SERVICE_USER" restart openclaw-gateway

# 중지하되 데이터 보존
sudo ./platformclaw-compose --service-user "$SERVICE_USER" down
```

## 7. 증상별 확인

| 증상 | 먼저 확인할 것 |
| --- | --- |
| Web 로그인 503, auth 서버 로그 없음 | Control 내부 TLS/DNS 연결, 사내 CA |
| `SELF_SIGNED_CERT_IN_CHAIN` | `NODE_EXTRA_CA_CERTS`와 CA mount, Control 재생성 |
| `origin not allowed` | 브라우저 origin과 `PLATFORMCLAW_PUBLIC_ORIGIN` 완전 일치 |
| 이미지 pull을 시도함 | `.env` tag와 두 daemon에 실제 로드된 tag 비교 |
| rootless socket 연결 실패 | 서비스 UID, `/run/user/<uid>/docker.sock`, user systemd 상태 |
| Gateway가 시작 직후 종료 | config validate와 managed sandbox policy 확인 |
| VM 인증 실패 | host-key 승인, 할당, AD 비밀번호 갱신, SafeConnect 연결 검사 |

로그를 공유할 때 AD 비밀번호, API key, token, 직원정보는 제거한다.
