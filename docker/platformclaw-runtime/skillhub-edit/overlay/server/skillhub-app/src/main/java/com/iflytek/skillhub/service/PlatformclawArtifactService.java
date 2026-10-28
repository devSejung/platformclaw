package com.iflytek.skillhub.service;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iflytek.skillhub.domain.namespace.Namespace;
import com.iflytek.skillhub.domain.security.SecurityAudit;
import com.iflytek.skillhub.domain.security.SecurityFinding;
import com.iflytek.skillhub.domain.skill.*;
import com.iflytek.skillhub.domain.skill.service.SkillHardDeleteService;
import com.iflytek.skillhub.domain.skill.service.SkillStorageDeletionCompensationService;
import com.iflytek.skillhub.dto.SecurityAuditResponse;
import com.iflytek.skillhub.search.SearchIndexService;
import com.iflytek.skillhub.storage.ObjectStorageService;
import jakarta.persistence.EntityManager;
import jakarta.persistence.LockModeType;
import java.io.InputStream;
import java.time.Instant;
import java.util.List;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Private artifact authority; employee sharing remains solely in PlatformClaw. */
@Service
public class PlatformclawArtifactService {
    private static final int AUDIT_PAGE_SIZE = 100;
    private static final long MAX_ARCHIVE_BYTES = 500L * 1024 * 1024;
    private static final TypeReference<List<SecurityFinding>> FINDINGS = new TypeReference<>() {};
    private final EntityManager entities;
    private final ObjectStorageService storage;
    private final ObjectMapper mapper;
    private final SkillHardDeleteService hardDelete;
    private final SearchIndexService search;
    private final SkillStorageDeletionCompensationService cleanup;

    public PlatformclawArtifactService(EntityManager entities, ObjectStorageService storage,
            ObjectMapper mapper, SkillHardDeleteService hardDelete, SearchIndexService search,
            SkillStorageDeletionCompensationService cleanup) {
        this.entities = entities;
        this.storage = storage;
        this.mapper = mapper;
        this.hardDelete = hardDelete;
        this.search = search;
        this.cleanup = cleanup;
    }

    public static class ArtifactFailure extends RuntimeException {
        public final int status;
        public ArtifactFailure(int status, String message) { super(message); this.status = status; }
    }
    public record Artifact(InputStream content, long size) {}
    public record AuditPage(List<SecurityAuditResponse> items, long total,
                            boolean artifactAvailable, boolean blocked) {}
    public record Metadata(Long id, String namespace, String slug, String displayName,
                           String summary, SkillVisibility visibility, SkillStatus status) {}
    public record VersionMetadata(Long id, String version, SkillVersionStatus status, String changelog,
                                  Integer fileCount, Long totalSize, Instant publishedAt) {}
    public record VersionPage(List<VersionMetadata> items, long total) {}
    @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
    public record Deletion(Long skillId, String state, Instant completedAt) {}

    private Skill identity(Long id, String namespace, String slug, LockModeType lock) {
        return identity(id, namespace, slug, lock, true);
    }

    private Skill identity(Long id, String namespace, String slug, LockModeType lock, boolean activeOnly) {
        Skill skill = entities.find(Skill.class, id);
        if (skill == null) throw new ArtifactFailure(404, "Registry skill was not found");
        Namespace owner = entities.find(Namespace.class, skill.getNamespaceId());
        if (owner == null) throw new ArtifactFailure(409, "Registry namespace identity changed");
        if (lock != null) {
            // Match publication/deletion lock order; never authorize a reused coordinate.
            entities.refresh(owner, lock);
            entities.detach(skill);
            skill = entities.find(Skill.class, id, lock);
            if (skill == null) throw new ArtifactFailure(404, "Registry skill was not found");
        }
        if (!owner.getSlug().equals(namespace) || !skill.getSlug().equals(slug)
                || !skill.getNamespaceId().equals(owner.getId())) {
            throw new ArtifactFailure(409, "Registry artifact identity changed");
        }
        if (activeOnly && skill.getStatus() != SkillStatus.ACTIVE) throw new ArtifactFailure(410, "Registry skill is inactive");
        return skill;
    }

    @Transactional(readOnly = true)
    public Metadata metadata(String namespace, String slug, Long expectedSkillId, String expectedPublicationId) {
        List<Skill> matches = entities.createQuery(
                "select s from Skill s, Namespace n where s.namespaceId = n.id and n.slug = :namespace and s.slug = :slug", Skill.class)
                .setParameter("namespace", namespace).setParameter("slug", slug).setMaxResults(2).getResultList();
        if (matches.isEmpty()) throw new ArtifactFailure(404, "Registry skill was not found");
        if (matches.size() != 1 || (expectedSkillId != null && !expectedSkillId.equals(matches.getFirst().getId()))
                || (expectedPublicationId != null && !expectedPublicationId.equals(matches.getFirst().getPlatformclawManagedPublicationId()))) {
            throw new ArtifactFailure(409, "Registry artifact identity changed");
        }
        Skill skill = matches.getFirst();
        return new Metadata(skill.getId(), namespace, skill.getSlug(),
                skill.getDisplayName() == null ? skill.getSlug() : skill.getDisplayName(),
                skill.getSummary() == null ? "" : skill.getSummary(), skill.getVisibility(), skill.getStatus());
    }

    @Transactional(readOnly = true)
    public VersionPage versions(Long skillId, String namespace, String slug, int page, int size) {
        if (page < 0 || size < 1 || size > AUDIT_PAGE_SIZE || page > Integer.MAX_VALUE / size) {
            throw new ArtifactFailure(400, "Invalid artifact version page");
        }
        identity(skillId, namespace, slug, null);
        long total = entities.createQuery("select count(v) from SkillVersion v where v.skillId = :id", Long.class)
                .setParameter("id", skillId).getSingleResult();
        List<VersionMetadata> items = entities.createQuery(
                "select v from SkillVersion v where v.skillId = :id order by v.id", SkillVersion.class)
                .setParameter("id", skillId).setFirstResult(page * size).setMaxResults(size).getResultList().stream()
                .map(v -> new VersionMetadata(v.getId(), v.getVersion(), v.getStatus(), v.getChangelog(),
                        v.getFileCount(), v.getTotalSize(), v.getPublishedAt())).toList();
        return new VersionPage(items, total);
    }

    private SkillVersion version(Long skillId, Long versionId, LockModeType lock) {
        SkillVersion version = entities.find(SkillVersion.class, versionId);
        if (version == null || !version.getSkillId().equals(skillId)) {
            throw new ArtifactFailure(404, "Registry version was not found");
        }
        if (lock != null) entities.refresh(version, lock);
        if (!version.getSkillId().equals(skillId)) throw new ArtifactFailure(409, "Registry version identity changed");
        return version;
    }

    private String bundle(Long skillId, Long versionId) {
        return "packages/" + skillId + "/" + versionId + "/bundle.zip";
    }

    private List<SecurityAudit> audits(Long versionId, int offset, int size) {
        // Include superseded and soft-deleted rounds: a rescan cannot erase a confirmed block.
        return entities.createQuery("select a from SecurityAudit a where a.skillVersionId = :version order by a.createdAt desc, a.id desc", SecurityAudit.class)
                .setParameter("version", versionId).setFirstResult(offset).setMaxResults(size).getResultList();
    }

    private List<SecurityFinding> findings(SecurityAudit audit) {
        try { return mapper.readValue(audit.getFindings() == null ? "[]" : audit.getFindings(), FINDINGS); }
        catch (Exception failure) { throw new ArtifactFailure(503, "Historical scan evidence is unreadable"); }
    }

    private boolean confirmed(SecurityAudit audit) {
        return audit.getScannedAt() != null && findings(audit).stream().anyMatch(finding ->
                "VIRUSTOTAL_MALICIOUS_FILE".equals(finding.ruleId())
                && "virustotal".equals(finding.analyzer()) && "malware".equals(finding.category())
                && finding.metadata() != null && finding.metadata().get("file_hash") instanceof String hash
                && hash.matches("(?i)[a-f0-9]{64}"));
    }

    private boolean blocked(Long versionId) {
        for (int offset = 0; ; offset = Math.addExact(offset, AUDIT_PAGE_SIZE)) {
            List<SecurityAudit> batch = audits(versionId, offset, AUDIT_PAGE_SIZE);
            if (batch.stream().anyMatch(this::confirmed)) return true;
            if (batch.size() < AUDIT_PAGE_SIZE) return false;
        }
    }

    private boolean available(SkillVersion version) {
        if (version.getStatus() == SkillVersionStatus.YANKED || version.getYankedAt() != null
                || !version.isBundleReady() || !version.isDownloadReady()) return false;
        String key = bundle(version.getSkillId(), version.getId());
        if (!storage.exists(key)) return false;
        long size = storage.getMetadata(key).size();
        return size > 0 && size <= MAX_ARCHIVE_BYTES;
    }

    @Transactional(readOnly = true)
    public AuditPage securityAudits(Long skillId, Long versionId, String namespace, String slug, int page, int size) {
        if (page < 0 || size < 1 || size > AUDIT_PAGE_SIZE || page > Integer.MAX_VALUE / size) {
            throw new ArtifactFailure(400, "Invalid scan history page");
        }
        identity(skillId, namespace, slug, null);
        SkillVersion version = version(skillId, versionId, null);
        boolean blocked = blocked(versionId);
        long total = entities.createQuery("select count(a) from SecurityAudit a where a.skillVersionId = :version", Long.class)
                .setParameter("version", versionId).getSingleResult();
        List<SecurityAuditResponse> items = audits(versionId, page * size, size).stream().map(audit ->
                new SecurityAuditResponse(audit.getId(), audit.getScanId(), audit.getScannerType().getValue(),
                        audit.getVerdict(), audit.getIsSafe(), audit.getMaxSeverity(), audit.getFindingsCount(),
                        findings(audit), audit.getScanDurationSeconds(), audit.getScannedAt(),
                        audit.getCreatedAt(), audit.getFailedAt())).toList();
        return new AuditPage(items, total, !blocked && available(version), blocked);
    }

    @Transactional
    public Artifact artifact(Long skillId, Long versionId, String namespace, String slug) {
        identity(skillId, namespace, slug, LockModeType.PESSIMISTIC_READ);
        SkillVersion version = version(skillId, versionId, LockModeType.PESSIMISTIC_READ);
        if (blocked(versionId)) throw new ArtifactFailure(410, "This version is blocked as confirmed malware");
        if (!available(version)) throw new ArtifactFailure(409, "The original version bundle is unavailable");
        String key = bundle(skillId, versionId);
        // Open the original object at the checked boundary. Never synthesize a partial bundle.
        return new Artifact(storage.getObject(key), storage.getMetadata(key).size());
    }

    @Transactional
    public void deleteArtifact(Long skillId, String namespace, String slug, String actor, AuditRequestContext context) {
        if (!cleanup.deletionReceipts(skillId).isEmpty()) return;
        Skill skill;
        try {
            skill = identity(skillId, namespace, slug, LockModeType.PESSIMISTIC_WRITE, false);
        } catch (ArtifactFailure failure) {
            // A concurrent retry may have waited behind the first delete's namespace lock.
            if (failure.status == 404 && !cleanup.deletionReceipts(skillId).isEmpty()) return;
            throw failure;
        }
        search.remove(skillId);
        hardDelete.hardDeleteSkill(skill, namespace, actor, context.clientIp(), context.userAgent());
    }

    @Transactional(readOnly = true)
    public Deletion deletionStatus(Long skillId) {
        var receipts = cleanup.deletionReceipts(skillId);
        if (receipts.isEmpty()) throw new ArtifactFailure(404, "Artifact deletion status is unknown");
        if (receipts.stream().anyMatch(receipt -> receipt.getStatus() != SkillStorageDeletionCompensationStatus.COMPLETED)) {
            return new Deletion(skillId, "pending", null);
        }
        Instant completed = receipts.stream().map(SkillStorageDeletionCompensation::getUpdatedAt).max(Instant::compareTo).orElseThrow();
        return new Deletion(skillId, "completed", completed);
    }
}
