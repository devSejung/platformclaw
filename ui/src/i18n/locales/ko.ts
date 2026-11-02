import generatedKo from "virtual:openclaw-control-ui-locale/ko";

const chat = generatedKo.chat;
if (!chat || typeof chat !== "object") {
  throw new Error("The Korean locale catalog is missing its chat section");
}

// PlatformClaw owns this requested Korean copy: the upstream-only locale
// refresh does not run in this downstream repository. Keep other copy generated.
export const ko = {
  ...generatedKo,
  chat: {
    ...chat,
    documentViewer: {
      pageUnit: "페이지",
      slideUnit: "슬라이드",
      previewOptions: "미리보기 옵션",
      instructionPlaceholder: "예: 제목 바꿔줘",
      previousPage: "이전 페이지",
      nextPage: "다음 페이지",
      pagePosition: "전체 {total}페이지 중 {current}페이지",
      previousSlide: "이전 슬라이드",
      nextSlide: "다음 슬라이드",
      slidePosition: "전체 {total}장 중 {current}번 슬라이드",
      slideLabel: "{title}, 전체 {total}장 중 {current}번 슬라이드",
      slideThumbnail: "슬라이드 {page}",
      slideTextAlternative: "슬라이드 텍스트",
      contents: "목차",
      pageThumbnail: "페이지 {page}",
      previousContents: "이전 페이지 목록",
      nextContents: "다음 페이지 목록",
      thumbnailError: "썸네일을 불러올 수 없습니다",
      requestChanges: "수정 요청",
      requestHint: "수정할 부분을 클릭하거나 드래그해서 영역을 선택하세요.",
      selectedRegion: "선택한 영역",
      selectedText: "선택한 텍스트",
      instruction: "수정 요청 내용",
      submitRequest: "요청 보내기",
      cancelRequest: "요청 취소",
      requestUnavailable: "요청을 보내지 못했습니다. 입력한 내용을 유지한 채 다시 시도하세요.",
      requestSent: "요청을 보냈습니다",
      changeRequestTitle: "{filename} 수정 요청 — {page}",
      changeRequestRegion: "선택한 영역: 왼쪽 {x}%, 위쪽 {y}%, 너비 {width}%, 높이 {height}%.",
      changeRequestCrop:
        "첨부 이미지는 선택한 영역입니다. 원본 문서는 답장의 참조로 연결되며 다시 첨부되지 않습니다.",
      requestCropError: "선택한 영역을 캡처하지 못했습니다. 더 작은 영역을 선택해 다시 시도하세요.",
      fitPage: "페이지에 맞춤",
      fitWidth: "너비에 맞춤",
      expand: "문서 미리보기 확대",
      collapse: "문서 미리보기 축소",
      pageLabel: "{title}, 전체 {total}페이지 중 {current}페이지",
      loadError:
        "문서를 표시할 수 없습니다. 미리보기를 닫았다 다시 열거나 원본 파일을 다운로드하세요.",
      passwordProtected: "암호가 필요한 문서입니다. 원본 파일을 다운로드해 여세요.",
      textAlternative: "페이지 텍스트",
    },
  },
};
