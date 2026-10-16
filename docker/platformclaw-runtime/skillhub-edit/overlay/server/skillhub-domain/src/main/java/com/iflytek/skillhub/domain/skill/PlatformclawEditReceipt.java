package com.iflytek.skillhub.domain.skill;

import jakarta.persistence.*;
import java.time.Instant;

/** Durable replay authority; the receipt commits with its aggregate mutation. */
@Entity
@Table(name = "platformclaw_skill_edit_receipt")
public class PlatformclawEditReceipt {
    @Id
    @Column(name = "operation_id", length = 36)
    private String operationId;
    @Column(name = "request_hash", nullable = false, length = 64)
    private String requestHash;
    @Column(name = "result_json", nullable = false, columnDefinition = "TEXT")
    private String resultJson;
    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected PlatformclawEditReceipt() {}
    public PlatformclawEditReceipt(String operationId, String requestHash, String resultJson) {
        this.operationId = operationId;
        this.requestHash = requestHash;
        this.resultJson = resultJson;
        this.createdAt = Instant.now();
    }
    public String getRequestHash() { return requestHash; }
    public String getResultJson() { return resultJson; }
}
