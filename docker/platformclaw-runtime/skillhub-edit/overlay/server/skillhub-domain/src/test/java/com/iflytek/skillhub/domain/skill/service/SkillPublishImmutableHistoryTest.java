package com.iflytek.skillhub.domain.skill.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iflytek.skillhub.domain.namespace.*;
import com.iflytek.skillhub.domain.review.ReviewTaskRepository;
import com.iflytek.skillhub.domain.security.SecurityScanService;
import com.iflytek.skillhub.domain.shared.exception.DomainBadRequestException;
import com.iflytek.skillhub.domain.skill.*;
import com.iflytek.skillhub.domain.skill.metadata.*;
import com.iflytek.skillhub.domain.skill.validation.*;
import com.iflytek.skillhub.storage.ObjectStorageService;
import java.time.Clock;
import java.time.Instant;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.context.ApplicationEventPublisher;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

class SkillPublishImmutableHistoryTest {
    static class Fixture {
        final NamespaceRepository namespaces = mock(NamespaceRepository.class);
        final SkillRepository skills = mock(SkillRepository.class);
        final SkillVersionRepository versions = mock(SkillVersionRepository.class);
        final ObjectStorageService storage = mock(ObjectStorageService.class);
        final SecurityScanService scanner = mock(SecurityScanService.class);
        final SkillPublishService service;
        final Skill skill = new Skill(1L, "demo", "owner", SkillVisibility.PRIVATE);
        final List<PackageEntry> entries = List.of(new PackageEntry("SKILL.md", "body".getBytes(), 4, "text/markdown"));

        Fixture() throws Exception {
            var packages = mock(SkillPackageValidator.class);
            var parser = mock(SkillMetadataParser.class);
            var preflight = mock(PrePublishValidator.class);
            var namespace = new Namespace("proof", "Proof", "owner");
            id(namespace, 1L);
            id(skill, 2L);
            when(namespaces.findBySlug("proof")).thenReturn(Optional.of(namespace));
            when(packages.validate(entries)).thenReturn(ValidationResult.pass());
            when(parser.parse("body")).thenReturn(new SkillMetadata("demo", "Summary", "1.0.0", "Body", Map.of()));
            when(preflight.validate(any())).thenReturn(ValidationResult.pass());
            when(skills.findByNamespaceIdAndSlugAndOwnerId(1L, "demo", "owner")).thenReturn(Optional.of(skill));
            when(skills.findByNamespaceIdAndSlug(1L, "demo")).thenReturn(List.of(skill));
            when(scanner.isEnabled()).thenReturn(true);
            service = new SkillPublishService(namespaces, mock(NamespaceMemberRepository.class), skills, versions,
                    mock(SkillFileRepository.class), storage, packages, parser, preflight, new ObjectMapper(),
                    mock(ReviewTaskRepository.class), scanner, mock(SkillStorageDeletionCompensationService.class),
                    mock(ApplicationEventPublisher.class), Clock.systemUTC());
        }
    }

    @Test void temporaryLifecycleStatesNeverReplaceAnEverPublishedRelease() throws Exception {
        for (var state : List.of(SkillVersionStatus.SCANNING, SkillVersionStatus.SCAN_FAILED,
                SkillVersionStatus.UPLOADED, SkillVersionStatus.REJECTED)) {
            var f = new Fixture();
            var version = new SkillVersion(2L, "1.0.0", "owner");
            id(version, 3L);
            version.setStatus(state);
            version.setPublishedAt(Instant.parse("2026-01-01T00:00:00Z"));
            when(f.versions.findBySkillIdAndVersion(2L, "1.0.0")).thenReturn(Optional.of(version));
            var dryRun = f.service.validateOnly("proof", f.entries, "owner", SkillVisibility.PRIVATE, Set.of("SUPER_ADMIN"));
            assertThat(dryRun.valid()).isFalse();
            assertThat(dryRun.errors()).contains("Version already published: 1.0.0");
            assertThatThrownBy(() -> f.service.publishFromEntries("proof", f.entries, "owner", SkillVisibility.PRIVATE,
                    Set.of("SUPER_ADMIN"))).isInstanceOf(DomainBadRequestException.class);
            verify(f.versions, never()).delete(any());
            verify(f.versions, never()).save(any());
            verifyNoInteractions(f.storage);
            verify(f.scanner, never()).softDeleteByVersionId(anyLong());
        }
    }

    @Test void uneditedAudienceChangesRequireTheCanonicalMetadataWorkflow() throws Exception {
        var f = new Fixture();
        assertThat(f.skill.isPlatformclawManagedMetadata()).isFalse();
        var dryRun = f.service.validateOnly("proof", f.entries, "owner", SkillVisibility.PUBLIC, Set.of("SUPER_ADMIN"));
        assertThat(dryRun.valid()).isFalse();
        assertThat(dryRun.errors()).contains("Complete registry visibility review or edit visibility before publishing a version");
        assertThatThrownBy(() -> f.service.publishFromEntries("proof", f.entries, "owner", SkillVisibility.PUBLIC,
                Set.of("SUPER_ADMIN"))).isInstanceOf(PlatformclawVisibilityConflict.class);
        verify(f.versions, never()).save(any());
        verifyNoInteractions(f.storage);
    }

    private static void id(Object entity, Long value) throws Exception {
        var field = entity.getClass().getDeclaredField("id");
        field.setAccessible(true);
        field.set(entity, value);
    }
}
