# PlatformClaw Global Skills 평가 Source

이 디렉터리는 심사자가 PlatformClaw 전용 Global Skill과 Python 구현을 직접 확인하는 Git source root다. `submission/internal-templates/global-skills/`는 작성 참고본과 acceptance contract이며 실제 구현을 두는 곳이 아니다.

## 배치 구조

```text
submission/global-skills/
├─ platformclaw-firmware-build/
│  ├─ SKILL.md
│  ├─ scripts/*.py
│  ├─ references/*
│  └─ tests/*
├─ platformclaw-board-validation/
│  ├─ SKILL.md
│  ├─ scripts/*.py
│  └─ tests/*
├─ platformclaw-jira-report/
│  ├─ SKILL.md
│  ├─ scripts/*.py
│  └─ tests/*
└─ platformclaw-result-notification/
   ├─ SKILL.md
   ├─ scripts/*.py
   └─ tests/*
```

Skill별 dependency가 있으면 해당 Skill directory 안에 재현 가능한 `requirements.txt` 또는 lockfile을 둔다. 공통 Python virtual environment, 사내 절대 경로와 개발자 home path에 의존하지 않는다.

## 제출 규칙

- 실제 `SKILL.md`, Python source와 평가 가능한 test를 함께 넣는다.
- secret, credential, 사내 hostname·URL, 실제 Jira project key, employee/resource 식별자는 넣지 않는다.
- 내부 값은 environment variable 또는 secret-file reference로 받는다.
- evaluator가 사내 연결 없이 실행할 수 있는 sanitized fixture나 dry-run test를 제공한다.
- 실제 source를 추가한 commit에서 `submission/evaluation-map.yaml`과 `submission/internal-requirements.yaml`의 template 경로를 실제 경로로 교체한다.
- runtime 설치 위치는 별도 deployment 책임이다. 이 디렉터리는 평가와 source provenance를 위한 Git 위치다.
