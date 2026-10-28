# Bundled SkillHub object images

PlatformClaw builds its SkillHub server from `iflytek/skillhub` tag `v0.2.16`, commit
`6e133c006e492dc3f468d91b21960aff1d577150`, with the approved private metadata and artifact-policy
patches in `skillhub-edit/`. The image tag is
`platformclaw-skillhub-server:6e133c006e496f54a14d0510`. Source archive verification,
the reviewed patch, and license provenance are recorded in that directory.
The server runtime base and unchanged bundled dependencies are pinned below:

- server JRE: `eclipse-temurin:21.0.11_10-jre-alpine-3.23@sha256:3f08b13888f595cc49edabea7250ba69499ba25602b267da591720769400e08c`, matching the original server's JRE layers
- scanner: `sha256:45275e86b05fdcec1811d5b47c47a87d0639b75be3197aa5ba3a0ce2977a7815`
- PostgreSQL 16.15 Alpine: `sha256:44c4ee9810eff91f7eab4d822642e01115b1a9eccce4bcbdde7604752d68eac6`
- Redis 7.4.10 Alpine: `sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2`

SkillHub is Copyright 2026 iFlytek Co., Ltd. and licensed under Apache License
2.0. See `SKILLHUB-LICENSE.txt`. The build downloads and verifies upstream source;
the transfer archive includes the resulting server image, without the web UI.
