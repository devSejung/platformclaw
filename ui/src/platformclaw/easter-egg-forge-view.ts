import { html, nothing } from "lit";
import type { BaseballProgress } from "../../../packages/platformclaw-control-plane/src/baseball-contracts.ts";
import {
  BASEBALL_ENHANCEMENT_MAX_LEVEL,
  BASEBALL_ENHANCEMENT_RECOVERY_COST,
  BASEBALL_ENHANCEMENT_RULES,
  getBaseballEnhancementAppearance,
  getBaseballEnhancementRule,
} from "../../../packages/platformclaw-control-plane/src/baseball-enhancement.ts";
import type { BaseballWorkshopNotice } from "./easter-egg-workshop.ts";
import "../styles/platformclaw-baseball-forge.css";

const percent = (value: number) => `${Number((value / 100).toFixed(2))}%`;
const gold = (value: number) => value.toLocaleString("ko-KR");
export function renderBaseballTaunt(taunt: string) {
  return taunt
    ? html`<div class="platformclaw-baseball-taunt" data-forge-taunt role="status">
        <span>${taunt}</span>
      </div>`
    : nothing;
}

function receiptText(notice: BaseballWorkshopNotice): string {
  const spent = notice.chargedGold ? ` · ${gold(notice.chargedGold)}G 사용` : "";
  const names: Record<string, string> = {
    success: `강화 성공 · +${notice.level}${notice.evolved ? " · 진화!" : ""}`,
    maintain: `강화 유지 · +${notice.level}`,
    drop: `강화 하락 · +${notice.level}`,
    destroy: notice.automaticRestart
      ? "일반 파괴 · 복구 자금 부족으로 +0 재시작"
      : "일반 파괴 · 복구 또는 +0 재시작을 선택하세요",
    total_destroy: "완전 파괴 · +0 재시작",
    restored: "복구 완료 · +12",
    restarted: "+0 재시작 완료",
    equipped: `강화 배트 +${notice.level} 장착`,
    team: "팀 선택 완료",
  };
  return `${names[notice.outcome] ?? "결과 확인 완료"}${spent}`;
}

export function renderBaseballForge(params: {
  progress: BaseballProgress | null;
  busy: boolean;
  pending: boolean;
  notice: BaseballWorkshopNotice | null;
  effect: string;
  onEnhance: () => void;
  onRecover: (action: "restore" | "restart") => void;
}) {
  const state = params.progress?.enhancement;
  const level = state?.level ?? 0;
  const appearance = getBaseballEnhancementAppearance(level);
  const rule =
    level < BASEBALL_ENHANCEMENT_MAX_LEVEL ? getBaseballEnhancementRule(level + 1) : null;
  const disabled = params.busy || params.pending || !params.progress;
  return html`<section class="platformclaw-baseball-forge" aria-label="배트 강화">
    <div
      class="platformclaw-baseball-forge__preview"
      data-effect=${params.effect}
      data-bat=${appearance.batId}
      data-appearance=${appearance.appearanceId}
    >
      <span class="platformclaw-baseball-forge__weapon" aria-hidden="true"></span>
      <strong data-enhancement-level=${level}>${appearance.name} +${level}</strong>
      ${params.effect === "destroy" || params.effect === "total_destroy"
        ? html`<span class="platformclaw-baseball-forge__shards" aria-hidden="true"
            >${[0, 1, 2, 3, 4].map((index) => html`<i style=${`--shard:${index}`}></i>`)}</span
          >`
        : nothing}
    </div>
    ${params.notice
      ? html`<p
          class="platformclaw-baseball-forge__receipt"
          role="status"
          data-forge-result=${params.notice.outcome}
        >
          ${receiptText(params.notice)}
        </p>`
      : nothing}
    <p>골드 ${gold(params.progress?.gold ?? 0)}G · 강화비는 결과와 관계없이 사용됩니다.</p>
    ${state?.status === "broken"
      ? html`<div class="platformclaw-baseball-forge__actions">
          <button
            type="button"
            data-forge-recover="restore"
            ?disabled=${disabled}
            @click=${() => params.onRecover("restore")}
          >
            ${gold(BASEBALL_ENHANCEMENT_RECOVERY_COST)}G로 +12 복구
          </button>
          <button
            type="button"
            data-forge-recover="restart"
            ?disabled=${disabled}
            @click=${() => params.onRecover("restart")}
          >
            무료 +0 재시작
          </button>
          <small
            >복구할 때 자금이 부족하면 비용 없이 +0으로 재시작합니다. 골드와 누적 기록은
            유지됩니다.</small
          >
        </div>`
      : rule
        ? html`<button
            type="button"
            data-forge-enhance
            ?disabled=${disabled || (params.progress?.gold ?? 0) < rule.costGold}
            @click=${params.onEnhance}
          >
            +${rule.targetLevel} 도전 · ${gold(rule.costGold)}G
          </button>`
        : html`<strong data-forge-max>최대 강화 +20</strong>`}
    ${rule && state?.status !== "broken"
      ? html`<div
          class="platformclaw-baseball-forge__odds"
          aria-label=${`+${rule.targetLevel} 시도 확률`}
        >
          <span>성공 ${percent(rule.success)}</span><span>유지 ${percent(rule.maintain)}</span>
          <span>하락 ${percent(rule.drop)}${rule.dropTo === null ? "" : ` → +${rule.dropTo}`}</span>
          <span>일반 파괴 ${percent(rule.destroy)}</span
          ><span>완전 파괴 ${percent(rule.totalDestroy)}</span>
        </div>`
      : nothing}
    <small
      >강화 성능은 다음 타석부터 적용됩니다. 강화는 정타 중심만 강하게 하며 Perfect 전체의 홈런을
      보장하지 않습니다.</small
    >
    <details>
      <summary>전체 강화 확률·비용</summary>
      <div class="platformclaw-baseball-forge__table-scroll">
        <table>
          <thead>
            <tr>
              <th>목표</th>
              <th>비용 G</th>
              <th>성공</th>
              <th>유지</th>
              <th>하락</th>
              <th>일반 파괴</th>
              <th>완전 파괴</th>
            </tr>
          </thead>
          <tbody>
            ${BASEBALL_ENHANCEMENT_RULES.map(
              (row) =>
                html`<tr>
                  <th>+${row.targetLevel}</th>
                  <td>${gold(row.costGold)}</td>
                  <td>${percent(row.success)}</td>
                  <td>${percent(row.maintain)}</td>
                  <td>${percent(row.drop)}${row.dropTo === null ? "" : ` → +${row.dropTo}`}</td>
                  <td>${percent(row.destroy)}</td>
                  <td>${percent(row.totalDestroy)}</td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
    </details>
  </section>`;
}
