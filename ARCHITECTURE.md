# PlatformClaw Architecture

PlatformClaw는 여러 사용자의 Personal Agent가 각자의 개인 개발 VM에 접속하고 Board Farm MCP를 사용하도록 격리하는 멀티유저 AI 엔지니어링 플랫폼이다. OpenClaw generic runtime에 enterprise identity, tenant authorization, credential, Knox와 hardware workflow를 명시적 owner boundary로 추가한다. 실선은 현재 코드 또는 Mock contract, 점선은 `INTERNAL_INTEGRATION_REQUIRED`인 사내 연결을 뜻한다.

## 1. System Context

```mermaid
flowchart LR
  U["Engineer"] --> W["PlatformClaw Web"]
  U --> K["Knox"]
  A["Administrator"] --> AU["Admin UI"]
  W --> C["Control Plane"]
  K --> X["Knox plugin"] --> C
  C --> G["OpenClaw Gateway"]
  G --> S["Rootless Sandbox"]
  G --> V["User-owned Development VM"]
  G -. MCP .-> B["Internal Board Farm"]
  B -.-> J["Jira"]
  J -.-> K
```

경로: `packages/platformclaw-control-plane/src/`, `extensions/knox/src/`, `extensions/platformclaw-execution/src/`, `docker/platformclaw-runtime/`. Board Farm/Jira actual 연결은 `IR-001`~`IR-007`.

## 2. Component Architecture

```mermaid
flowchart TB
  subgraph Browser
    L["Login UI"]
    EU["Restricted Employee UI"]
  end
  subgraph Control
    AUTH["BrowserAuthService"]
    STORE["SQLiteControlPlaneStore"]
    PROXY["BrowserGatewayProxy"]
    EXEC["ExecutionHandoffService"]
    BF["Board Farm domain"]
  end
  subgraph Gateway
    AG["Agent · Session · Tool"]
    PE["platformclaw-execution plugin"]
    PM["platformclaw-user-mcp plugin"]
    KN["knox plugin"]
  end
  L --> AUTH --> STORE
  EU --> PROXY --> AG
  PROXY --> EXEC --> PE
  AG --> PM
  KN --> AUTH
  AG --> BF
```

Component 경로:

- Login/UI: `ui/src/platformclaw/`
- Control: `packages/platformclaw-control-plane/src/`
- VM backend: `extensions/platformclaw-execution/src/`
- personal MCP: `extensions/platformclaw-user-mcp/src/`
- Knox: `extensions/knox/src/`
- Board Farm domain: `packages/platformclaw-control-plane/src/board-farm/`

## 3. Personal Request Sequence

```mermaid
sequenceDiagram
  participant U as Engineer
  participant B as Browser BFF
  participant C as Control Plane
  participant G as Gateway
  participant E as Execution Backend
  U->>B: authenticated chat.send
  B->>C: resolve session and owner
  C-->>B: personal agent + target revision
  B->>G: owner-pinned request
  G->>E: run with target snapshot
  E-->>G: tool outcome
  G-->>B: filtered result/event
  B-->>U: visible outcome
```

근거: `browser-gateway-proxy.ts`, `browser-gateway-ownership.ts`, `execution-handoff-service.ts`, `browser-gateway-proxy*.test.ts`.

## 4. Personal Agent Provisioning

```mermaid
stateDiagram-v2
  [*] --> Authenticated
  Authenticated --> Reserved: reservePersonalAgent
  Reserved --> Provisioning
  Provisioning --> Active: Gateway agent + workspace + profile verified
  Provisioning --> Failed: owner conflict or provisioner error
  Failed --> Provisioning: next authenticated retry
  Active --> Active: idempotent refresh
  Active --> Disabled: administrator action
```

근거: `browser-auth-service.ts`, `personal-agent-provisioner.ts`, `restart-reconciler.ts`와 동명 테스트. Workspace/profiling conflict는 overwrite하지 않고 fail closed한다.

## 5. VM Execution

```mermaid
sequenceDiagram
  participant U as Engineer
  participant C as Control Plane
  participant H as Handoff Socket
  participant P as Execution Plugin
  participant V as Personal Development VM
  U->>C: select approved VM
  C->>V: candidate connection probe
  V-->>C: remote home/workspace
  C->>C: revision-checked allocation commit
  P->>H: agentId + signed service request
  H-->>P: target snapshot + one-shot grant
  P->>V: pinned-host-key SSH session
  V-->>P: command result
```

근거: `execution-contracts.ts`, `browser-execution-http.ts`, `execution-handoff-service.ts`, `extensions/platformclaw-execution/src/backend.ts`, `ssh-lease-manager.ts`.

## 6. Sandbox Execution

```mermaid
flowchart LR
  R["Personal or Group Run"] --> P{"Execution policy"}
  P -->|Personal Basic| D["rootless Docker daemon"]
  P -->|Group Room| D
  P -->|Personal assigned VM| V["platformclaw-execution"]
  D --> C["Agent-scoped container"]
  C --> W["Owned Workspace mount"]
  D -. no access .-> H["Host Docker socket"]
```

근거: `docker/platformclaw-runtime/compose.yaml`, `validate-managed-config.mjs`, `scripts/e2e/platformclaw-runtime-docker.sh`. Group은 `assigned_vm`을 선택하지 않는다.

## 7. Knox DM

```mermaid
sequenceDiagram
  participant K as Knox CDEP
  participant P as Knox plugin
  participant C as Control Plane
  participant G as Gateway
  K->>P: signed inbound DM
  P->>C: raw knoxUserId route request
  alt Web-activated user
    C-->>P: personal agent main session + target
    P->>G: accepted inbound
    G-->>P: final outcome
    P-->>K: progress or final
  else unknown user
    C-->>P: login-required
    P-->>K: visible login guidance
  end
```

근거: `extensions/knox/src/inbound.ts`, `routing-client.ts`, `packages/platformclaw-control-plane/src/knox-routing-service.ts`. 실제 CDEP delivery는 `IR-007`.

## 8. Knox Group Room

```mermaid
flowchart LR
  M["Room message"] --> R["KnoxRoutingService"]
  R --> B["room binding by accountId + roomId"]
  B --> A["group-{chatroomId} Agent"]
  A --> S["Agent main session"]
  S --> D["Policy Docker Sandbox"]
  A -. denied .-> PV["Personal VM"]
  A -. denied .-> PC["Personal Credential"]
```

근거: `knox-routing-service.ts`, `knox-room-agent-provisioner.ts`, `knox-routing-service.test.ts`. External sender는 room Agent 호출만 가능하며 personal identity로 승격되지 않는다.

## 9. Board Farm MCP Lease와 Control

```mermaid
stateDiagram-v2
  [*] --> queued: authorized MCP lease request
  queued --> active: resource allocated
  active --> active: heartbeat or bounded renew
  active --> releasing: release
  active --> cancelling: cancel
  active --> expiring: stale or deadline
  releasing --> released: cleanup passed
  cancelling --> cancelled: cleanup passed
  expiring --> expired: cleanup passed
  releasing --> cleanup_failed: cleanup failed
  cancelling --> cleanup_failed: cleanup failed
  expiring --> cleanup_failed: cleanup failed
  cleanup_failed --> released: retryCleanup
  released --> [*]
  cancelled --> [*]
  expired --> [*]
```

Domain 경로는 `packages/platformclaw-control-plane/src/board-farm/contracts.ts`, `service.ts`, `state-machine.ts`, `memory-store.ts`, `mock-adapter.ts`. 이 코드는 completed build result에서 시작하는 deterministic Mock harness이며 실제 MCP lease policy의 source of truth가 아니다. 실제 MCP Tool schema, lease·renew·control·release mapping과 auth는 `IR-001`, `IR-002`; 제출 외부 상태는 `MOCK_VERIFIED`다.

## 10. Hardware Validation

```mermaid
flowchart LR
  P["Personal Agent"] --> VM["User-owned Development VM"]
  VM --> C["Code Change"] --> B["Build Artifact"]
  P --> M["Board Farm MCP"] --> L["Lease Board"]
  B --> D["Deploy Artifact"]
  L --> D
  D --> O["Boot · Control"]
  O --> V["Validation Suite"]
  V --> E["Evidence Bundle"]
  D -. failed .-> E
  O -. failed .-> E
  V -. failed .-> E
```

lease는 build status가 아니라 Board Farm MCP의 resource availability와 owner policy로 결정한다. artifact는 deploy 단계에서 필요하다. Mock adapter는 completed build result를 입력받아 이후 단계별 결과를 보존하지만 이 편의상 순서를 실제 MCP 정책으로 규정하지 않는다. 실제 Build Skill, Board Validation Skill과 board evidence는 `IR-004`, `IR-005`, `IR-009`다.

## 11. Evidence Flow

```mermaid
flowchart TB
  R["Run ID + correlation ID"] --> A["Build result"]
  R --> B["Lease result"]
  R --> C["Deploy/Boot/Validation result"]
  R --> D["Report/Notification result"]
  A --> M["Evidence manifest"]
  B --> M
  C --> M
  D --> M
  M --> MOCK["mock-golden-run / mode: mock"]
  M -. internal .-> ACT["actual-golden-run / sanitized"]
```

경로: `submission/evidence/mock-golden-run/`, `submission/evidence/actual-golden-run/`. Mock는 actual 근거로 승격되지 않는다.

## 12. Jira / Knox Result Flow

```mermaid
sequenceDiagram
  participant W as Workflow
  participant E as Evidence Store
  participant J as Jira Skill
  participant K as Result Notification Skill
  W->>E: finalize evidence references
  W-->>J: report payload + immutable refs
  J-->>W: issue key or failure
  W-->>K: summary + report ref
  K-->>W: delivery id or failure
  W->>E: preserve both terminal outcomes
```

Templates: `submission/internal-templates/global-skills/jira-report/`, `result-notification/`. 실제 구현은 `IR-006`, `IR-007`.

## 13. Failure and Retry

```mermaid
stateDiagram-v2
  [*] --> Running
  Running --> Succeeded
  Running --> Failed
  Running --> Cancelled
  Failed --> Retryable: policy permits
  Failed --> Terminal: non-retryable
  Retryable --> Running: same correlation ID, new attempt
  Running --> Recovery: process restart or stale lease
  Recovery --> Running: authoritative state reconciled
  Recovery --> Terminal: recovery rejected
```

원칙: producer가 authoritative fact를 기록하고, retry는 idempotency key를 재사용하며, 실패 시 기존 evidence를 지우지 않는다. Control recovery 근거는 `restart-reconciler.ts`; Board lifecycle actual proof는 `IR-009`.

## 14. Credential Flow

```mermaid
flowchart LR
  U["Employee browser"] -->|password over authenticated request| C["Control Plane"]
  C -->|AES-256-GCM envelope| DB[("SQLite")]
  G["Gateway plugin"] -->|service identity + agentId| B["One-shot Broker"]
  B -->|single-use grant| P["Execution or MCP requester"]
  P --> T["Assigned VM or approved MCP"]
  C -. never returns .-> U
  DB -. no key .-> G
```

근거: `ssh-credential-crypto.ts`, `ssh-credential-vault.ts`, `ssh-credential-broker.ts`, `mcp-credential-*.ts`, `credential-broker-grants.ts`. Master key는 secret file에 있고 browser/Gateway state/Workspace에 없다.

## 15. Trust Boundary

```mermaid
flowchart TB
  subgraph Public["Public ingress"]
    BR["Employee Browser"]
    KR["Knox relay"]
  end
  subgraph Private["Private service network"]
    CP["Control Plane"]
    GW["Gateway"]
    RD["Rootless Docker"]
  end
  subgraph Personal["Per-user boundary"]
    PA["Personal Agent"]
    PW["Workspace"]
    VM["User-owned Development VM"]
  end
  subgraph Internal["Internal integration"]
    BF["Board Farm"]
    JR["Jira"]
  end
  BR -->|opaque session| CP
  KR -->|HMAC + service token| CP
  CP -->|owner-pinned RPC| GW
  GW --> RD
  GW --> PA --> PW
  PA --> VM
  GW -. contract .-> BF -. evidence .-> JR
```

Employee BFF, admin listener, Gateway service identity, credential socket, Docker socket는 서로 다른 권한이다. 관련 경로: `web-ingress-server.ts`, `gateway-service-identity.ts`, `browser-vm-admin-http.ts`, Compose secret/volume 설정.

## 16. Deployment

```mermaid
flowchart TB
  RP["Reverse Proxy / TLS"] --> CTL["platformclaw-control"]
  CTL --> GW["openclaw-gateway"]
  GW --> DB[("Gateway state")]
  CTL --> CDB[("Control SQLite")]
  GW --> SD["rootless Docker daemon"]
  GW --> CB["credential broker socket"]
  GW --> EX["platformclaw-execution"]
  EX --> VM["Assigned VM"]
  KN["CDEP"] --> RP
  GW -. internal only .-> BF["Board Farm MCP · lease/control"]
```

근거: `docker/platformclaw-runtime/compose.yaml`, `platformclaw-runtime-entrypoint`, `server-main.ts`, `scripts/platformclaw-build.mjs`. Reverse proxy와 internal endpoint 값은 deployment-owned configuration이며 source에 고정하지 않는다.

## Board Farm package 결정

Mock lease lifecycle은 전체 engineering Run의 user/Agent ownership을 검증하기 위해 `packages/platformclaw-control-plane/src/board-farm/`에 둔다. actual Board Farm lease·control은 사내 MCP가 소유하며 Control Plane은 authenticated user/Agent/Run context를 전달하고 결과를 기록한다. exact Tool schema를 모르는 외부 branch에서 Mock interface를 실제 MCP contract로 고정하지 않는다.

대안과 제한은 `docs/submission/13_DECISIONS_AND_TRADEOFFS.md`, 상세 계약은 `docs/submission/06_BOARD_FARM_MCP_CONTRACT.md`에 있다.
