export const vmAdminTranslations: Readonly<Record<string, string>> = {
  "platformClaw.vmAdmin.title": "VM 관리",
  "platformClaw.vmAdmin.intro": "신뢰할 연결, 개발 VM, 사용자 할당을 관리합니다.",
  "platformClaw.vmAdmin.overview": "VM 관리 현황",
  "platformClaw.vmAdmin.enabledHosts": "사용 가능한 개발 VM",
  "platformClaw.vmAdmin.activeAllocations": "현재 사용자 할당",
  "platformClaw.vmAdmin.enabledEndpoints": "사용 가능한 연결",
  "platformClaw.vmAdmin.sections": "VM 관리 항목",
  "platformClaw.vmAdmin.activity": "변경 기록",
  "platformClaw.vmAdmin.enabled": "사용 가능",
  "platformClaw.vmAdmin.disabled": "사용 중지",
  "platformClaw.vmAdmin.pendingApproval": "호스트 키 승인 필요",
  "platformClaw.vmAdmin.hostsHelp":
    "개발 VM 목록을 관리합니다. 사용 가능 표시는 목록에서 선택할 수 있다는 뜻이며, 연결 상태를 뜻하지 않습니다.",
  "platformClaw.vmAdmin.noHosts": "신뢰할 SafeConnect 연결을 준비한 뒤 개발 VM을 추가하세요.",
  "platformClaw.vmAdmin.noEndpoints":
    "SafeConnect 연결을 추가하고 호스트 키를 확인한 뒤 사용하세요.",
  "platformClaw.vmAdmin.noAllocations": "아직 개발 VM을 할당받은 사용자가 없습니다.",
  "platformClaw.vmAdmin.noActivity": "최근 VM 관리 변경 기록이 없습니다.",
  "platformClaw.vmAdmin.noEnabledEndpoint":
    "사용 가능한 SafeConnect 연결이 필요합니다. 연결 탭에서 먼저 준비하세요.",
  "platformClaw.vmAdmin.endpointUnavailable": "SafeConnect 연결을 사용할 수 없습니다.",
  "platformClaw.vmAdmin.chooseEndpoint": "사용 가능한 연결 선택",
  "platformClaw.vmAdmin.optionalEnvironment": "빌드 환경 (선택)",
  "platformClaw.vmAdmin.administration": "관리 서버",
  "platformClaw.vmAdmin.configuration": "설정",
  "platformClaw.vmAdmin.viewProgress": "진행 보기",
  "platformClaw.vmAdmin.backgroundWork": "창을 닫아도 작업은 계속됩니다.",
  "platformClaw.vmAdmin.operationFailed": "작업 내용을 확인해 주세요.",
  "platformClaw.vmAdmin.retryHelp":
    "입력한 내용은 유지됩니다. 오류를 확인한 뒤 다시 시도하거나 창을 닫으세요.",
  "platformClaw.vmAdmin.awaitingApproval": "연결을 확인했습니다. 호스트 키 승인이 필요합니다.",
  "platformClaw.vmAdmin.stageProbe": "SafeConnect 연결을 확인하고 호스트 키를 읽고 있습니다…",
  "platformClaw.vmAdmin.stageSaveEndpoint": "SafeConnect 연결을 저장하고 있습니다…",
  "platformClaw.vmAdmin.stageRecoverEndpoint": "응답이 끊긴 연결이 저장되었는지 확인하고 있습니다…",
  "platformClaw.vmAdmin.stageApproveKey": "확인한 호스트 키를 승인하고 있습니다…",
  "platformClaw.vmAdmin.stageSaveHost": "개발 VM을 저장하고 있습니다…",
  "platformClaw.vmAdmin.stageSaveEnvironment": "이 VM의 빌드 환경을 저장하고 있습니다…",
  "platformClaw.vmAdmin.stageChangeStatus": "요청한 변경을 적용하고 있습니다…",
  "platformClaw.vmAdmin.disableHostFirst": "주소나 연결을 바꾸려면 먼저 이 VM을 사용 중지하세요.",
  "platformClaw.vmAdmin.revokeBeforeEdit":
    "이 VM의 주소나 연결을 바꾸려면 현재 사용자 할당을 먼저 회수하세요.",
  "platformClaw.vmAdmin.revokeBeforeDisable":
    "이 VM을 사용 중지하려면 현재 사용자 할당을 먼저 회수하세요.",
  "platformClaw.vmAdmin.disableEndpointFirst":
    "연결을 수정하고 다시 검사하려면 먼저 사용 중지하세요.",
  "platformClaw.vmAdmin.disableHostsFirst": "이 연결을 사용하는 VM을 먼저 사용 중지하세요.",
  "platformClaw.vmAdmin.confirmDisableEndpoint":
    "{label} 연결을 사용 중지할까요? 이 연결을 통한 새 접속을 사용할 수 없게 됩니다. 다른 연결은 바뀌지 않습니다.",
  "platformClaw.vmAdmin.confirmEnableEndpoint":
    "이미 승인한 호스트 키로 {label} 연결을 다시 사용할까요? 연결 상태를 검사하지는 않습니다.",
  "platformClaw.vmAdmin.confirmDisableHost":
    "{label} VM을 사용 중지할까요? 사용자가 이 VM을 새로 선택할 수 없게 됩니다. 파일은 삭제되지 않습니다.",
  "platformClaw.vmAdmin.confirmEnableHost":
    "사용자가 {label} VM을 선택할 수 있게 할까요? 연결이나 인증정보를 검사하지는 않습니다.",
  "platformClaw.vmAdmin.confirmRevoke":
    "{label} 사용자의 VM 할당을 회수할까요? 먼저 기본 서버로 전환합니다. 실행 중인 작업이 있으면 전환할 수 없습니다. VM 파일은 남습니다.",
  "platformClaw.vmAdmin.close": "닫기",
  "platformClaw.vmAdmin.refresh": "새로고침",
  "platformClaw.vmAdmin.loading": "VM 관리 정보를 불러오는 중…",
  "platformClaw.vmAdmin.requestFailed": "VM 관리 정보를 처리하지 못했습니다.",
  "platformClaw.vmAdmin.saved": "VM 관리 설정을 저장했습니다.",
  "platformClaw.vmAdmin.endpoints": "SafeConnect 연결 지점",
  "platformClaw.vmAdmin.endpointHelp":
    "신뢰할 수 있는 경로로 지문을 확인한 뒤 호스트 키를 승인하세요.",
  "platformClaw.vmAdmin.hosts": "개발 VM",
  "platformClaw.vmAdmin.allocations": "사용자 할당",
  "platformClaw.vmAdmin.allocationHelp":
    "사용자가 활성 VM 중에서 직접 선택합니다. 관리자는 여기서 접근을 회수할 수 있습니다.",
  "platformClaw.vmAdmin.disableEndpoint": "연결 지점 사용 중지",
  "platformClaw.vmAdmin.enableEndpoint": "연결 지점 다시 사용",
  "platformClaw.vmAdmin.disableHost": "VM 사용 중지",
  "platformClaw.vmAdmin.enableHost": "VM 다시 사용",
  "platformClaw.vmAdmin.hostEditRequiresActiveEndpoint":
    "이 VM의 SafeConnect 연결 지점을 먼저 사용 설정하세요.",
  "platformClaw.vmAdmin.revokeAllocation": "할당 회수",
  "platformClaw.vmAdmin.confirmTitle": "변경 확인",
  "platformClaw.vmAdmin.confirm": "확인",
  "platformClaw.vmAdmin.cancel": "취소",
  "platformClaw.vmAdmin.audit": "최근 VM 감사 기록",
  "platformClaw.vmAdmin.label": "이름",
  "platformClaw.vmAdmin.endpointHost": "SafeConnect 호스트",
  "platformClaw.vmAdmin.port": "SSH 포트",
  "platformClaw.vmAdmin.adDomain": "AD 도메인",
  "platformClaw.vmAdmin.createEndpoint": "연결 지점 추가",
  "platformClaw.vmAdmin.probeBeforeSave": "저장 전 연결 검사",
  "platformClaw.vmAdmin.verifyHostKey": "SafeConnect 호스트 키 확인",
  "platformClaw.vmAdmin.hostKeyTargetHelp":
    "이 키는 개발 VM 키가 아니라 SafeConnect SSH 서버의 키입니다. 승인 전 신뢰할 수 있는 경로로 지문을 확인하세요.",
  "platformClaw.vmAdmin.keyCommentHelp":
    "root@server 같은 OpenSSH 코멘트는 참고 정보이며 승인되는 키에는 포함되지 않습니다.",
  "platformClaw.vmAdmin.approveAndSave": "키 승인 및 저장",
  "platformClaw.vmAdmin.editAndVerify": "수정 후 다시 검사",
  "platformClaw.vmAdmin.edit": "수정",
  "platformClaw.vmAdmin.saveChanges": "변경 저장",
  "platformClaw.vmAdmin.endpoint": "연결 지점",
  "platformClaw.vmAdmin.fingerprint": "확인된 지문",
  "platformClaw.vmAdmin.vmLabel": "VM 이름",
  "platformClaw.vmAdmin.targetAddress": "대상 VM 주소",
  "platformClaw.vmAdmin.executionEnvironment": "빌드 환경",
  "platformClaw.vmAdmin.executionEnvironmentHelp":
    "이 VM에서 실행되는 명령에만 적용됩니다. 변경 사항은 새 Agent 실행부터 반영됩니다.",
  "platformClaw.vmAdmin.pathPrepend": "추가 PATH 디렉터리 (한 줄에 하나)",
  "platformClaw.vmAdmin.environmentVariables": "환경변수 (한 줄에 KEY=value 하나)",
  "platformClaw.vmAdmin.environmentVariablesHelp":
    "비밀이 아닌 빌드 설정만 입력하세요. 셸, 로더, OpenClaw, PlatformClaw 예약 변수는 거부됩니다.",
  "platformClaw.vmAdmin.saveEnvironment": "빌드 환경 저장",
  "platformClaw.vmAdmin.createHost": "VM 추가",
};
