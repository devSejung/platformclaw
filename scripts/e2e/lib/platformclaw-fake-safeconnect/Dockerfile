FROM python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7

COPY scripts/e2e/lib/platformclaw-fake-safeconnect/requirements.txt /fixture/requirements.txt

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash passwd \
    && rm -rf /var/lib/apt/lists/* \
    && python -m pip install --no-cache-dir --requirement /fixture/requirements.txt \
    && useradd --uid 2001 --home-dir /users/person_one --create-home --shell /bin/bash person_one \
    && useradd --uid 2002 --home-dir /appdata/person_two --create-home --shell /bin/bash person_two

COPY scripts/e2e/lib/platformclaw-fake-safeconnect/server.py /fixture/server.py
COPY scripts/e2e/lib/platformclaw-fake-safeconnect/allocations.json /fixture/allocations.json

ENTRYPOINT ["python", "/fixture/server.py"]
