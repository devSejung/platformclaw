// These document actions belong to the lazy Wiki view, not the startup locale payload.
export const wikiDocumentTranslations: Readonly<
  Record<"en" | "ko", Readonly<Record<string, string>>>
> = {
  en: {
    "dreaming.wiki.documentActions": "Document actions",
    "dreaming.wiki.edit": "Edit",
    "dreaming.wiki.editNotes": "Edit notes",
    "dreaming.wiki.viewSource": "View source",
    "dreaming.wiki.backToPreview": "Back to preview",
    "dreaming.wiki.write": "Write",
    "dreaming.wiki.preview": "Preview",
    "dreaming.wiki.saved": "Saved. Showing the latest server version.",
    "dreaming.wiki.savedIndexPending":
      "Saved. Search and graph refresh are pending; refresh to retry indexing.",
    "dreaming.wiki.saveReloadFailed":
      "The document was saved, but the latest version could not be reloaded.",
    "dreaming.wiki.sourceManaged":
      "The source content is managed by synchronization. Only Notes are editable.",
    "dreaming.wiki.generatedReadOnly":
      "This generated report is read-only and will be replaced by the next compile.",
    "dreaming.wiki.pageTooLargeReadOnly": "This page is too large for safe browser editing.",
    "dreaming.wiki.sharedVaultReadOnly": "This shared Wiki is read-only here.",
    "dreaming.wiki.discardTitle": "Discard Wiki changes?",
    "dreaming.wiki.discardDescription": "Your unsaved Markdown changes will be lost.",
    "dreaming.wiki.discard": "Discard changes",
  },
  ko: {
    "dreaming.wiki.documentActions": "문서 작업",
    "dreaming.wiki.edit": "편집",
    "dreaming.wiki.editNotes": "Notes 편집",
    "dreaming.wiki.viewSource": "원문 보기",
    "dreaming.wiki.backToPreview": "미리보기로 돌아가기",
    "dreaming.wiki.write": "쓰기",
    "dreaming.wiki.preview": "미리보기",
    "dreaming.wiki.saved": "저장했습니다. 서버의 최신 문서를 표시합니다.",
    "dreaming.wiki.savedIndexPending":
      "문서는 저장되었습니다. 검색 및 Graph 갱신은 보류 중이며 새로고침하면 다시 시도합니다.",
    "dreaming.wiki.saveReloadFailed": "문서는 저장했지만 최신 버전을 다시 불러오지 못했습니다.",
    "dreaming.wiki.sourceManaged": "원본 내용은 동기화로 관리됩니다. Notes만 편집할 수 있습니다.",
    "dreaming.wiki.generatedReadOnly":
      "자동 생성 보고서는 읽기 전용이며 다음 컴파일에서 교체됩니다.",
    "dreaming.wiki.pageTooLargeReadOnly": "안전한 브라우저 편집 범위를 넘는 큰 문서입니다.",
    "dreaming.wiki.sharedVaultReadOnly": "이 공유 Wiki는 여기에서 읽기 전용입니다.",
    "dreaming.wiki.discardTitle": "Wiki 변경 사항을 버릴까요?",
    "dreaming.wiki.discardDescription": "저장하지 않은 Markdown 변경 사항이 사라집니다.",
    "dreaming.wiki.discard": "변경 사항 버리기",
  },
};
