package com.iflytek.skillhub.domain.skill.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iflytek.skillhub.domain.namespace.*;
import com.iflytek.skillhub.domain.review.ReviewTaskRepository;
import com.iflytek.skillhub.domain.security.SecurityScanService;
import com.iflytek.skillhub.domain.shared.exception.DomainBadRequestException;
import com.iflytek.skillhub.domain.shared.exception.DomainForbiddenException;
import com.iflytek.skillhub.domain.skill.*;
import com.iflytek.skillhub.domain.skill.metadata.*;
import com.iflytek.skillhub.domain.skill.validation.*;
import com.iflytek.skillhub.storage.ObjectStorageService;
import java.io.ByteArrayInputStream;
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
        final SkillPackageValidator packages = mock(SkillPackageValidator.class);
        final SkillMetadataParser parser = mock(SkillMetadataParser.class);
        final PrePublishValidator preflight = mock(PrePublishValidator.class);
        final ReviewTaskRepository reviews = mock(ReviewTaskRepository.class);
        final jakarta.persistence.EntityManager entities = mock(jakarta.persistence.EntityManager.class);
        final jakarta.persistence.TypedQuery<Skill> origins = mock(jakarta.persistence.TypedQuery.class, RETURNS_SELF);
        final Namespace namespace = new Namespace("proof", "Proof", "owner");
        final SkillPublishService service;
        final Skill skill = new Skill(1L, "demo", "owner", SkillVisibility.PRIVATE);
        final List<PackageEntry> entries = List.of(new PackageEntry("SKILL.md", "body".getBytes(), 4, "text/markdown"));

        Fixture() throws Exception {
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
                    reviews, scanner, mock(SkillStorageDeletionCompensationService.class),
                    mock(ApplicationEventPublisher.class), Clock.systemUTC());
            var manager = SkillPublishService.class.getDeclaredField("platformclawEntityManager");
            manager.setAccessible(true); manager.set(service, entities);
            when(entities.createQuery(anyString(), eq(Skill.class))).thenReturn(origins);
            when(origins.getResultList()).thenReturn(List.of());
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

    @Test void managedUpdatesKeepLegacyIdentityMetadataVisibilityAndPendingReviews() throws Exception {
        for (var visibility : SkillVisibility.values()) {
            var f = managedFixture();
            f.skill.setVisibility(visibility);
            f.skill.setPlatformclawRequestedVisibility(SkillVisibility.PUBLIC);
            f.skill.setDisplayName("Edited title");
            f.skill.setSummary("Edited summary");
            byte[] zip = new byte[]{80, 75, 3, 4, 9, 8, 7};
            var original = new ByteArrayInputStream(zip);
            var result = f.service.publishManagedFromEntries("proof", f.entries, "rotated-service",
                    Set.of("SUPER_ADMIN"), 2L, original, zip.length);
            assertThat(result.skillId()).isEqualTo(2L);
            assertThat(result.version().getVersion()).isEqualTo("1.0.0");
            assertThat(result.version().getRequestedVisibility()).isEqualTo(SkillVisibility.PRIVATE);
            assertThat(result.version().getStatus()).isEqualTo(SkillVersionStatus.PUBLISHED);
            assertThat(f.skill.getOwnerId()).isEqualTo("owner");
            assertThat(f.skill.getVisibility()).isEqualTo(visibility);
            assertThat(f.skill.getPlatformclawDesiredVisibility()).isEqualTo(SkillVisibility.PUBLIC);
            assertThat(f.skill.getDisplayName()).isEqualTo("Edited title");
            assertThat(f.skill.getSummary()).isEqualTo("Edited summary");
            verify(f.storage).putObject("packages/2/3/bundle.zip", original, zip.length, "application/zip");
            assertThat(original.readAllBytes()).containsExactly(zip);
            verify(f.scanner).triggerScan(3L, f.entries, "rotated-service");
            verify(f.versions, never()).findBySkillIdAndStatus(any(), any());
            verifyNoInteractions(f.reviews);
        }
    }

    @Test void managedCreationAcceptsHeuristicWarningsButDoesNotAdoptAnotherCoordinate() throws Exception {
        String operation = "13a838a5-3f6a-4470-922c-c21d792dfd4d";
        String namespaceSlug = "pc-" + operation;
        var f = managedFixture();
        var namespace = new Namespace(namespaceSlug, namespaceSlug, "owner");
        namespace.setDescription("PlatformClaw namespace operation:" + operation);
        id(namespace, 1L);
        when(f.namespaces.findBySlug(namespaceSlug)).thenReturn(Optional.of(namespace));
        when(f.skills.findByNamespaceIdAndSlug(1L, "demo")).thenReturn(List.of());
        when(f.skills.save(any(Skill.class))).thenAnswer(invocation -> {
            Skill saved = invocation.getArgument(0);
            if (saved.getId() == null) id(saved, 2L);
            when(f.skills.findById(2L)).thenReturn(Optional.of(saved));
            return saved;
        });
        when(f.packages.validate(f.entries)).thenReturn(ValidationResult.warn(List.of("Unusual extension")));
        when(f.preflight.validate(any())).thenReturn(ValidationResult.warn(List.of("Synthetic token-like identifier")));
        Long reservedId = f.service.reserveManagedIdentity(namespaceSlug, "demo", operation, "owner", Set.of("SUPER_ADMIN"));
        assertThat(reservedId).isEqualTo(2L);
        verify(f.skills).flush();
        verifyNoInteractions(f.storage, f.packages, f.preflight, f.scanner);
        var result = f.service.publishManagedFromEntries(namespaceSlug, f.entries, "owner",
                Set.of("SUPER_ADMIN"), reservedId, new ByteArrayInputStream(new byte[]{1}), 1);
        assertThat(result.skillId()).isEqualTo(2L);
        assertThat(result.version().getStatus()).isEqualTo(SkillVersionStatus.PUBLISHED);
        verify(f.scanner).triggerScan(3L, f.entries, "owner");

        Skill reserved = f.skills.findById(2L).orElseThrow();
        assertThat(reserved.getPlatformclawManagedPublicationId()).isEqualTo(operation);
        when(f.skills.findByNamespaceIdAndSlug(1L, "demo")).thenReturn(List.of(reserved));
        assertThat(f.service.reserveManagedIdentity(namespaceSlug, "demo", operation, "rotated-service", Set.of("SUPER_ADMIN")))
                .isEqualTo(reservedId);
        when(f.skills.findByNamespaceIdAndSlug(1L, "demo")).thenReturn(List.of(f.skill));
        clearInvocations(f.versions, f.storage);
        assertThatThrownBy(() -> f.service.reserveManagedIdentity(namespaceSlug, "demo", operation, "owner", Set.of("SUPER_ADMIN")))
                .isInstanceOf(PlatformclawPublicationConflict.class);
        verify(f.versions, never()).save(any());
        verifyNoInteractions(f.storage);
    }

    @Test void managedCreationRejectsUnownedNamespaceAndUpdatesRequireExactIdentity() throws Exception {
        var f = managedFixture();
        assertThatThrownBy(() -> f.service.reserveManagedIdentity("proof", "demo", "13a838a5-3f6a-4470-922c-c21d792dfd4d", "owner", Set.of("SUPER_ADMIN")))
                .isInstanceOf(PlatformclawPublicationConflict.class);
        assertThatThrownBy(() -> f.service.publishManagedFromEntries("proof", f.entries, "owner",
                Set.of("SUPER_ADMIN"), 99L, new ByteArrayInputStream(new byte[]{1}), 1))
                .isInstanceOf(PlatformclawPublicationConflict.class);
        var other = new Skill(9L, "demo", "owner", SkillVisibility.PRIVATE);
        id(other, 2L);
        when(f.skills.findById(2L)).thenReturn(Optional.of(other));
        assertThatThrownBy(() -> f.service.publishManagedFromEntries("proof", f.entries, "owner",
                Set.of("SUPER_ADMIN"), 2L, new ByteArrayInputStream(new byte[]{1}), 1))
                .isInstanceOf(PlatformclawPublicationConflict.class);
        var differentSlug = new Skill(1L, "another", "owner", SkillVisibility.PRIVATE);
        id(differentSlug, 2L);
        when(f.skills.findById(2L)).thenReturn(Optional.of(differentSlug));
        assertThatThrownBy(() -> f.service.publishManagedFromEntries("proof", f.entries, "owner",
                Set.of("SUPER_ADMIN"), 2L, new ByteArrayInputStream(new byte[]{1}), 1))
                .isInstanceOf(PlatformclawPublicationConflict.class);
        verify(f.versions, never()).save(any());
        verifyNoInteractions(f.storage);
    }

    @Test void managedUpdatesIgnoreRetiredNamespaceLifecycleWithoutRevivingArchivedSkills() throws Exception {
        for (var status : List.of(NamespaceStatus.FROZEN, NamespaceStatus.ARCHIVED)) {
            var f = managedFixture();
            f.namespace.setStatus(status);
            assertThatThrownBy(() -> f.service.publishFromEntries("proof", f.entries, "owner",
                    SkillVisibility.PRIVATE, Set.of("SUPER_ADMIN"))).isInstanceOf(DomainBadRequestException.class);
            verifyNoInteractions(f.storage);
            assertThat(f.service.publishManagedFromEntries("proof", f.entries, "rotated-service",
                    Set.of("SUPER_ADMIN"), 2L, new ByteArrayInputStream(new byte[]{1}), 1).skillId()).isEqualTo(2L);
            assertThat(f.namespace.getStatus()).isEqualTo(status);
        }
        var archived = managedFixture();
        archived.skill.setStatus(SkillStatus.ARCHIVED);
        assertThatThrownBy(() -> archived.service.publishManagedFromEntries("proof", archived.entries, "owner",
                Set.of("SUPER_ADMIN"), 2L, new ByteArrayInputStream(new byte[]{1}), 1))
                .isInstanceOf(DomainBadRequestException.class);
        assertThat(archived.skill.getStatus()).isEqualTo(SkillStatus.ARCHIVED);
        verifyNoInteractions(archived.storage);
    }

    @Test void managedPublicationNeverReplacesExistingVersionOrRelaxesPackageValidation() throws Exception {
        for (var status : SkillVersionStatus.values()) {
            var f = managedFixture();
            var version = new SkillVersion(2L, "1.0.0", "owner");
            version.setStatus(status);
            when(f.versions.findBySkillIdAndVersion(2L, "1.0.0")).thenReturn(Optional.of(version));
            assertThatThrownBy(() -> f.service.publishManagedFromEntries("proof", f.entries, "owner",
                    Set.of("SUPER_ADMIN"), 2L, new ByteArrayInputStream(new byte[]{1}), 1))
                    .isInstanceOf(DomainBadRequestException.class);
            verify(f.versions, never()).save(any());
            verify(f.versions, never()).delete(any());
            verifyNoInteractions(f.storage);
        }
        var invalid = managedFixture();
        when(invalid.packages.validate(invalid.entries)).thenReturn(ValidationResult.fail(List.of("Unsafe archive")));
        assertThatThrownBy(() -> invalid.service.publishManagedFromEntries("proof", invalid.entries, "owner",
                Set.of("SUPER_ADMIN"), 2L, new ByteArrayInputStream(new byte[]{1}), 1))
                .isInstanceOf(DomainBadRequestException.class);
        verify(invalid.versions, never()).save(any());
        verifyNoInteractions(invalid.storage);
    }

    @Test void managedDomainBoundaryRequiresSuperAdminAndBoundedOriginalArchive() throws Exception {
        var f = managedFixture();
        assertThatThrownBy(() -> f.service.publishManagedFromEntries("proof", f.entries, "owner",
                Set.of("USER"), 2L, new ByteArrayInputStream(new byte[]{1}), 1))
                .isInstanceOf(DomainForbiddenException.class);
        for (long size : new long[]{0, 500L * 1024 * 1024 + 1}) {
            assertThatThrownBy(() -> f.service.publishManagedFromEntries("proof", f.entries, "owner",
                    Set.of("SUPER_ADMIN"), 2L, new ByteArrayInputStream(new byte[]{1}), size))
                    .isInstanceOf(DomainBadRequestException.class);
        }
        assertThatThrownBy(() -> f.service.publishManagedFromEntries("proof", f.entries, "owner",
                Set.of("SUPER_ADMIN"), null, new ByteArrayInputStream(new byte[]{1}), 1))
                .isInstanceOf(PlatformclawPublicationConflict.class);
        assertThatThrownBy(() -> f.service.reserveManagedIdentity("proof", "demo", "13a838a5-3f6a-4470-922c-c21d792dfd4d", "owner", Set.of("USER")))
                .isInstanceOf(DomainForbiddenException.class);
        verify(f.versions, never()).save(any());
        verifyNoInteractions(f.storage);
    }

    @Test void freshReservationRequiresTheOriginalNamespaceCreator() throws Exception {
        String operation = "13a838a5-3f6a-4470-922c-c21d792dfd4d";
        String namespaceSlug = "pc-" + operation;
        var f = managedFixture();
        var namespace = new Namespace(namespaceSlug, namespaceSlug, "owner");
        namespace.setDescription("PlatformClaw namespace operation:" + operation);
        id(namespace, 1L);
        when(f.namespaces.findBySlug(namespaceSlug)).thenReturn(Optional.of(namespace));
        when(f.skills.findByNamespaceIdAndSlug(1L, "demo")).thenReturn(List.of());
        assertThatThrownBy(() -> f.service.reserveManagedIdentity(namespaceSlug, "demo", operation,
                "rotated-service", Set.of("SUPER_ADMIN"))).isInstanceOf(PlatformclawPublicationConflict.class);
        assertThatThrownBy(() -> f.service.reserveManagedIdentity(namespaceSlug, "demo",
                "23a838a5-3f6a-4470-922c-c21d792dfd4d", "owner", Set.of("SUPER_ADMIN")))
                .isInstanceOf(PlatformclawPublicationConflict.class);
        verify(f.skills, never()).save(any());
        verifyNoInteractions(f.storage, f.packages, f.preflight, f.scanner);
    }

    private Fixture managedFixture() throws Exception {
        var f = new Fixture();
        when(f.skills.findById(2L)).thenReturn(Optional.of(f.skill));
        when(f.skills.save(any(Skill.class))).thenAnswer(invocation -> invocation.getArgument(0));
        when(f.versions.save(any(SkillVersion.class))).thenAnswer(invocation -> {
            SkillVersion saved = invocation.getArgument(0);
            id(saved, 3L);
            return saved;
        });
        return f;
    }

    private static void id(Object entity, Long value) throws Exception {
        var field = entity.getClass().getDeclaredField("id");
        field.setAccessible(true);
        field.set(entity, value);
    }
}
