package com.iflytek.skillhub.domain.security;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iflytek.skillhub.domain.skill.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;

class SecurityScanTaskIdentityTest {
    final SecurityAuditRepository audits = mock(SecurityAuditRepository.class);
    final SkillVersionRepository versions = mock(SkillVersionRepository.class);
    final SecurityScanService service = new SecurityScanService(audits, versions, new ObjectMapper(), "upload", true,
            mock(ScanTaskOutboxRepository.class));

    @Test void oldResultUpdatesOnlyItsAuditWithoutCompletingNewScan() {
        var oldAudit = new SecurityAudit(42L, ScannerType.SKILL_SCANNER, "old");
        var newAudit = new SecurityAudit(42L, ScannerType.SKILL_SCANNER, "new");
        var version = new SkillVersion(9L, "1.0.0", "owner");
        version.setStatus(SkillVersionStatus.SCANNING);
        when(versions.findById(42L)).thenReturn(Optional.of(version));
        when(audits.findByTaskId("old")).thenReturn(Optional.of(oldAudit));
        when(audits.findLatestActiveByVersionIdAndScannerType(42L, ScannerType.SKILL_SCANNER)).thenReturn(Optional.of(newAudit));
        service.processScanResult("old", 42L, ScannerType.SKILL_SCANNER,
                new SecurityScanResponse("remote-generated-id", SecurityVerdict.SAFE, 0, null, List.of(), 0.1));
        assertThat(oldAudit.getScannedAt()).isNotNull();
        assertThat(newAudit.getScannedAt()).isNull();
        assertThat(version.getStatus()).isEqualTo(SkillVersionStatus.SCANNING);
        verify(audits, never()).save(newAudit);
    }

    @Test void oldFailureCannotFailNewScanAndUnknownLegacyDeliveryIsSkipped() {
        var oldAudit = new SecurityAudit(42L, ScannerType.SKILL_SCANNER, "old");
        var newAudit = new SecurityAudit(42L, ScannerType.SKILL_SCANNER, "new");
        var version = new SkillVersion(9L, "1.0.0", "owner");
        version.setStatus(SkillVersionStatus.SCANNING);
        when(versions.findById(42L)).thenReturn(Optional.of(version));
        when(audits.findByTaskId("old")).thenReturn(Optional.of(oldAudit));
        when(audits.findLatestActiveByVersionIdAndScannerType(42L, ScannerType.SKILL_SCANNER)).thenReturn(Optional.of(newAudit));
        service.markTaskFailed("old", 42L);
        assertThat(oldAudit.getFailedAt()).isNotNull();
        assertThat(newAudit.getFailedAt()).isNull();
        assertThat(version.getStatus()).isEqualTo(SkillVersionStatus.SCANNING);
        assertThat(service.shouldProcessTask("unmapped-v16-task")).isFalse();
        verify(versions, never()).save(any());
    }

    @Test void currentFailureRecordsIntentionalTerminalState() {
        var audit = new SecurityAudit(42L, ScannerType.SKILL_SCANNER, "current");
        var version = new SkillVersion(9L, "1.0.0", "owner");
        version.setStatus(SkillVersionStatus.SCANNING);
        when(versions.findById(42L)).thenReturn(Optional.of(version));
        when(audits.findByTaskId("current")).thenReturn(Optional.of(audit));
        when(audits.findLatestActiveByVersionIdAndScannerType(42L, ScannerType.SKILL_SCANNER)).thenReturn(Optional.of(audit));
        service.markTaskFailed("current", 42L);
        assertThat(version.getStatus()).isEqualTo(SkillVersionStatus.SCAN_FAILED);
        assertThat(audit.getFailedAt()).isNotNull();
    }

    @Test void publishedFailureRecordsTerminalAuditWithoutRevokingReleasedVersions() {
        for (var visibility : List.of(SkillVisibility.PRIVATE, SkillVisibility.PUBLIC)) {
            var audit = new SecurityAudit(42L, ScannerType.SKILL_SCANNER, "published");
            var version = new SkillVersion(9L, "1.0.0", "owner");
            version.setStatus(SkillVersionStatus.PUBLISHED);
            version.setRequestedVisibility(visibility);
            when(versions.findById(42L)).thenReturn(Optional.of(version));
            when(audits.findByTaskId("published")).thenReturn(Optional.of(audit));
            when(audits.findLatestActiveByVersionIdAndScannerType(42L, ScannerType.SKILL_SCANNER)).thenReturn(Optional.of(audit));
            service.markTaskFailed("published", 42L);
            assertThat(audit.getFailedAt()).isNotNull();
            assertThat(version.getStatus()).isEqualTo(SkillVersionStatus.PUBLISHED);
            assertThat(service.shouldProcessTask("published")).isFalse();
            service.processScanResult("published", 42L, ScannerType.SKILL_SCANNER,
                    new SecurityScanResponse("late-result", SecurityVerdict.SAFE, 0, null, List.of(), 0.1));
            assertThat(audit.getScannedAt()).isNull();
        }
        verify(versions, never()).save(any());
    }
}
