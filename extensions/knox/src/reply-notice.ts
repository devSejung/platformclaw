import type { NoVisibleReplyReason } from "openclaw/plugin-sdk/reply-payload";

export type KnoxReplyFailureReason =
  | NoVisibleReplyReason
  | "timeout"
  | "cancelled"
  | "runtime-error"
  | "unrenderable-result";

const REPLY_FAILURE_TEXT: Record<KnoxReplyFailureReason, string> = {
  "send-policy-denied": "이 대화의 응답 전송 정책에 따라 자동 답변을 보내지 않았습니다.",
  "message-tool-only": "이 작업은 별도 메시지 전송으로만 답변하도록 설정되어 있습니다.",
  "queue-cap":
    "대기 중인 요청이 가득 차 이 요청을 시작하지 못했습니다. 앞선 작업이 끝난 뒤 다시 요청해 주세요.",
  "question-unavailable":
    "답변한 질문이 이미 처리되었거나 종료되었습니다. 최신 질문을 확인한 뒤 다시 답해 주세요.",
  "delivery-failed":
    "답변 전송 단계에서 오류가 발생해 전달을 확인하지 못했습니다. 같은 작업을 다시 실행하기 전에 처리 결과를 확인해 주세요.",
  "delivery-suppressed":
    "답변이 전송 전 처리 단계에서 취소되어 전달되지 않았습니다. 운영자에게 전송 정책과 처리 기록 확인을 요청해 주세요.",
  "delivery-not-visible":
    "답변을 전달하는 단계까지 진행했지만 화면에 표시된 결과를 확인하지 못했습니다. 운영자에게 전송 기록 확인을 요청해 주세요.",
  "filtered-result":
    "작업 결과는 있었지만 현재 대화에 표시할 답변이 남지 않았습니다. 운영자에게 응답 필터와 표시 설정 확인을 요청해 주세요.",
  "empty-result":
    "작업이 끝났지만 답변 내용이 반환되지 않았습니다. 모델 오류인지 확인되지 않아 응답 생성 기록 확인이 필요합니다.",
  unknown:
    "작업은 끝났지만 답변을 확인하지 못했습니다. 현재 기록만으로 원인을 구분할 수 없어 운영자의 실행·전송 기록 확인이 필요합니다.",
  timeout:
    "제한 시간 안에 작업을 마치지 못했습니다. 이미 처리된 내용이 있을 수 있으니 결과를 확인한 뒤 이어서 요청해 주세요.",
  cancelled: "완료 전에 작업이 취소되었습니다. 계속하려면 남은 작업을 다시 요청해 주세요.",
  "runtime-error":
    "작업 실행 중 오류가 발생했습니다. 운영자에게 아래 확인 코드로 실행 기록 확인을 요청해 주세요.",
  "unrenderable-result":
    "응답에 본문·선택지·첨부 설명이 없어 Knox 메시지로 변환하지 못했습니다. 운영자에게 응답 형식 확인을 요청해 주세요.",
};

/** Publish only closed diagnoses, never raw provider errors or private tool arguments. */
export function formatKnoxReplyFailure(reason: KnoxReplyFailureReason, reference: string): string {
  return `${REPLY_FAILURE_TEXT[reason]}\n\n확인 코드: ${reason}\n요청 참조: ${reference}`;
}
