package com.iflytek.skillhub.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iflytek.skillhub.domain.audit.AuditLogService;
import com.iflytek.skillhub.domain.namespace.Namespace;
import com.iflytek.skillhub.domain.namespace.NamespaceStatus;
import com.iflytek.skillhub.domain.review.ReviewTaskStatus;
import com.iflytek.skillhub.domain.review.ReviewTask;
import com.iflytek.skillhub.domain.review.ReviewTaskRepository;
import com.iflytek.skillhub.domain.security.SecurityAuditRepository;
import com.iflytek.skillhub.domain.security.SecurityScanService;
import com.iflytek.skillhub.domain.security.ScannerType;
import com.iflytek.skillhub.domain.skill.PlatformclawEditReceipt;
import com.iflytek.skillhub.domain.skill.Skill;
import com.iflytek.skillhub.domain.skill.SkillVisibility;
import com.iflytek.skillhub.domain.skill.SkillVersion;
import com.iflytek.skillhub.domain.skill.SkillVersionStatus;
import com.iflytek.skillhub.search.SearchRebuildService;
import jakarta.persistence.EntityManager;
import jakarta.persistence.LockModeType;
import jakarta.validation.constraints.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Owns atomic registry edits without changing immutable release artifacts. */
@Service
public class PlatformclawSkillEditService {
    public record EditRequest(
            @NotNull UUID operationId,
            @NotNull @Positive Long skillId,
            @NotBlank @Size(max = 64) String namespace,
            @NotBlank @Size(max = 100) String slug,
            @NotBlank @Size(max = 128) String expectedRevision,
            @NotBlank @Size(max = 64) String targetNamespace,
            @NotBlank @Size(max = 200) String displayName,
            @NotNull @Size(max = 4000) String summary,
            @NotNull SkillVisibility visibility) {}

    public record Metadata(Long id, String namespace, String slug, String revision,
                           String displayName, String summary, SkillVisibility visibility,
                           SkillVisibility effectiveVisibility, List<String> reviewVersions) {}

    public record ReviewLookup(Long id, String namespace, String skillSlug, String version, String status) {}

    public static class EditFailure extends RuntimeException {
        public final int status;
        public EditFailure(int status, String message) { super(message); this.status = status; }
    }

    private final EntityManager entityManager;
    private final ObjectMapper mapper;
    private final SearchRebuildService search;
    private final AuditLogService audit;
    private final SecurityScanService scanner;
    private final SecurityAuditRepository audits;
    private final ReviewTaskRepository reviews;
    private final GovernanceWorkflowAppService governance;

    public PlatformclawSkillEditService(EntityManager entityManager, ObjectMapper mapper,
                                       SearchRebuildService search, AuditLogService audit,
                                       SecurityScanService scanner, SecurityAuditRepository audits,
                                       ReviewTaskRepository reviews, GovernanceWorkflowAppService governance) {
        this.entityManager = entityManager;
        this.mapper = mapper;
        this.search = search;
        this.audit = audit;
        this.scanner = scanner;
        this.audits = audits;
        this.reviews = reviews;
        this.governance = governance;
    }

    @Transactional(readOnly = true)
    public Metadata read(String namespace, String slug) {
        List<Skill> skills = entityManager.createQuery(
                "select s from Skill s, Namespace n where s.namespaceId = n.id and n.slug = :namespace and s.slug = :slug", Skill.class)
                .setParameter("namespace", namespace).setParameter("slug", slug).getResultList();
        if (skills.isEmpty()) throw new EditFailure(404, "Registry skill was not found");
        if (skills.size() != 1) throw new EditFailure(409, "Registry coordinate is ambiguous");
        return metadata(skills.getFirst(), namespace);
    }

    @Transactional
    public Metadata edit(Long skillId, EditRequest request, String actor, String ip, String agent) {
        if (!skillId.equals(request.skillId())) throw new EditFailure(400, "Skill ID does not match the request");
        String operation = request.operationId().toString();
        // Every caller is a trusted administrator. A rotated governance identity
        // must replay the same durable request; the original actor stays in its audit.
        String requestHash = hash(json(request));
        // PostgreSQL transaction locks serialize identical operation IDs even before
        // their receipt exists; a timeout retry never executes a second edit.
        entityManager.createNativeQuery("select 1 from pg_advisory_xact_lock(:key)")
                .setParameter("key", request.operationId().getMostSignificantBits()).getSingleResult();
        PlatformclawEditReceipt receipt = entityManager.find(PlatformclawEditReceipt.class, operation);
        if (receipt != null) {
            if (!receipt.getRequestHash().equals(requestHash)) {
                throw new EditFailure(409, "Operation ID was already used for a different edit");
            }
            try { return mapper.readValue(receipt.getResultJson(), Metadata.class); }
            catch (JsonProcessingException exception) { throw new IllegalStateException("Invalid edit receipt", exception); }
        }

        Namespace source = namespace(request.namespace());
        Namespace target = namespace(request.targetNamespace());
        // Publication takes the same namespace lock before reading its aggregate.
        // Deterministic ordering prevents opposite-direction moves deadlocking.
        List.of(source, target).stream().distinct().sorted(Comparator.comparing(Namespace::getId))
                .forEach(value -> entityManager.refresh(value, LockModeType.PESSIMISTIC_WRITE));
        Skill skill = entityManager.find(Skill.class, skillId, LockModeType.PESSIMISTIC_WRITE);
        if (skill == null) throw new EditFailure(404, "Registry skill was not found");
        boolean privacyOnly = source.getId().equals(target.getId()) && request.visibility() == SkillVisibility.PRIVATE
                && java.util.Objects.equals(request.displayName(), skill.getDisplayName() == null ? skill.getSlug() : skill.getDisplayName())
                && java.util.Objects.equals(request.summary(), skill.getSummary() == null ? "" : skill.getSummary());
        // A frozen/archived namespace must still allow an administrator to reduce
        // exposure after policy drift. Profile changes and moves remain forbidden.
        boolean inactive = target.getStatus() != NamespaceStatus.ACTIVE || source.getStatus() != NamespaceStatus.ACTIVE;
        if (inactive && !privacyOnly) {
            throw new EditFailure(409, "Inactive namespaces permit only an unchanged-profile Private restriction");
        }
        if (!skill.getNamespaceId().equals(source.getId()) || !skill.getSlug().equals(request.slug())
                || !metadata(skill, source.getSlug()).revision().equals(request.expectedRevision())) {
            throw new EditFailure(409, "Registry skill changed; reload before editing");
        }
        long collisions = entityManager.createQuery(
                "select count(s) from Skill s where s.namespaceId = :namespace and s.slug = :slug and s.id <> :id", Long.class)
                .setParameter("namespace", target.getId()).setParameter("slug", skill.getSlug())
                .setParameter("id", skillId).getSingleResult();
        if (collisions != 0) throw new EditFailure(409, "Destination already contains this skill slug");
        if (!source.getId().equals(target.getId())) {
            long promotions = entityManager.createQuery(
                    "select count(p) from PromotionRequest p where (p.sourceSkillId = :id or p.targetSkillId = :id) and p.status = :pending", Long.class)
                    .setParameter("id", skillId).setParameter("pending", ReviewTaskStatus.PENDING).getSingleResult();
            if (promotions != 0) throw new EditFailure(409, "Finish pending promotions before moving this skill");
            // Pending review authority follows the aggregate; completed review history
            // retains the namespace where the decision was actually made.
            entityManager.createQuery("update ReviewTask r set r.namespaceId = :namespace, r.version = r.version + 1 where r.status = :pending and r.skillVersionId in (select v.id from SkillVersion v where v.skillId = :id)")
                    .setParameter("namespace", target.getId()).setParameter("pending", ReviewTaskStatus.PENDING)
                    .setParameter("id", skillId).executeUpdate();
        }
        skill.setNamespaceId(target.getId());
        if (!inactive) {
            skill.setDisplayName(request.displayName());
            skill.setSummary(request.summary());
        }
        // Sharing a private release is a review transition, never a metadata shortcut.
        // All previously private versions are gated before the first shared approval.
        if (visibilityRank(request.visibility()) > visibilityRank(skill.getVisibility())) {
            if (!prepareSharedVersions(skill, request.visibility(), target.getId(), actor)) {
                skill.setVisibility(request.visibility());
            }
        } else {
            skill.setVisibility(request.visibility());
        }
        skill.setPlatformclawRequestedVisibility(request.visibility());
        skill.setPlatformclawManagedMetadata(true);
        skill.setUpdatedBy(actor);
        entityManager.flush();
        // Flush reads back PostgreSQL timestamp precision before freezing the receipt.
        entityManager.refresh(skill);
        search.rebuildBySkillInCurrentTransaction(skillId);
        Metadata result = metadata(skill, target.getSlug());
        entityManager.persist(new PlatformclawEditReceipt(operation, requestHash, json(result)));
        audit.record(actor, "PLATFORMCLAW_SKILL_EDIT", "skill", skillId, operation, ip, agent,
                json(java.util.Map.of("sourceNamespace", source.getSlug(), "targetNamespace", target.getSlug(),
                        "slug", skill.getSlug(), "visibility", skill.getVisibility().name())));
        entityManager.flush();
        return result;
    }

    @Transactional(readOnly = true)
    public ReviewLookup exactReview(String namespace, String slug, String version) {
        Metadata skill = read(namespace, slug);
        List<ReviewTask> pending = reviewTasks(skill.id(), version, ReviewTaskStatus.PENDING, 2);
        if (pending.size() > 1) throw new EditFailure(409, "Review identity is ambiguous");
        List<ReviewTask> matching = pending.isEmpty()
                ? reviewTasks(skill.id(), version, ReviewTaskStatus.APPROVED, 1) : pending;
        if (matching.isEmpty()) throw new EditFailure(404, "No pending or approved review exists for this release");
        ReviewTask task = matching.getFirst();
        return new ReviewLookup(task.getId(), namespace, slug, version, task.getStatus().name());
    }

    public record Approval(Long id, String status) {}

    @Transactional
    public Approval approveSafe(String namespace, String slug, String version,
            String comment, String actor, com.iflytek.skillhub.service.AuditRequestContext context) {
        Namespace owner = namespace(namespace);
        entityManager.refresh(owner, LockModeType.PESSIMISTIC_WRITE);
        Metadata coordinate = read(namespace, slug);
        Skill skill = entityManager.find(Skill.class, coordinate.id(), LockModeType.PESSIMISTIC_WRITE);
        SkillVersion release = entityManager.createQuery(
                "select v from SkillVersion v where v.skillId = :id and v.version = :version", SkillVersion.class)
                .setParameter("id", skill.getId()).setParameter("version", version)
                .setLockMode(LockModeType.PESSIMISTIC_WRITE).getResultStream().findFirst()
                .orElseThrow(() -> new EditFailure(404, "Registry version was not found"));
        var currentAudits = audits.findLatestActiveByVersionId(release.getId());
        // Scan creation/results hold this version lock too: an earlier SAFE read
        // cannot authorize a newer unsafe rescan while the approval commits.
        if ((release.getStatus() != SkillVersionStatus.PENDING_REVIEW && release.getStatus() != SkillVersionStatus.PUBLISHED)
                || currentAudits.isEmpty() || currentAudits.stream().anyMatch(a -> a.getScannedAt() == null
                        || a.getFailedAt() != null || !Boolean.TRUE.equals(a.getIsSafe()))) {
            throw new EditFailure(409, "The current release requires completed SAFE scans before automatic approval");
        }
        ReviewLookup task = exactReview(namespace, slug, version);
        if (task.status().equals("APPROVED")) return new Approval(task.id(), task.status());
        var approved = governance.approveReview(task.id(), comment, actor, java.util.Map.of(), context);
        return new Approval(approved.id(), approved.status());
    }

    private List<ReviewTask> reviewTasks(Long skillId, String version, ReviewTaskStatus status, int limit) {
        return entityManager.createQuery("select r from ReviewTask r, SkillVersion v where v.skillId = :id and v.version = :version and r.skillVersionId = v.id and r.status = :status order by r.id desc", ReviewTask.class)
                .setParameter("id", skillId).setParameter("version", version).setParameter("status", status)
                .setMaxResults(limit).getResultList();
    }

    private Namespace namespace(String slug) {
        return entityManager.createQuery("select n from Namespace n where n.slug = :slug", Namespace.class)
                .setParameter("slug", slug).getResultStream().findFirst()
                .orElseThrow(() -> new EditFailure(404, "Registry namespace was not found"));
    }

    private Metadata metadata(Skill skill, String namespace) {
        String revision = hash(json(List.of(skill.getId(), namespace, skill.getSlug(),
                skill.getDisplayName() == null ? "" : skill.getDisplayName(),
                skill.getSummary() == null ? "" : skill.getSummary(), skill.getVisibility().name(),
                skill.getPlatformclawDesiredVisibility().name(), skill.getUpdatedAt().toString())));
        return new Metadata(skill.getId(), namespace, skill.getSlug(), revision,
                skill.getDisplayName() == null ? skill.getSlug() : skill.getDisplayName(),
                skill.getSummary() == null ? "" : skill.getSummary(), skill.getPlatformclawDesiredVisibility(),
                skill.getVisibility(), reviewVersions(skill));
    }

    private boolean prepareSharedVersions(Skill skill, SkillVisibility desired, Long namespaceId, String actor) {
        List<SkillVersion> versions = entityManager.createQuery(
                "select v from SkillVersion v where v.skillId = :id and v.status in :statuses order by v.id", SkillVersion.class)
                .setParameter("id", skill.getId()).setParameter("statuses", List.of(SkillVersionStatus.PUBLISHED,
                        SkillVersionStatus.UPLOADED, SkillVersionStatus.SCANNING, SkillVersionStatus.SCAN_FAILED,
                        SkillVersionStatus.PENDING_REVIEW))
                .setLockMode(LockModeType.PESSIMISTIC_WRITE).getResultList();
        if (versions.isEmpty()) {
            throw new EditFailure(422, "Publish a new Private version before sharing this skill.");
        }
        // Re-sharing the same approved audience reuses the recorded decision. An
        // approval made while desired PRIVATE is recorded as PRIVATE by ReviewService.
        versions = versions.stream().filter(version -> !previouslyApprovedFor(version, desired)).toList();
        boolean needsScan = versions.stream().anyMatch(version -> version.getStatus() == SkillVersionStatus.SCAN_FAILED
                || audits.findLatestActiveByVersionIdAndScannerType(version.getId(), ScannerType.SKILL_SCANNER)
                        .map(audit -> audit.getFailedAt() != null).orElse(true));
        // Validate the configured durable-bundle contract before changing any version.
        if (needsScan) scanner.requireStoredBundleScanning();
        for (SkillVersion version : versions) {
            var audit = audits.findLatestActiveByVersionIdAndScannerType(version.getId(), ScannerType.SKILL_SCANNER);
            // A failed round can retain an unfinished or historical audit. Reusing
            // that row would strand sharing without a deliverable scanner task.
            boolean failed = version.getStatus() == SkillVersionStatus.SCAN_FAILED
                    || audit.map(value -> value.getFailedAt() != null).orElse(false);
            boolean scanned = !failed && audit.isPresent() && audit.get().getScannedAt() != null;
            version.setRequestedVisibility(desired);
            if (scanned) {
                version.setStatus(SkillVersionStatus.PENDING_REVIEW);
            } else {
                version.setStatus(SkillVersionStatus.SCANNING);
            }
            if (reviews.findBySkillVersionIdAndStatus(version.getId(), ReviewTaskStatus.PENDING).isEmpty()) {
                reviews.save(new ReviewTask(version.getId(), namespaceId, actor));
            }
            if (failed || audit.isEmpty()) scanner.triggerStoredBundleScan(version.getId(), actor);
        }
        return !versions.isEmpty();
    }

    private boolean previouslyApprovedFor(SkillVersion version, SkillVisibility desired) {
        return version.getStatus() == SkillVersionStatus.PUBLISHED
                && version.getRequestedVisibility() != null
                && visibilityRank(version.getRequestedVisibility()) >= visibilityRank(desired)
                && !entityManager.createQuery("select r.id from ReviewTask r where r.skillVersionId = :id and r.status = :approved", Long.class)
                        .setParameter("id", version.getId()).setParameter("approved", ReviewTaskStatus.APPROVED)
                        .setMaxResults(1).getResultList().isEmpty();
    }

    private List<String> reviewVersions(Skill skill) {
        if (skill.getPlatformclawDesiredVisibility() == SkillVisibility.PRIVATE) return List.of();
        return entityManager.createQuery(
                "select distinct v.version from SkillVersion v, ReviewTask r where v.skillId = :id and r.skillVersionId = v.id and r.status = :pending order by v.version", String.class)
                .setParameter("id", skill.getId()).setParameter("pending", ReviewTaskStatus.PENDING).getResultList();
    }

    private static int visibilityRank(SkillVisibility value) {
        return switch (value) { case PRIVATE -> 0; case NAMESPACE_ONLY -> 1; case PUBLIC -> 2; };
    }

    private String json(Object value) {
        try { return mapper.writeValueAsString(value); }
        catch (JsonProcessingException exception) { throw new IllegalStateException("Cannot encode registry edit", exception); }
    }

    private static String hash(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (NoSuchAlgorithmException exception) { throw new IllegalStateException(exception); }
    }
}
