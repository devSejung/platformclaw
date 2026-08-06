# HELLO AI 제출 Package

이 디렉터리는 최종 제출 산출물과 machine-checkable evidence를 모은다. 제품 source는 기존 `packages/`, `extensions/`, `src/`, `ui/`, `docker/` 경계에 있고 이곳에 복제하지 않는다.

## 제출물

- offline HTML 소개서: `slides/index.html`
- 5분 이내 MP4 준비: `video/`
- claim map: `evaluation-map.yaml`
- 외부 Mock evidence: `evidence/mock-golden-run/`
- 사내 actual evidence 위치: `evidence/actual-golden-run/`
- 사내 integration templates: `internal-templates/`
- internal requirements와 순서: `internal-requirements.yaml`, `INTERNAL_FINALIZATION_CHECKLIST.md`

## 외부 검증

```bash
pnpm submission:verify:external
```

Mock workflow:

```bash
pnpm submission:test:mock
```

## 사내 final

```bash
git switch -c submission/hello-ai-2026-final origin/submission/hello-ai-2026-prep
pnpm submission:verify:external
# IR-001..IR-013 완료 후
pnpm submission:verify:final
```

Mock result는 실제 Board Farm·Jira·Knox 결과가 아니다. actual file은 `actual-golden-run/`에만 저장하고 secret·개인 정보·internal hostname을 제거한다.
