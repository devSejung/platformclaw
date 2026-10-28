package com.iflytek.skillhub.service;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iflytek.skillhub.domain.namespace.Namespace;
import com.iflytek.skillhub.domain.security.*;
import com.iflytek.skillhub.domain.skill.*;
import com.iflytek.skillhub.domain.skill.service.*;
import com.iflytek.skillhub.search.SearchIndexService;
import com.iflytek.skillhub.storage.*;
import jakarta.persistence.*;
import java.io.ByteArrayInputStream;
import java.time.Instant;
import java.util.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.springframework.test.util.ReflectionTestUtils;

class PlatformclawArtifactServiceTest {
    private final EntityManager entities = mock(EntityManager.class);
    private final ObjectStorageService storage = mock(ObjectStorageService.class);
    private final SkillHardDeleteService hardDelete = mock(SkillHardDeleteService.class);
    private final SearchIndexService search = mock(SearchIndexService.class);
    private final SkillStorageDeletionCompensationService cleanup = mock(SkillStorageDeletionCompensationService.class);
    private final TypedQuery<SecurityAudit> auditQuery = mock(TypedQuery.class);
    private final TypedQuery<Long> countQuery = mock(TypedQuery.class);
    private final List<SecurityAudit> history = new ArrayList<>();
    private SkillVersion version;
    private Skill skill;
    private PlatformclawArtifactService service;
    private static final String KEY = "packages/7/11/bundle.zip";

    @BeforeEach
    void setup() {
        service = new PlatformclawArtifactService(entities, storage, new ObjectMapper(), hardDelete, search, cleanup);
        skill = new Skill(3L, "demo", "publisher", SkillVisibility.PRIVATE);
        ReflectionTestUtils.setField(skill, "id", 7L);
        Namespace namespace = new Namespace("global", "Global", "publisher");
        ReflectionTestUtils.setField(namespace, "id", 3L);
        version = new SkillVersion(7L, "1.0.0", "publisher");
        ReflectionTestUtils.setField(version, "id", 11L);
        version.setBundleReady(true); version.setDownloadReady(true);
        when(entities.find(Skill.class, 7L)).thenReturn(skill);
        when(entities.find(eq(Skill.class), eq(7L), any(LockModeType.class))).thenReturn(skill);
        when(entities.find(Namespace.class, 3L)).thenReturn(namespace);
        when(entities.find(SkillVersion.class, 11L)).thenReturn(version);
        when(entities.createQuery(startsWith("select a "), eq(SecurityAudit.class))).thenReturn(auditQuery);
        when(auditQuery.setParameter(eq("version"), any())).thenReturn(auditQuery);
        final int[] offset = {0}; final int[] size = {100};
        when(auditQuery.setFirstResult(anyInt())).thenAnswer(invocation -> { offset[0] = invocation.getArgument(0); return auditQuery; });
        when(auditQuery.setMaxResults(anyInt())).thenAnswer(invocation -> { size[0] = invocation.getArgument(0); return auditQuery; });
        when(auditQuery.getResultList()).thenAnswer(invocation -> new ArrayList<>(history.subList(Math.min(offset[0], history.size()), Math.min(offset[0] + size[0], history.size()))));
        when(entities.createQuery(startsWith("select count"), eq(Long.class))).thenReturn(countQuery);
        when(countQuery.setParameter(eq("version"), any())).thenReturn(countQuery);
        when(countQuery.getSingleResult()).thenAnswer(invocation -> (long) history.size());
        when(storage.exists(KEY)).thenReturn(true);
        when(storage.getMetadata(KEY)).thenReturn(new ObjectMetadata(3, "application/zip", Instant.now()));
        when(storage.getObject(KEY)).thenReturn(new ByteArrayInputStream(new byte[]{1,2,3}));
    }

    @ParameterizedTest
    @EnumSource(value = SkillVersionStatus.class, names = {"UPLOADED", "SCANNING", "SCAN_FAILED", "PENDING_REVIEW", "PUBLISHED"})
    void exportsOriginalBundleIndependentlyOfReviewGate(SkillVersionStatus status) throws Exception {
        version.setStatus(status);
        assertThat(service.securityAudits(7L, 11L, "global", "demo", 0, 100).artifactAvailable()).isTrue();
        try (var content = service.artifact(7L, 11L, "global", "demo").content()) {
            assertThat(content.readAllBytes()).containsExactly(1,2,3);
        }
        verify(storage).getObject(KEY);
    }

    @Test
    void blocksHistoricalConfirmedMalwareEvenBehindManyNewerRounds() {
        for (int i=0; i<101; i++) history.add(audit(false));
        history.add(audit(true));
        var page = service.securityAudits(7L, 11L, "global", "demo", 0, 100);
        assertThat(page.total()).isEqualTo(102);
        assertThat(page.items()).hasSize(100);
        assertThat(page.blocked()).isTrue();
        assertThat(page.artifactAvailable()).isFalse();
        assertThatThrownBy(() -> service.artifact(7L, 11L, "global", "demo")).isInstanceOf(PlatformclawArtifactService.ArtifactFailure.class).hasMessageContaining("confirmed malware");
        verify(storage, never()).getObject(anyString());
    }

    @Test
    void treatsHeuristicCriticalFindingAsWarningAndIncludesHistoricalPages() {
        SecurityAudit warning = audit(false);
        warning.setIsSafe(false); warning.setVerdict(SecurityVerdict.BLOCKED);
        warning.setFindings("[{\"ruleId\":\"OBFUSCATION_BINARY_FILE\",\"category\":\"malware\",\"analyzer\":\"static\",\"metadata\":{}}]");
        history.add(warning); history.add(audit(false));
        var page = service.securityAudits(7L, 11L, "global", "demo", 1, 1);
        assertThat(page.items()).hasSize(1); assertThat(page.total()).isEqualTo(2);
        assertThat(page.blocked()).isFalse(); assertThat(page.artifactAvailable()).isTrue();
    }

    @Test
    void rejectsMissingBundleYankedVersionAndWrongCoordinateWithoutOpeningAnyObject() {
        when(storage.exists(KEY)).thenReturn(false);
        assertThat(service.securityAudits(7L, 11L, "global", "demo", 0, 100).artifactAvailable()).isFalse();
        assertThatThrownBy(() -> service.artifact(7L, 11L, "global", "demo")).hasMessageContaining("unavailable");
        when(storage.exists(KEY)).thenReturn(true);
        version.setYankedAt(Instant.now());
        assertThatThrownBy(() -> service.artifact(7L, 11L, "global", "demo")).hasMessageContaining("unavailable");
        assertThatThrownBy(() -> service.artifact(7L, 11L, "global", "other")).hasMessageContaining("identity changed");
        verify(storage, never()).getObject(anyString());
    }

    @Test
    void rejectsMismatchedVersionIdentityAndInvalidPage() {
        ReflectionTestUtils.setField(version, "skillId", 9L);
        assertThatThrownBy(() -> service.securityAudits(7L, 11L, "global", "demo", 0, 100)).hasMessageContaining("not found");
        assertThatThrownBy(() -> service.securityAudits(7L, 11L, "global", "demo", 0, 101)).hasMessageContaining("page");
    }

    @Test
    void unknownDeletionIsNotCompletionAndExistingReceiptNeverDeletesAReusedCoordinate() {
        when(cleanup.deletionReceipts(7L)).thenReturn(List.of());
        assertThatThrownBy(() -> service.deletionStatus(7L)).hasMessageContaining("unknown");
        var receipt = new SkillStorageDeletionCompensation(7L, "", "", "[]", null);
        when(cleanup.deletionReceipts(7L)).thenReturn(List.of(receipt));
        assertThat(service.deletionStatus(7L).state()).isEqualTo("pending");
        receipt.markCompleted();
        assertThat(service.deletionStatus(7L).state()).isEqualTo("completed");
        assertThat(service.deletionStatus(7L).completedAt()).isNotNull();
        service.deleteArtifact(7L, "reused", "coordinate", "publisher", new AuditRequestContext(null,null));
        verify(hardDelete, never()).hardDeleteSkill(any(),any(),any(),any(),any());
    }

    @Test
    void exactIdentityCleanupAcceptsArchivedSkillWhileArtifactReadStaysBlocked() {
        skill.setStatus(SkillStatus.ARCHIVED);
        var context = new AuditRequestContext(null,null);
        assertThatThrownBy(() -> service.artifact(7L,11L,"global","demo")).hasMessageContaining("inactive");
        assertThatThrownBy(() -> service.deleteArtifact(7L,"global","other","admin",context)).hasMessageContaining("identity changed");
        service.deleteArtifact(7L,"global","demo","admin",context);
        verify(hardDelete).hardDeleteSkill(skill,"global","admin",null,null);
        assertThat(skill.getStatus()).isEqualTo(SkillStatus.ARCHIVED);
    }

    @Test
    void coordinateProjectionRejectsAmbiguityAndExpectedIdMismatchWithoutPortalAcl() {
        var query = mock(TypedQuery.class, RETURNS_SELF);
        when(entities.createQuery(startsWith("select s "), eq(Skill.class))).thenReturn(query);
        when(query.getResultList()).thenReturn(List.of(skill));
        var metadata = service.metadata("global","demo",7L,null);
        assertThat(metadata.id()).isEqualTo(7L);
        assertThat(metadata.status()).isEqualTo(SkillStatus.ACTIVE);
        assertThatThrownBy(() -> service.metadata("global","demo",99L,null)).hasMessageContaining("identity changed");
        assertThatThrownBy(() -> service.metadata("global","demo",null,"13a838a5-3f6a-4470-922c-c21d792dfd4d"))
                .hasMessageContaining("identity changed");
        when(query.getResultList()).thenReturn(List.of(skill,skill));
        assertThatThrownBy(() -> service.metadata("global","demo",null,null)).hasMessageContaining("identity changed");
        when(query.getResultList()).thenReturn(List.of());
        assertThatThrownBy(() -> service.metadata("global","demo",null,null)).hasMessageContaining("not found");
    }

    @Test
    void immutableIdVersionProjectionPreservesPageAndCoordinateBoundaries() {
        var query = mock(TypedQuery.class, RETURNS_SELF);
        when(entities.createQuery(startsWith("select v "), eq(SkillVersion.class))).thenReturn(query);
        when(query.getResultList()).thenReturn(List.of(version));
        when(countQuery.setParameter(eq("id"),any())).thenReturn(countQuery);
        when(countQuery.getSingleResult()).thenReturn(1L);
        var page = service.versions(7L,"global","demo",0,100);
        assertThat(page.total()).isEqualTo(1);
        assertThat(page.items().getFirst().id()).isEqualTo(11L);
        assertThatThrownBy(() -> service.versions(7L,"global","other",0,100)).hasMessageContaining("identity changed");
        assertThatThrownBy(() -> service.versions(7L,"global","demo",0,101)).hasMessageContaining("page");
    }

    private SecurityAudit audit(boolean malicious) {
        SecurityAudit audit = new SecurityAudit(11L, ScannerType.SKILL_SCANNER);
        ReflectionTestUtils.setField(audit, "id", (long) history.size()+1);
        audit.setScannedAt(Instant.now()); audit.setIsSafe(!malicious);
        if (malicious) audit.setFindings("[{\"ruleId\":\"VIRUSTOTAL_MALICIOUS_FILE\",\"category\":\"malware\",\"analyzer\":\"virustotal\",\"metadata\":{\"file_hash\":\"" + "a".repeat(64) + "\"}}]");
        return audit;
    }
}
