export const vaultTranslations: Readonly<Record<string, string>> = {
  "platformClaw.vault.documentViews": "문서 보기",
  "platformClaw.vault.graph": "문서 그래프",
  "platformClaw.vault.graphHint":
    "화살표는 문서에 작성된 링크 방향입니다. 링크가 없는 문서도 표시하며, 검색은 링크 유무와 관계없이 동작합니다.",
  "platformClaw.vault.graphEmpty": "아직 문서가 없습니다. 문서를 추가하면 그래프에 표시됩니다.",
  "platformClaw.vault.graphSearch": "제목·경로로 그래프 필터",
  "platformClaw.vault.graphSelect": "문서 선택",
  "platformClaw.vault.graphSelectHint":
    "노드를 선택하면 참조하는 문서와 이 문서를 참조하는 문서를 확인하고 원문을 열 수 있습니다.",
  "platformClaw.vault.graphOpen": "문서 열기",
  "platformClaw.vault.graphControls": "그래프 보기 제어",
  "platformClaw.vault.graphZoomIn": "확대",
  "platformClaw.vault.graphZoomOut": "축소",
  "platformClaw.vault.graphReset": "보기 초기화",
  "platformClaw.vault.graphFit": "화면에 맞추기",
  "platformClaw.vault.graphCounts": "문서 {nodes}개 · 표시된 링크 {edges}개",
  "platformClaw.vault.graphUnresolved": "대상을 찾지 못한 링크 {count}개",
  "platformClaw.vault.graphTruncated":
    "표시 한도를 넘어 일부 링크를 생략했습니다. 선이 보이지 않아도 연결이 있을 수 있습니다. 문서를 열면 전체 관계를 확인할 수 있습니다.",
  "platformClaw.vault.graphNoMatches":
    "일치하는 문서가 없습니다. 필터를 지우면 전체 문서가 보입니다.",
  "platformClaw.vault.graphNoLinks": "이 방향의 링크가 없습니다.",
  "platformClaw.vault.graphNoVisibleLinks":
    "이 방향에 표시된 링크가 없습니다. 생략된 링크가 있을 수 있습니다.",
  "platformClaw.vault.graphRetained":
    "일부 문서의 링크가 최신 상태가 아닙니다. 문서를 선택하면 마지막 검색 버전과 재시도 상태를 볼 수 있습니다.",
  "platformClaw.vault.indexDefinition":
    "색인은 문서를 찾기 위한 검색용 데이터입니다. 다시 만들면 문서 링크도 함께 갱신됩니다.",
  "platformClaw.vault.indexPreserved":
    "원본 문서는 안전합니다. 마지막 정상 검색 데이터와 링크를 유지합니다.",
  "platformClaw.vault.indexMissing":
    "원본 문서는 안전합니다. 아직 생성된 검색 데이터와 링크가 없습니다. 원문을 열어 읽을 수 있습니다.",
  "platformClaw.vault.indexDetails": "검색 버전·재시도 상세",
  "platformClaw.vault.indexRetry":
    "자동으로 재시도합니다. Editor 또는 Owner는 검색·링크 다시 만들기로 바로 재시도할 수 있습니다.",
  "platformClaw.vault.namePlaceholder": "프로젝트 또는 기술 주제",

  "platformClaw.vault.createHint": "생성하면 Owner가 되며 다음 턴부터 연결됩니다.",
  "platformClaw.vault.createdNotice":
    "볼트를 만들고 연결했습니다. 문서를 추가하거나 멤버를 초대하세요.",
  "platformClaw.vault.exportAllowed": "볼트 전체 다운로드 허용",
  "platformClaw.vault.exportNotAllowed": "볼트 전체 다운로드 불가",
  "platformClaw.vault.catalogHint":
    "프로젝트 지식을 연결하면 AI가 참고합니다. 문서와 접근 권한도 여기서 관리하세요.",
  "platformClaw.vault.mine": "내 볼트",
  "platformClaw.vault.discover": "볼트 찾기",
  "platformClaw.vault.catalogTabs": "메모리 허브 보기",
  "platformClaw.vault.findLabel": "접근 가능한 볼트 찾기",
  "platformClaw.vault.findPlaceholder": "볼트 이름이나 주제로 찾기",
  "platformClaw.vault.nextTurnHint":
    "연결·해제는 다음 턴부터 반영됩니다. 기존 대화에 들어온 정보는 남아 있습니다.",
  "platformClaw.vault.accessibleHint":
    "접근 권한이 있는 볼트만 표시합니다. 추가해도 문서를 복사하거나 이동하지 않습니다.",
  "platformClaw.vault.alwaysOn": "항상 사용",
  "platformClaw.vault.personalTitle": "내 개인 지식",
  "platformClaw.vault.personalHint":
    "개인 메모리와 Personal Wiki는 비공개입니다. 공유하려면 직접 사본을 게시하세요.",
  "platformClaw.vault.privateLabel": "나만 접근",
  "platformClaw.vault.openPersonal": "Personal Wiki 열기",
  "platformClaw.vault.aiOn": "AI 참고 중",
  "platformClaw.vault.notConnected": "연결 안 됨",
  "platformClaw.vault.sharedHint": "볼트 멤버와 공유하는 프로젝트 지식입니다.",
  "platformClaw.vault.documentCount": "문서 {count}개",
  "platformClaw.vault.view": "볼트 열기",
  "platformClaw.vault.connect": "내 볼트에 추가",
  "platformClaw.vault.disconnect": "연결 해제",
  "platformClaw.vault.noMatches": "일치하는 볼트가 없습니다. 다른 이름이나 주제로 찾아보세요.",
  "platformClaw.vault.noConnected": "프로젝트 볼트를 추가하면 AI가 해당 지식을 참고할 수 있습니다.",
  "platformClaw.vault.backToVaults": "내 볼트로",
  "platformClaw.vault.connectedNotice": "연결했습니다. 다음 턴부터 AI가 이 볼트를 참고합니다.",
  "platformClaw.vault.disconnectedNotice":
    "다음 턴부터 연결이 해제됩니다. 원본 문서·접근 권한과 기존 대화 내용은 유지됩니다.",
  "platformClaw.vault.importedNotice":
    "새 볼트로 가져와 연결했습니다. 다음 턴부터 AI가 참고합니다.",
  "platformClaw.vault.chooseZip": "ZIP 파일 선택",
  "platformClaw.vault.closeDialog": "대화상자 닫기",
  "platformClaw.vault.managedTitle": "조직 지식",
  "platformClaw.vault.openManaged": "Organization Memory 열기",
  "platformClaw.vault.searchDocuments": "문서 내용 검색",
  "platformClaw.vault.connectedScope": "Personal + 연결한 볼트",
  "platformClaw.vault.invalidUtf8":
    "Markdown은 올바른 UTF-8이어야 합니다. 원본을 UTF-8로 저장한 뒤 다시 업로드하세요.",
  "platformClaw.vault.secureContext":
    "게시하려면 HTTPS 또는 localhost 보안 연결이 필요합니다. 보안 주소에서 원본을 다시 확인하세요.",
  "platformClaw.vault.retainedIndex":
    "검색 색인 갱신에 실패했습니다. 마지막 정상 색인 버전을 표시합니다.",
  "platformClaw.vault.searchUnavailable":
    "Shared·Managed 볼트 검색을 일시적으로 사용할 수 없습니다. 결과가 누락될 수 있으니 다시 검색하세요.",
  "platformClaw.vault.downloadAttachment": "첨부파일 다운로드",
  "platformClaw.vault.title": "메모리 허브",
  "platformClaw.vault.intro":
    "Personal은 개인 전용, Shared는 프로젝트 공유, Managed는 조직 권한 기반 지식입니다.",
  "platformClaw.vault.private": "Personal 내용은 직접 사본을 게시하기 전까지 공유되지 않습니다.",
  "platformClaw.vault.managed":
    "Managed 지식은 기존 Organization Memory의 승인·접근 규칙을 유지합니다.",
  "platformClaw.vault.shared": "공유 · Shared",
  "platformClaw.vault.typePersonal": "개인 · Personal",
  "platformClaw.vault.typeManaged": "조직 관리 · Managed",
  "platformClaw.vault.new": "공유 볼트 만들기",
  "platformClaw.vault.name": "볼트 이름",
  "platformClaw.vault.description": "설명",
  "platformClaw.vault.create": "볼트 생성",
  "platformClaw.vault.select": "볼트 열기",
  "platformClaw.vault.choose": "공유 볼트 선택",
  "platformClaw.vault.empty":
    "공유 볼트가 없습니다. 새로 만들거나 Owner에게 멤버 추가를 요청하세요.",
  "platformClaw.vault.unavailable":
    "메모리 허브를 사용할 수 없습니다. 볼트를 지원하는 게이트웨이에 연결하세요.",
  "platformClaw.vault.loading": "볼트 불러오는 중…",
  "platformClaw.vault.refresh": "새로 고침",
  "platformClaw.vault.import": "ZIP을 새 볼트로 가져오기",
  "platformClaw.vault.importHint":
    "PlatformClaw에서 내보낸 볼트 ZIP만 지원합니다. 일반 문서 압축파일은 지원하지 않습니다. 기존 볼트에 합치지 않고 새 공유 볼트로 만듭니다. 멤버는 자동 초대하지 않으며 검색·링크는 다시 생성합니다.",
  "platformClaw.vault.export": "볼트 전체 ZIP 다운로드",
  "platformClaw.vault.exportHint": "볼트 전체 다운로드는 문서 읽기와 별도 권한입니다.",
  "platformClaw.vault.documents": "문서",
  "platformClaw.vault.noDocuments":
    "아직 문서가 없습니다. 지식 추가에서 직접 작성하거나 개인 지식·Markdown을 가져오세요.",
  "platformClaw.vault.newDocument": "문서 작성",
  "platformClaw.vault.uploadMarkdown": "Markdown 업로드",
  "platformClaw.vault.path": "문서 경로",
  "platformClaw.vault.documentTitle": "문서 제목",
  "platformClaw.vault.body": "Markdown 본문",
  "platformClaw.vault.save": "문서 저장",
  "platformClaw.vault.cancel": "취소",
  "platformClaw.vault.edit": "편집 · 이동",
  "platformClaw.vault.download": "Markdown 다운로드",
  "platformClaw.vault.saved": "문서를 저장했습니다. 검색·링크 상태는 문서에서 확인하세요.",
  "platformClaw.vault.members": "멤버 · 권한",
  "platformClaw.vault.account": "직원 계정 ID",
  "platformClaw.vault.role": "역할",
  "platformClaw.vault.reader": "Reader · 읽기",
  "platformClaw.vault.editor": "Editor · 읽기·편집",
  "platformClaw.vault.owner": "Owner · 볼트 관리",
  "platformClaw.vault.allowExport": "볼트 전체 다운로드 허용",
  "platformClaw.vault.setMember": "멤버 권한 저장",
  "platformClaw.vault.removeMember": "멤버 제거",
  "platformClaw.vault.attachments": "첨부파일",
  "platformClaw.vault.uploadAttachment": "첨부파일 업로드",
  "platformClaw.vault.rebuild": "검색·링크 다시 만들기",
  "platformClaw.vault.pending": "검색·링크 갱신 중",
  "platformClaw.vault.ready": "검색 준비 완료",
  "platformClaw.vault.failed": "검색·링크 갱신 실패",
  "platformClaw.vault.indexHint":
    "원본 문서는 안전합니다. 검색용 데이터와 문서 링크를 생성하지 못했습니다. 마지막 정상 색인은 유지하며 자동으로 재시도합니다. 재생성으로 바로 다시 시도할 수도 있습니다.",
  "platformClaw.vault.indexedRevision": "색인된 버전",
  "platformClaw.vault.retryAt": "다음 재시도",
  "platformClaw.vault.links": "링크",
  "platformClaw.vault.backlinks": "역링크 · 영향받는 문서",
  "platformClaw.vault.publish": "공유 볼트에 게시",
  "platformClaw.vault.sourcePath": "Personal Wiki 원본 경로",
  "platformClaw.vault.previewSource": "원본 확인",
  "platformClaw.vault.publishConfirm": "공유 사본 게시",
  "platformClaw.vault.publishHint":
    "볼트 멤버에게 공유할 사본을 확인하세요. 개인 원본은 비공개로 유지됩니다. 이후 수정은 서로 반영되지 않습니다.",
  "platformClaw.vault.published": "사본을 게시했습니다. Personal 원본은 유지됩니다.",
  "platformClaw.vault.searchScope": "검색 범위",
  "platformClaw.vault.allVaults": "접근 가능한 전체 볼트",
  "platformClaw.vault.searchThisVault": "이 볼트만",
  "platformClaw.vault.operationDone": "완료했습니다. 최신 볼트 상태입니다.",
  "platformClaw.vault.tooLarge": "업로드 허용 크기를 초과했습니다.",
  "platformClaw.vault.sourceUnavailable":
    "게시할 수 없는 원본입니다. 버전이 있는 전체 Personal Wiki 문서를 선택하세요.",
  "platformClaw.vault.close": "문서 닫기",
  "platformClaw.vault.addKnowledge": "지식 추가",
  "platformClaw.vault.personalSource": "개인 지식에서 선택",
  "platformClaw.vault.chooseMarkdown": "Markdown 파일 선택",
  "platformClaw.vault.markdownHint":
    "UTF-8 .md 또는 .markdown 파일 1개(최대 1 MB)를 가져옵니다. 내용을 확인·수정한 뒤 저장하세요.",
  "platformClaw.vault.automaticTitle": "Markdown 본문 또는 파일명에서 자동 설정",
  "platformClaw.vault.writeCopy": "내용 편집",
  "platformClaw.vault.previewCopy": "공유할 내용 확인",
  "platformClaw.vault.advancedPath": "고급: 문서 경로",
  "platformClaw.vault.automaticPath": "자동으로 생성",
  "platformClaw.vault.automaticPathHint":
    "비워 두면 겹치지 않는 경로를 자동으로 만듭니다. 폴더를 정리하거나 문서를 이동할 때만 지정하세요.",
  "platformClaw.vault.noEditableVault":
    "편집 가능한 공유 볼트가 없습니다. 메모리 허브에서 새로 만들거나 Owner에게 Editor 권한을 요청하세요.",
  "platformClaw.vault.linkReviewHint":
    "저장 후 대상 볼트 안에서 링크를 연결합니다. 대상이 없는 링크는 문서에 안내되며 본문 검색은 가능합니다.",
  "platformClaw.vault.attachmentHint":
    "PDF 등 첨부파일은 다운로드용입니다. 파일 본문은 검색·그래프에 포함되지 않습니다. 검색할 지식은 Markdown으로 추가하세요.",
  "platformClaw.vault.readerEmpty":
    "아직 문서가 없습니다. Editor 또는 Owner가 이 볼트에 지식을 추가할 수 있습니다.",
  "platformClaw.vault.unresolvedNotice":
    "이 볼트에서 대상을 찾지 못한 링크가 있습니다. 아래 문서 관계에서 확인하세요. 본문 검색은 정상적으로 가능합니다.",
  "platformClaw.vault.relationships": "문서 링크·역참조",
  "platformClaw.vault.documentDetails": "문서 상세 정보",
  "platformClaw.vault.discardTitle": "저장하지 않은 변경을 버릴까요?",
  "platformClaw.vault.discardDescription":
    "수정한 내용이 아직 저장되지 않았습니다. 계속 편집하거나 변경을 버리고 진행하세요.",
  "platformClaw.vault.keepEditing": "계속 편집",
  "platformClaw.vault.discard": "변경 버리기",
  "platformClaw.vault.changeSource": "다른 개인 문서 선택",
  "platformClaw.vault.viewPublished": "공유 사본 열기",
  "platformClaw.vault.searchWithinVault": "이 볼트의 문서 내용 검색",
  "platformClaw.vault.selectedPersonalSource": "선택한 개인 원본",
};
