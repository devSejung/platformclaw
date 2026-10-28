# syntax=docker/dockerfile:1.7
# The source archive and build toolchain are immutable inputs to the private patch.
FROM maven:3.9-eclipse-temurin-21@sha256:99e61abcff91a9b1333463bd8451fb18495d6eba9250ac66a338b518f8278320 AS build
WORKDIR /source
ADD --checksum=sha256:de66167863d258888316cc54875e31a96150410afa7dbfa7782ccd7fe0e3beab https://codeload.github.com/iflytek/skillhub/tar.gz/6e133c006e492dc3f468d91b21960aff1d577150 /tmp/upstream.tar.gz
RUN tar -xzf /tmp/upstream.tar.gz --strip-components=1
COPY upstream.patch upstream-tests.patch artifact-policy.patch artifact-tests.patch /tmp/
RUN git apply --unidiff-zero --check /tmp/upstream.patch && git apply --unidiff-zero /tmp/upstream.patch && git apply --unidiff-zero /tmp/upstream-tests.patch && git apply --unidiff-zero --check /tmp/artifact-policy.patch && git apply --unidiff-zero /tmp/artifact-policy.patch && git apply --unidiff-zero /tmp/artifact-tests.patch
COPY overlay/ /source/
WORKDIR /source/server
RUN --mount=type=cache,target=/root/.m2 mvn -B -pl skillhub-app -am package -DskipTests

# This is the exact JRE base beneath the pinned upstream server on both Linux
# architectures. Starting there avoids retaining its original and chowned JARs.
FROM eclipse-temurin:21.0.11_10-jre-alpine-3.23@sha256:3f08b13888f595cc49edabea7250ba69499ba25602b267da591720769400e08c AS runtime
RUN addgroup -S -g 101 app && adduser -S -u 100 app -G app && \
    mkdir -p /app /var/lib/skillhub/storage && \
    chown app:app /app /var/lib/skillhub/storage
WORKDIR /app
COPY --from=build --chown=app:app /source/server/skillhub-app/target/skillhub-app-0.1.0.jar /app/app.jar
USER app
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --retries=12 \
  CMD wget -qO- http://localhost:8080/actuator/health || exit 1
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75.0", "-jar", "app.jar"]
LABEL org.opencontainers.image.base.name="docker.io/library/eclipse-temurin:21.0.11_10-jre-alpine-3.23" \
      org.opencontainers.image.base.digest="sha256:3f08b13888f595cc49edabea7250ba69499ba25602b267da591720769400e08c" \
      org.opencontainers.image.created="2026-08-07T05:49:13.659Z" \
      org.opencontainers.image.description="Self-hosted, open-source agent skill registry for enterprises. Publish & version skill packages, govern with RBAC and audit logs, deploy   on-premise with Docker or Kubernetes." \
      org.opencontainers.image.source="https://github.com/iflytek/skillhub" \
      org.opencontainers.image.revision="6e133c006e492dc3f468d91b21960aff1d577150" \
      org.opencontainers.image.title="skillhub" \
      org.opencontainers.image.url="https://github.com/iflytek/skillhub" \
      org.opencontainers.image.version="0.2.16" \
      org.opencontainers.image.licenses="Apache-2.0" \
      ai.platformclaw.skillhub.patch="artifact-policy-v1"
