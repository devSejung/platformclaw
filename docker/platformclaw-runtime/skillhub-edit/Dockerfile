# syntax=docker/dockerfile:1.7
# The source archive and build toolchain are immutable inputs to the private patch.
FROM maven:3.9-eclipse-temurin-21@sha256:99e61abcff91a9b1333463bd8451fb18495d6eba9250ac66a338b518f8278320 AS build
WORKDIR /source
ADD --checksum=sha256:de66167863d258888316cc54875e31a96150410afa7dbfa7782ccd7fe0e3beab https://codeload.github.com/iflytek/skillhub/tar.gz/6e133c006e492dc3f468d91b21960aff1d577150 /tmp/upstream.tar.gz
RUN tar -xzf /tmp/upstream.tar.gz --strip-components=1
COPY upstream.patch upstream-tests.patch /tmp/
RUN git apply --unidiff-zero --check /tmp/upstream.patch && git apply --unidiff-zero /tmp/upstream.patch && git apply --unidiff-zero /tmp/upstream-tests.patch
COPY overlay/ /source/
WORKDIR /source/server
RUN --mount=type=cache,target=/root/.m2 mvn -B -pl skillhub-app -am package -DskipTests

FROM ghcr.io/iflytek/skillhub-server@sha256:80a22a90c9855224a83663ad069cea80ec42ecb5e44c863b58be2fa2869f75b9 AS runtime
COPY --from=build --chown=app:app /source/server/skillhub-app/target/skillhub-app-0.1.0.jar /app/app.jar
LABEL org.opencontainers.image.base.name="iflytek/skillhub@6e133c006e492dc3f468d91b21960aff1d577150" \
      ai.platformclaw.skillhub.patch="metadata-edit-v1"
