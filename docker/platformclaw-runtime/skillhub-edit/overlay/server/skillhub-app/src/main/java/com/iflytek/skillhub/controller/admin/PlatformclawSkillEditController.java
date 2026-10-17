package com.iflytek.skillhub.controller.admin;

import com.iflytek.skillhub.auth.rbac.PlatformPrincipal;
import com.iflytek.skillhub.dto.ApiResponse;
import com.iflytek.skillhub.dto.ApiResponseFactory;
import com.iflytek.skillhub.service.PlatformclawSkillEditService;
import com.iflytek.skillhub.service.PlatformclawSkillEditService.*;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

/** Private administrative transport, protected by the existing session and CSRF chain. */
@RestController
@RequestMapping("/api/v1/admin/platformclaw/skills")
@PreAuthorize("hasRole('SUPER_ADMIN')")
public class PlatformclawSkillEditController {
    private final PlatformclawSkillEditService service;
    private final ApiResponseFactory responses;
    public PlatformclawSkillEditController(PlatformclawSkillEditService service, ApiResponseFactory responses) {
        this.service = service;
        this.responses = responses;
    }
    @GetMapping("/{namespace}/{slug}")
    public ApiResponse<Metadata> read(@PathVariable String namespace, @PathVariable String slug) {
        return responses.ok("response.success.read", service.read(namespace, slug));
    }
    @GetMapping("/{namespace}/{slug}/versions/{version}/review")
    public ApiResponse<ReviewLookup> exactReview(@PathVariable String namespace, @PathVariable String slug,
                                               @PathVariable String version) {
        return responses.ok("response.success.read", service.exactReview(namespace, slug, version));
    }
    public record SafeApprovalRequest(@jakarta.validation.constraints.Size(max = 4000) String comment) {}
    @PostMapping("/{namespace}/{slug}/versions/{version}/approve-safe")
    public ApiResponse<Approval> approveSafe(@PathVariable String namespace, @PathVariable String slug,
            @PathVariable String version, @Valid @RequestBody SafeApprovalRequest request,
            @AuthenticationPrincipal PlatformPrincipal principal, HttpServletRequest http) {
        return responses.ok("response.success.updated", service.approveSafe(namespace, slug, version,
                request.comment(), principal.userId(), com.iflytek.skillhub.service.AuditRequestContext.from(http)));
    }
    @PatchMapping("/{skillId}")
    public ApiResponse<Metadata> edit(@PathVariable Long skillId, @Valid @RequestBody EditRequest request,
            @AuthenticationPrincipal PlatformPrincipal principal, HttpServletRequest http) {
        return responses.ok("response.success.updated", service.edit(skillId, request, principal.userId(),
                http.getRemoteAddr(), http.getHeader("User-Agent")));
    }
    @ExceptionHandler(EditFailure.class)
    public ResponseEntity<ApiResponse<Void>> failure(EditFailure failure) {
        return ResponseEntity.status(failure.status).body(responses.errorMessage(failure.status, failure.getMessage()));
    }
}
