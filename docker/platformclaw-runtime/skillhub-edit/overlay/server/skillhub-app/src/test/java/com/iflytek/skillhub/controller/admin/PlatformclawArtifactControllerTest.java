package com.iflytek.skillhub.controller.admin;

import static org.mockito.ArgumentMatchers.*;
import static org.mockito.BDDMockito.given;
import static org.mockito.BDDMockito.willThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import com.iflytek.skillhub.TestRedisConfig;
import com.iflytek.skillhub.auth.device.DeviceAuthService;
import com.iflytek.skillhub.auth.rbac.PlatformPrincipal;
import com.iflytek.skillhub.domain.namespace.NamespaceMemberRepository;
import com.iflytek.skillhub.domain.security.ScanTaskProducer;
import com.iflytek.skillhub.domain.skill.PlatformclawPublicationConflict;
import com.iflytek.skillhub.domain.skill.SkillVersion;
import com.iflytek.skillhub.domain.skill.SkillVersionStatus;
import com.iflytek.skillhub.domain.skill.SkillVisibility;
import com.iflytek.skillhub.domain.skill.SkillStatus;
import com.iflytek.skillhub.domain.skill.service.SkillPublishService;
import com.iflytek.skillhub.service.PlatformclawArtifactService;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.context.annotation.Import;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Import(TestRedisConfig.class)
class PlatformclawArtifactControllerTest {
    @Autowired private MockMvc mvc;
    @MockBean private PlatformclawArtifactService service;
    @MockBean private SkillPublishService publisher;
    @MockBean private ScanTaskProducer producer;
    @MockBean private NamespaceMemberRepository members;
    @MockBean private DeviceAuthService devices;
    private static final String BASE = "/api/v1/admin/platformclaw/skills/7";
    private static final String PUBLISH = "/api/v1/admin/platformclaw/skills/publish";

    @Test
    void managedPublicationRequiresSuperAdminAndExistingSessionCsrf() throws Exception {
        var file = new MockMultipartFile("file", "demo.zip", "application/zip", archive("SKILL.md"));
        mvc.perform(multipart(PUBLISH).file(file).param("namespace", "proof").param("expectedSkillId", "7").with(csrf()))
                .andExpect(status().isUnauthorized());
        mvc.perform(multipart(PUBLISH).file(file).param("namespace", "proof").param("expectedSkillId", "7").with(actor(false)).with(csrf()))
                .andExpect(status().isForbidden());
        mvc.perform(multipart(PUBLISH).file(file).param("namespace", "proof").param("expectedSkillId", "7").with(actor(true)))
                .andExpect(status().isUnauthorized());
        verify(publisher, never()).publishManagedFromEntries(any(), anyList(), any(), anySet(), any(), any(), anyLong());
        verify(publisher, never()).reserveManagedIdentity(any(), any(), any(), any(), anySet());
    }

    @Test
    void identityReservationUsesTheExistingAdministrativeSessionAndCsrfBoundary() throws Exception {
        String operation = "13a838a5-3f6a-4470-922c-c21d792dfd4d";
        String namespace = "pc-" + operation;
        String route = "/api/v1/admin/platformclaw/skills/identities";
        String body = "{\"namespace\":\"" + namespace + "\",\"slug\":\"demo\",\"publicationId\":\"" + operation + "\"}";
        mvc.perform(post(route).contentType("application/json").content(body).with(csrf()))
                .andExpect(status().isUnauthorized());
        mvc.perform(post(route).contentType("application/json").content(body).with(actor(false)).with(csrf()))
                .andExpect(status().isForbidden());
        mvc.perform(post(route).contentType("application/json").content(body).with(actor(true)))
                .andExpect(status().isUnauthorized());
        given(publisher.reserveManagedIdentity(namespace,"demo",operation,"proof",Set.of("SUPER_ADMIN"))).willReturn(7L);
        given(service.metadata(namespace,"demo",7L,operation)).willReturn(new PlatformclawArtifactService.Metadata(
                7L,namespace,"demo","demo","",SkillVisibility.PRIVATE,SkillStatus.ACTIVE));
        mvc.perform(post(route).contentType("application/json").content(body).with(actor(true)).with(csrf()))
                .andExpect(status().isOk()).andExpect(jsonPath("$.data.id").value(7))
                .andExpect(jsonPath("$.data.visibility").value("PRIVATE"));
        verify(publisher).reserveManagedIdentity(namespace,"demo",operation,"proof",Set.of("SUPER_ADMIN"));
        verify(publisher, never()).publishManagedFromEntries(any(),anyList(),any(),anySet(),any(),any(),anyLong());
    }

    @Test
    void archivePublicationRequiresItsPreviouslyReservedIdentity() throws Exception {
        var file = new MockMultipartFile("file", "demo.zip", "application/zip", archive("SKILL.md"));
        mvc.perform(multipart(PUBLISH).file(file).param("namespace","proof").with(actor(true)).with(csrf()))
                .andExpect(status().isBadRequest());
        verify(publisher, never()).reserveManagedIdentity(any(),any(),any(),any(),anySet());
        verify(publisher, never()).publishManagedFromEntries(any(),anyList(),any(),anySet(),any(),any(),anyLong());
    }

    @Test
    void privateMetadataAndVersionProjectionRequireAdminAndKeepExactIdentityParameters() throws Exception {
        String metadata = "/api/v1/admin/platformclaw/skills/coordinates/global/artifact-deletion?expectedSkillId=7";
        mvc.perform(get(metadata)).andExpect(status().isUnauthorized());
        mvc.perform(get(metadata).with(actor(false))).andExpect(status().isForbidden());
        given(service.metadata("global","artifact-deletion",7L,null)).willReturn(new PlatformclawArtifactService.Metadata(
                7L,"global","artifact-deletion","Title","Summary",SkillVisibility.PRIVATE,SkillStatus.ARCHIVED));
        mvc.perform(get(metadata).with(actor(true))).andExpect(status().isOk())
                .andExpect(jsonPath("$.data.id").value(7)).andExpect(jsonPath("$.data.status").value("ARCHIVED"))
                .andExpect(jsonPath("$.data.visibility").value("PRIVATE"));
        given(service.versions(7L,"global","demo",0,100)).willReturn(new PlatformclawArtifactService.VersionPage(
                List.of(new PlatformclawArtifactService.VersionMetadata(11L,"1.0.0",SkillVersionStatus.SCANNING,null,1,41L,null)),1));
        mvc.perform(get(BASE + "/artifact/versions?namespace=global&slug=demo").with(actor(true)))
                .andExpect(status().isOk()).andExpect(jsonPath("$.data.total").value(1))
                .andExpect(jsonPath("$.data.items[0].id").value(11))
                .andExpect(jsonPath("$.data.items[0].status").value("SCANNING"));
    }

    @Test
    void managedPublicationRetainsImmutableIdAndMultipartArchiveContract() throws Exception {
        byte[] zip = archive("SKILL.md");
        var file = new MockMultipartFile("file", "demo.zip", "application/zip", zip);
        var version = new SkillVersion(7L, "1.0.1", "proof");
        version.setStatus(SkillVersionStatus.PUBLISHED);
        version.setFileCount(1);
        version.setTotalSize(41L);
        given(publisher.publishManagedFromEntries(eq("global"), anyList(), eq("proof"), eq(Set.of("SUPER_ADMIN")),
                eq(7L), any(InputStream.class), eq((long) zip.length)))
                .willReturn(new SkillPublishService.PublishResult(7L, "demo", version));
        mvc.perform(multipart(PUBLISH).file(file).param("namespace", "global").param("expectedSkillId", "7")
                .with(actor(true)).with(csrf()))
                .andExpect(status().isOk()).andExpect(jsonPath("$.data.skillId").value(7))
                .andExpect(jsonPath("$.data.namespace").value("global"))
                .andExpect(jsonPath("$.data.slug").value("demo"))
                .andExpect(jsonPath("$.data.version").value("1.0.1"));
        verify(publisher).publishManagedFromEntries(eq("global"), argThat(entries -> entries.size() == 1
                && entries.getFirst().path().equals("SKILL.md")), eq("proof"), eq(Set.of("SUPER_ADMIN")),
                eq(7L), any(InputStream.class), eq((long) zip.length));
    }

    @Test
    void managedPublicationRejectsTraversalBeforeDomainMutationAndKeepsIdentityConflictsVisible() throws Exception {
        var invalid = new MockMultipartFile("file", "demo.zip", "application/zip", archive("../escape"));
        mvc.perform(multipart(PUBLISH).file(invalid).param("namespace", "global").param("expectedSkillId", "7").with(actor(true)).with(csrf()))
                .andExpect(status().isBadRequest());
        verify(publisher, never()).publishManagedFromEntries(any(), anyList(), any(), anySet(), any(), any(), anyLong());
        given(publisher.publishManagedFromEntries(any(), anyList(), any(), anySet(), any(), any(), anyLong()))
                .willThrow(new PlatformclawPublicationConflict("Registry skill identity changed"));
        var file = new MockMultipartFile("file", "demo.zip", "application/zip", archive("SKILL.md"));
        mvc.perform(multipart(PUBLISH).file(file).param("namespace", "global").param("expectedSkillId", "7")
                .with(actor(true)).with(csrf())).andExpect(status().isConflict());
    }

    @Test
    void exactArtifactRequiresAdministrativeIdentityAndReturnsOnlyOriginalZip() throws Exception {
        String path = BASE + "/versions/11/artifact?namespace=global&slug=demo";
        mvc.perform(get(path)).andExpect(status().isUnauthorized());
        mvc.perform(get(path).with(actor(false))).andExpect(status().isForbidden());
        verify(service, never()).artifact(any(),any(),any(),any());
        given(service.artifact(7L,11L,"global","demo")).willReturn(new PlatformclawArtifactService.Artifact(new ByteArrayInputStream(new byte[]{1,2,3}),3));
        mvc.perform(get(path).with(actor(true))).andExpect(status().isOk())
                .andExpect(header().string("Cache-Control","private, no-store"))
                .andExpect(content().contentType("application/zip"))
                .andExpect(content().bytes(new byte[]{1,2,3}));
    }

    @Test
    void securityHistoryAndDeletionReceiptRetainExactTypedContract() throws Exception {
        given(service.securityAudits(7L,11L,"global","demo",0,100)).willReturn(new PlatformclawArtifactService.AuditPage(List.of(),0,true,false));
        mvc.perform(get(BASE + "/versions/11/security-audits?namespace=global&slug=demo").with(actor(true)))
                .andExpect(status().isOk()).andExpect(jsonPath("$.data.artifactAvailable").value(true))
                .andExpect(jsonPath("$.data.blocked").value(false)).andExpect(jsonPath("$.data.total").value(0));
        given(service.deletionStatus(7L)).willReturn(new PlatformclawArtifactService.Deletion(7L,"completed",Instant.parse("2026-10-28T00:00:00Z")));
        mvc.perform(get(BASE + "/artifact-deletion").with(actor(true))).andExpect(status().isOk())
                .andExpect(jsonPath("$.data.skillId").value(7)).andExpect(jsonPath("$.data.state").value("completed"))
                .andExpect(jsonPath("$.data.completedAt").value("2026-10-28T00:00:00Z"));
    }

    @Test
    void deletionRequiresCsrfAndNeverTreatsUnknownReceiptAsSuccess() throws Exception {
        String path = BASE + "/artifact?namespace=global&slug=demo";
        // Existing session/CSRF rejection uses the native invalid-session strategy (401).
        mvc.perform(delete(path).with(actor(true))).andExpect(status().isUnauthorized());
        verify(service, never()).deleteArtifact(any(),any(),any(),any(),any());
        given(service.deletionStatus(7L)).willReturn(new PlatformclawArtifactService.Deletion(7L,"pending",null));
        mvc.perform(delete(path).with(actor(true)).with(csrf())).andExpect(status().isOk())
                .andExpect(jsonPath("$.data.state").value("pending"));
        given(service.deletionStatus(7L)).willThrow(new PlatformclawArtifactService.ArtifactFailure(404,"Artifact deletion status is unknown"));
        mvc.perform(get(BASE + "/artifact-deletion").with(actor(true))).andExpect(status().isNotFound());
    }

    @Test
    void zipOnlyDownloadRequestsKeepTypedArtifactFailures() throws Exception {
        String path = BASE + "/versions/11/artifact?namespace=global&slug=demo";
        for (int status : new int[]{404, 409, 410}) {
            willThrow(new PlatformclawArtifactService.ArtifactFailure(status,"Artifact unavailable"))
                    .given(service).artifact(7L,11L,"global","demo");
            mvc.perform(get(path).accept("application/zip").with(actor(true)))
                    .andExpect(status().is(status))
                    .andExpect(content().contentType("application/json"))
                    .andExpect(header().string("Cache-Control","private, no-store"))
                    .andExpect(jsonPath("$.code").value(status));
        }
    }

    private RequestPostProcessor actor(boolean administrator) {
        String role = administrator ? "SUPER_ADMIN" : "USER";
        PlatformPrincipal principal = new PlatformPrincipal("proof", "proof", "proof@example.test", "", "local", Set.of(role));
        return authentication(new UsernamePasswordAuthenticationToken(principal,null,List.of(new SimpleGrantedAuthority("ROLE_" + role))));
    }

    private byte[] archive(String path) throws Exception {
        try (var bytes = new ByteArrayOutputStream(); var zip = new ZipOutputStream(bytes)) {
            zip.putNextEntry(new ZipEntry(path));
            zip.write("---\nname: demo\nversion: 1.0.1\n---\nbody".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            zip.closeEntry();
            zip.finish();
            return bytes.toByteArray();
        }
    }
}
