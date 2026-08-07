# PlatformClaw Security

## 공개 저장소 범위

이 저장소에는 PlatformClaw의 공개 가능한 코드와 계약만 둔다. 사내 endpoint, 계정, token, 인증서, 개인 정보, 실제 Workspace 내용, 원본 로그와 runtime database를 커밋하지 않는다.

## Trust Boundary

- 인증된 principal과 Agent, session, Workspace, VM의 소유권을 서버에서 검증한다.
- Personal Agent만 해당 사용자의 개인 개발 VM과 credential을 사용할 수 있다.
- Group Agent는 개인 VM과 개인 credential을 사용할 수 없다.
- UI에서 메뉴를 숨기는 것은 보안 경계가 아니다. request, result, event마다 권한을 다시 검사한다.
- SSH와 MCP credential은 암호화 저장하고, 실행 시점에 제한된 one-shot grant로 전달한다.
- 실제 사내 secret은 배포 환경의 승인된 secret mount로만 주입한다.
- evidence와 영상은 secret, 개인 정보, 사내 hostname을 제거한 뒤 제출한다.

세부 위협 모델과 검증 항목은 [보안과 격리](docs/submission/03_SECURITY_AND_ISOLATION.md)를 따른다.

## 취약점 보고

미패치 취약점, exploit, secret을 공개 issue나 pull request에 올리지 않는다. 저장소의 private vulnerability reporting이 활성화되어 있으면 그 경로를 사용한다. 그렇지 않으면 승인된 사내 보안 채널로 저장소 소유자에게 전달한다.

보고에는 영향을 받은 commit, 재현 절차, 실제 경계 침해와 민감 정보를 제거한 최소 증거를 포함한다. 외부 기반이나 dependency 자체의 취약점은 해당 프로젝트의 보안 경로로 보고하고, PlatformClaw 경계를 통해 재현되는 영향만 이 저장소에서 다룬다.

## 라이선스와 제3자 고지

필수 법적 고지는 [LICENSE](LICENSE)와 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 보존한다. 두 파일의 원문은 제출용 축약 대상으로 보지 않는다.
