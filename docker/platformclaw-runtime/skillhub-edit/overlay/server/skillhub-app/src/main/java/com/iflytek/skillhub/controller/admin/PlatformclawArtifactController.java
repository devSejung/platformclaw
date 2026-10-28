package com.iflytek.skillhub.controller.admin;

import com.iflytek.skillhub.auth.rbac.PlatformPrincipal;
import com.iflytek.skillhub.controller.support.SkillPackageArchiveExtractor;
import com.iflytek.skillhub.domain.shared.exception.DomainBadRequestException;
import com.iflytek.skillhub.domain.skill.service.SkillPublishService;
import com.iflytek.skillhub.dto.ApiResponse;
import com.iflytek.skillhub.dto.ApiResponseFactory;
import com.iflytek.skillhub.dto.PublishResponse;
import com.iflytek.skillhub.service.AuditRequestContext;
import com.iflytek.skillhub.service.PlatformclawArtifactService;
import com.iflytek.skillhub.service.PlatformclawArtifactService.*;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import org.springframework.core.io.InputStreamResource;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

/** Managed registry transport uses the existing administrative session and CSRF policy. */
@RestController
@RequestMapping("/api/v1/admin/platformclaw/skills")
@PreAuthorize("hasRole('SUPER_ADMIN')")
public class PlatformclawArtifactController {
    private final PlatformclawArtifactService service;
    private final ApiResponseFactory responses;
    private final SkillPublishService publisher;
    private final SkillPackageArchiveExtractor extractor;
    public PlatformclawArtifactController(PlatformclawArtifactService service, ApiResponseFactory responses,
            SkillPublishService publisher, SkillPackageArchiveExtractor extractor) {
        this.service = service;
        this.responses = responses;
        this.publisher = publisher;
        this.extractor = extractor;
    }

    public record IdentityRequest(String namespace, String slug, java.util.UUID publicationId) {}

    @PostMapping("/identities")
    public ApiResponse<Metadata> reserveIdentity(@RequestBody IdentityRequest request,
            @AuthenticationPrincipal PlatformPrincipal principal) {
        String operation = request.publicationId() == null ? null : request.publicationId().toString();
        Long id = publisher.reserveManagedIdentity(request.namespace(), request.slug(), operation,
                principal.userId(), principal.platformRoles());
        return responses.ok("response.success.read", service.metadata(request.namespace(), request.slug(), id, operation));
    }

    @PostMapping(value = "/publish", consumes = "multipart/form-data")
    public ApiResponse<PublishResponse> publish(@RequestParam String namespace,
            @RequestParam Long expectedSkillId,
            @RequestParam("file") MultipartFile file,
            @AuthenticationPrincipal PlatformPrincipal principal) throws IOException {
        SkillPackageArchiveExtractor.ExtractionResult extracted;
        try {
            extracted = extractor.extractWithWarnings(file);
        } catch (IllegalArgumentException invalid) {
            throw new DomainBadRequestException("error.skill.publish.package.invalid", invalid.getMessage());
        }
        // Valid heuristic warnings are informational. The shared domain pipeline
        // still rejects structural/manifest errors and preserves scan evidence.
        // The caller must persist its separately reserved ID before this request.
        // No archive POST can create an identity unknown to the control plane.
        try (var bundle = file.getInputStream()) {
            var result = publisher.publishManagedFromEntries(namespace, extracted.entries(), principal.userId(),
                    principal.platformRoles(), expectedSkillId, bundle, file.getSize());
            return responses.ok("response.success.published", new PublishResponse(result.skillId(), namespace,
                    result.slug(), result.version().getVersion(), result.version().getStatus().name(),
                    result.version().getFileCount(), result.version().getTotalSize()));
        }
    }

    @GetMapping("/coordinates/{namespace}/{slug}")
    public ApiResponse<Metadata> metadata(@PathVariable String namespace, @PathVariable String slug,
            @RequestParam(required = false) Long expectedSkillId,
            @RequestParam(required = false) java.util.UUID expectedPublicationId) {
        return responses.ok("response.success.read", service.metadata(namespace, slug, expectedSkillId,
                expectedPublicationId == null ? null : expectedPublicationId.toString()));
    }

    @GetMapping("/{skillId}/artifact/versions")
    public ApiResponse<VersionPage> versions(@PathVariable Long skillId,
            @RequestParam String namespace, @RequestParam String slug,
            @RequestParam(defaultValue = "0") int page, @RequestParam(defaultValue = "100") int size) {
        return responses.ok("response.success.read", service.versions(skillId, namespace, slug, page, size));
    }

    @GetMapping("/{skillId}/versions/{versionId}/artifact")
    public ResponseEntity<InputStreamResource> artifact(@PathVariable Long skillId, @PathVariable Long versionId,
            @RequestParam String namespace, @RequestParam String slug) {
        Artifact artifact = service.artifact(skillId, versionId, namespace, slug);
        return ResponseEntity.ok().header("Content-Type", "application/zip")
                .header("Cache-Control", "private, no-store").header("X-Content-Type-Options", "nosniff")
                .header("Content-Disposition", "attachment; filename=skill-" + skillId + "-" + versionId + ".zip")
                .contentLength(artifact.size()).body(new InputStreamResource(artifact.content()));
    }

    @GetMapping("/{skillId}/versions/{versionId}/security-audits")
    public ApiResponse<AuditPage> securityAudits(@PathVariable Long skillId, @PathVariable Long versionId,
            @RequestParam String namespace, @RequestParam String slug,
            @RequestParam(defaultValue = "0") int page, @RequestParam(defaultValue = "100") int size) {
        return responses.ok("response.success.read", service.securityAudits(skillId, versionId, namespace, slug, page, size));
    }

    @DeleteMapping("/{skillId}/artifact")
    public ApiResponse<Deletion> deleteArtifact(@PathVariable Long skillId,
            @RequestParam String namespace, @RequestParam String slug,
            @AuthenticationPrincipal PlatformPrincipal principal, HttpServletRequest request) {
        service.deleteArtifact(skillId, namespace, slug, principal.userId(), AuditRequestContext.from(request));
        return responses.ok("response.success.updated", service.deletionStatus(skillId));
    }

    @GetMapping("/{skillId}/artifact-deletion")
    public ApiResponse<Deletion> deletionStatus(@PathVariable Long skillId) {
        return responses.ok("response.success.read", service.deletionStatus(skillId));
    }

    @ExceptionHandler(ArtifactFailure.class)
    public ResponseEntity<ApiResponse<Void>> failure(ArtifactFailure failure) {
        return ResponseEntity.status(failure.status)
                .header("Cache-Control", "private, no-store")
                .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                .body(responses.errorMessage(failure.status, failure.getMessage()));
    }
}
