# Submission Manifest

## Baseline

- prep branch: `submission/hello-ai-2026-prep`
- baseline commit: `dae6d288c6f0d6e543955c13f73a03967b794e6c`
- final branch: 사내에서 `submission/hello-ai-2026-final` 생성
- source attribution: `ATTRIBUTION.md`

## 필수 제출물

| 제출물      | Repository path                | 외부 상태                       | Final 조건                   |
| ----------- | ------------------------------ | ------------------------------- | ---------------------------- |
| 코드 저장소 | repository root                | `IMPLEMENTED_WITH_LIMITATIONS`  | private URL과 접근 권한 확인 |
| HTML 소개서 | `submission/slides/index.html` | `IMPLEMENTED`                   | actual evidence로 갱신       |
| MP4 <= 5분  | `submission/video/`            | `INTERNAL_INTEGRATION_REQUIRED` | `IR-011`                     |
| Markdown    | root docs + `docs/submission/` | `IMPLEMENTED`                   | claim/status final sync      |

## Evidence

| 종류   | Path                                     | 상태                            | 사용                           |
| ------ | ---------------------------------------- | ------------------------------- | ------------------------------ |
| Mock   | `submission/evidence/mock-golden-run/`   | `MOCK_VERIFIED`                 | external deterministic proof   |
| Actual | `submission/evidence/actual-golden-run/` | `INTERNAL_INTEGRATION_REQUIRED` | internal hardware/report proof |

## Verification

```bash
pnpm submission:test:mock
pnpm submission:slides:check
pnpm submission:self-review
pnpm submission:verify:external
```

Final:

```bash
pnpm submission:verify:final
```

## Data policy

원본 공식 메일, 개인 이름·사번·부서·이메일·전화번호·Message-ID, secret, cookie, token, internal hostname과 runtime database를 포함하지 않는다. Mock/Actual을 혼동하지 않는다.
