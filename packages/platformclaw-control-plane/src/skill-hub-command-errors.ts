import { SkillHubServiceError } from "./skill-hub-service-support.js";

const koreanGuidance = new Map([
  ["skill-hub-command-usage", "명령어 사용법을 확인한 뒤 다시 입력해 주세요."],
  ["skill-hub-command-page", "페이지는 1부터 25까지 입력해 주세요. 예: /skillhub list 1"],
  ["skill-hub-command-unknown", "사용할 수 있는 명령어를 /skillhub help에서 확인해 주세요."],
  [
    "skill-hub-workspace-skill-not-found",
    "현재 작업 공간에 해당 스킬이 없습니다. /skillhub installed에서 이름과 실행 대상을 확인해 주세요.",
  ],
  [
    "skill-hub-command-ambiguous",
    "이름이 같은 스킬이 여러 개입니다. 아래 목록의 스킬 ID를 선택해 주세요.",
  ],
  [
    "skill-hub-command-no-download",
    "아직 다운로드할 수 있는 버전이 없습니다. 웹 Skill Hub에서 버전 상태를 확인해 주세요.",
  ],
  [
    "skill-hub-command-room-publish",
    "공유방에서는 게시할 수 없습니다. 개인 대화나 웹 Skill Hub에서 게시해 주세요.",
  ],
  [
    "skill-hub-command-update",
    "웹 Skill Hub에서 설치된 버전과 로컬 변경 내용을 확인한 뒤 업데이트해 주세요.",
  ],
  [
    "existing-skill-replacement-required",
    "같은 이름의 스킬이 설치되어 있습니다. 웹 Skill Hub에서 변경 내용을 확인하고 교체하거나, /skillhub update <스킬 ID>로 명시적으로 업데이트해 주세요.",
  ],
  [
    "installed-version-unavailable",
    "설치된 스킬의 버전이나 수정 정보를 확인할 수 없습니다. SKILL.md를 확인한 뒤 다시 시도해 주세요.",
  ],
  ["skill-hub-invalid-version", "버전은 1.0.0처럼 올바른 SemVer 형식으로 입력해 주세요."],
  ["skill-hub-invalid-manifest", "SKILL.md의 이름·설명·버전과 YAML 형식을 확인해 주세요."],
  ["skill-hub-invalid-archive", "ZIP 파일의 경로·크기와 SKILL.md를 확인해 주세요."],
  ["skill-hub-version-mismatch", "SKILL.md의 버전과 게시할 버전을 같게 맞춰 주세요."],
  [
    "skill-hub-version-exists",
    "이미 게시된 버전입니다. 변경한 파일은 버전 번호를 올려 게시해 주세요.",
  ],
  [
    "skill-hub-vm-unassigned",
    "할당된 VM이 없습니다. 설정에서 VM을 연결하거나 기본 서버를 선택해 주세요.",
  ],
  ["skill-hub-vm-not-ready", "VM 연결 설정을 완료한 뒤 다시 시도해 주세요."],
  [
    "skill-hub-vm-unavailable",
    "선택한 VM을 사용할 수 없습니다. 설정에서 연결과 인증 정보를 확인해 주세요.",
  ],
  [
    "skill-hub-version-blocked",
    "악성 코드가 확인되어 차단된 버전입니다. 다른 안전한 버전을 선택해 주세요.",
  ],
  [
    "skill-hub-version-unavailable",
    "아직 다운로드할 수 없는 버전입니다. 웹 Skill Hub에서 상태를 확인해 주세요.",
  ],
  [
    "skill-hub-publication-pending",
    "게시 결과를 확인 중입니다. 웹 Skill Hub의 대기 중인 게시에서 원래 요청을 복구하거나 취소해 주세요.",
  ],
  [
    "skill-hub-changed",
    "작업 공간이나 스킬 정보가 변경되었습니다. 현재 실행 대상과 최신 정보를 확인한 뒤 다시 시도해 주세요.",
  ],
]);

/** Localize command guidance without interpreting or discarding server diagnostics. */
export function localizeSkillHubCommandError(error: SkillHubServiceError, locale: "en" | "ko") {
  if (locale === "en") {
    return error;
  }
  const code = typeof error.details?.code === "string" ? error.details.code : "";
  const guidance =
    koreanGuidance.get(code) ??
    (error.statusCode === 401
      ? "직원 계정을 확인할 수 없습니다. 웹에서 로그인한 뒤 다시 시도해 주세요."
      : error.statusCode === 403
        ? "이 작업을 할 권한이 없습니다. 소유자와 공유 범위를 확인해 주세요."
        : error.statusCode === 404
          ? "해당 스킬을 찾을 수 없습니다. /skillhub list에서 스킬 ID와 접근 권한을 확인해 주세요."
          : error.statusCode === 409
            ? "현재 상태가 변경되었거나 확인이 필요합니다. 웹 Skill Hub에서 상태를 확인한 뒤 다시 시도해 주세요."
            : error.statusCode === 400
              ? "입력값과 명령어 사용법을 확인해 주세요. 도움말: /skillhub help"
              : "Skill Hub 작업을 완료할 수 없습니다. 현재 처리 결과를 확인한 뒤 다시 시도하거나 관리자에게 문의해 주세요.");
  return new SkillHubServiceError(`${guidance}\n\n오류 정보: ${error.message}`, error.statusCode, {
    ...error.details,
    diagnostic: error.message,
  });
}
