"""Exercise the real patched Java registry in isolated Linux Docker services."""
import argparse
import concurrent.futures
import hashlib
import http.cookiejar
import http.client
import io
import json
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("image", nargs="?", default="platformclaw-skillhub-server:6e133c006e496f54a14d0510")
parser.add_argument("--managed-only", action="store_true")
parser.add_argument("--node-import", default="tsx", help="Installed tsx loader specifier for the production Node HTTP client proof")
arguments = parser.parse_args()
IMAGE = arguments.image
MANAGED_ONLY = arguments.managed_only
PREFIX = "pc-skill-edit-registry-" + secrets.token_hex(4)
containers = []
volumes = []


def docker(*args, check=True):
    result = subprocess.run(["docker", *args], capture_output=True, text=True, check=False)
    if check and result.returncode:
        raise RuntimeError(result.stderr.strip())
    return result.stdout.strip()


def start(name, image, *args):
    full = PREFIX + "-" + name
    docker("run", "-d", "--name", full, "--network", PREFIX, *args, image)
    containers.append(full)
    return full


class Client:
    def __init__(self, base):
        self.base = base
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies))

    def request(self, path, method="GET", value=None, expected=200, raw=False, csrf=True):
        headers = {"Accept": "application/json"}
        data = None
        if value is not None:
            data = json.dumps(value).encode()
            headers["Content-Type"] = "application/json"
        if csrf:
            for cookie in self.cookies:
                if cookie.name == "XSRF-TOKEN":
                    headers["X-XSRF-TOKEN"] = urllib.parse.unquote(cookie.value)
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            response = self.opener.open(req, timeout=45)
        except urllib.error.HTTPError as error:
            response = error
        body = response.read()
        if response.status != expected:
            raise AssertionError(f"{method} {path}: expected {expected}, got {response.status}: {body[:500]!r}")
        if raw:
            return body
        result = json.loads(body)
        if expected == 200:
            assert result.get("code") in (0, 200), result
        return result.get("data")

    def publish(self, namespace, version="1.0.0", visibility="PRIVATE", expected=200, token=None):
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as out:
            out.writestr("SKILL.md", f"---\nname: edit-proof\ndescription: Original package summary\nversion: {version}\n---\nFollow these instructions.\n")
        boundary = "proof-" + secrets.token_hex(8)
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="visibility"\r\n\r\n{visibility}\r\n'
                f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="proof.zip"\r\nContent-Type: application/zip\r\n\r\n').encode()
        body += archive.getvalue() + f"\r\n--{boundary}--\r\n".encode()
        headers = {"Content-Type": "multipart/form-data; boundary=" + boundary}
        if token:
            headers["Authorization"] = "Bearer " + token
        headers.update({"X-XSRF-TOKEN": urllib.parse.unquote(c.value) for c in self.cookies if c.name == "XSRF-TOKEN"})
        request = urllib.request.Request(self.base + f"/api/v1/skills/{namespace}/publish", data=body, headers=headers)
        try:
            response = self.opener.open(request, timeout=45)
        except urllib.error.HTTPError as error:
            response = error
        data = json.loads(response.read())
        assert response.status == expected, (response.status, data)
        return data.get("data")

    def reserve_managed(self, namespace, slug="managed-rollback-proof", expected=200):
        return self.request("/api/v1/admin/platformclaw/skills/identities", "POST", {
            "namespace": namespace, "slug": slug, "publicationId": namespace[3:]}, expected=expected)

    def publish_managed(self, namespace, version="1.0.0", skill_id=None, expected=200, slug="managed-rollback-proof"):
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as out:
            out.writestr("SKILL.md", f"---\nname: {slug}\ndescription: Managed rollback proof\nversion: {version}\n---\nFollow these instructions.\n")
            out.writestr("notes.txt", "token=synthetic_identifier_0123456789\n")
        original = archive.getvalue()
        boundary = "proof-" + secrets.token_hex(8)
        # The caller receives the committed identity before any archive request.
        # A lost reservation response can be reconciled by the original UUID.
        if skill_id is None:
            skill_id = self.reserve_managed(namespace, slug)["id"]
        fields = {"namespace": namespace, "expectedSkillId": str(skill_id)}
        body = b"".join((f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n').encode()
                        for key, value in fields.items())
        body += (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="proof.zip"\r\nContent-Type: application/zip\r\n\r\n').encode()
        body += original + f"\r\n--{boundary}--\r\n".encode()
        headers = {"Content-Type": "multipart/form-data; boundary=" + boundary}
        headers.update({"X-XSRF-TOKEN": urllib.parse.unquote(c.value) for c in self.cookies if c.name == "XSRF-TOKEN"})
        request = urllib.request.Request(self.base + "/api/v1/admin/platformclaw/skills/publish", data=body, headers=headers)
        try:
            response = self.opener.open(request, timeout=45)
        except urllib.error.HTTPError as error:
            response = error
        result = json.loads(response.read())
        assert response.status == expected, (response.status, result)
        return result.get("data"), original


def managed_publication_proof(admin, base, password, sql, server):
    registered_client = Client(base)
    registered_client.request("/api/v1/auth/methods")
    registration = registered_client.request("/api/v1/auth/local/register", "POST", {
        "username": "managedrotation", "password": password + "Aa1!", "email": "managedrotation@example.invalid"})

    def namespace():
        operation = str(uuid.uuid4())
        name = "pc-" + operation
        admin.request("/api/v1/namespaces", "POST", {"slug": name, "displayName": name,
            "description": "PlatformClaw namespace operation:" + operation})
        return name, operation

    name, operation = namespace()
    registered_client.reserve_managed(name, expected=403)
    assert sql(f"select count(*) from skill s join namespace n on n.id=s.namespace_id where n.slug='{name}'") == "0"
    admin.request(f"/api/v1/admin/users/{registration['userId']}/role", "PUT", {"role": "SUPER_ADMIN"})
    rotated = Client(base)
    rotated.request("/api/v1/auth/methods")
    rotated.request("/api/v1/auth/direct/login", "POST", {"provider": "local", "username": "managedrotation", "password": password + "Aa1!"})

    def fail_after_file_puts():
        # This actual PostgreSQL commit-path fault is reached after both per-file
        # and original-ZIP PUTs. The separate reserved Skill transaction must survive.
        sql("CREATE FUNCTION pc_managed_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
            "IF EXISTS(SELECT 1 FROM skill_version v JOIN skill s ON s.id=v.skill_id "
            "WHERE v.id=NEW.version_id AND s.slug='managed-rollback-proof') THEN "
            "RAISE EXCEPTION 'synthetic managed outbox fault'; END IF; RETURN NEW; END $$; "
            "CREATE TRIGGER pc_managed_fail BEFORE INSERT ON scan_task_outbox FOR EACH ROW EXECUTE FUNCTION pc_managed_fail();")

    def clear_fault():
        sql("DROP TRIGGER pc_managed_fail ON scan_task_outbox; DROP FUNCTION pc_managed_fail();")

    def stored_files(skill_id):
        return docker("exec", server, "find", f"/var/lib/skillhub/storage/skills/{skill_id}",
                      f"/var/lib/skillhub/storage/packages/{skill_id}", "-type", "f", check=False).splitlines()

    def coordinate(namespace, slug="managed-rollback-proof", skill_id=None, client=admin):
        suffix = "?expectedPublicationId=" + namespace[3:] if skill_id is None else "?expectedSkillId=" + str(skill_id)
        return client.request(f"/api/v1/admin/platformclaw/skills/coordinates/{namespace}/{slug}" + suffix)

    # Fresh namespace ownership cannot be claimed merely by rotating principals.
    fresh_claim, _ = namespace()
    rotated.reserve_managed(fresh_claim, expected=409)
    assert sql(f"select count(*) from skill s join namespace n on n.id=s.namespace_id where n.slug='{fresh_claim}'") == "0"

    # This entry failed before the Native identity/archive effect. The separate
    # reservation supplies a durable ID without manufacturing a package/version.
    empty_name, empty_operation = namespace()
    admin.request(f"/api/v1/admin/platformclaw/skills/coordinates/{empty_name}/managed-rollback-proof?expectedPublicationId={empty_operation}", expected=404)
    empty_id = admin.reserve_managed(empty_name)["id"]
    assert sql(f"select count(*) from skill_version where skill_id={empty_id}") == "0"
    assert not stored_files(empty_id)
    assert coordinate(empty_name, client=rotated)["id"] == empty_id
    empty_deleted = rotated.request(f"/api/v1/admin/platformclaw/skills/{empty_id}/artifact?namespace={empty_name}&slug=managed-rollback-proof", "DELETE")
    assert empty_deleted["state"] == "completed" and not stored_files(empty_id)
    assert rotated.request(f"/api/v1/admin/platformclaw/skills/{empty_id}/artifact-deletion")["state"] == "completed"

    fail_after_file_puts()
    admin.publish_managed(name, expected=500)
    reserved = coordinate(name)
    native_id = reserved["id"]
    assert sql(f"select platformclaw_managed_publication_id from skill where id={native_id}") == operation
    assert sql(f"select count(*) from skill_version where skill_id={native_id}") == "0"
    orphan_files = stored_files(native_id)
    assert len(orphan_files) >= 3, orphan_files
    clear_fault()
    # The immutable origin, rather than a mutable service owner, permits replay.
    assert coordinate(name, client=rotated)["id"] == native_id
    replay, original = rotated.publish_managed(name)
    assert replay["skillId"] == native_id
    version_id = int(sql(f"select id from skill_version where skill_id={native_id} and version='1.0.0'"))
    artifact = f"/api/v1/admin/platformclaw/skills/{native_id}/versions/{version_id}/artifact?namespace={name}&slug=managed-rollback-proof"
    assert rotated.request(artifact, raw=True) == original
    assert len(stored_files(native_id)) > 3  # Failed version's object keys still exist outside metadata.
    rotated.publish_managed(name, expected=400)
    # A marker does not authorize another package name in the reserved namespace.
    rotated.reserve_managed(name, slug="another-managed-skill", expected=409)
    assert sql(f"select count(*) from skill s join namespace n on n.id=s.namespace_id where n.slug='{name}'") == "1"

    # Exact-ID update remains usable in retired native namespace states; portal
    # permissions remain unchanged. A native archived Skill is never revived.
    for index, state in enumerate(("FROZEN", "ARCHIVED"), start=1):
        sql(f"update namespace set status='{state}' where slug='{name}'")
        update, update_zip = rotated.publish_managed(name, f"1.{index}.0", native_id)
        assert update["skillId"] == native_id
        assert coordinate(name, skill_id=native_id, client=rotated)["status"] == "ACTIVE"
        page = rotated.request(f"/api/v1/admin/platformclaw/skills/{native_id}/artifact/versions?namespace={name}&slug=managed-rollback-proof&page=0&size=100")
        assert page["total"] == index + 1
        current = next(v for v in page["items"] if v["version"] == f"1.{index}.0")
        assert rotated.request(f"/api/v1/admin/platformclaw/skills/{native_id}/versions/{current['id']}/artifact?namespace={name}&slug=managed-rollback-proof", raw=True) == update_zip
    rotated.request(f"/api/v1/skills/{name}/managed-rollback-proof", expected=403)
    sql(f"update skill set status='ARCHIVED' where id={native_id}")
    rotated.publish_managed(name, "2.0.0", native_id, expected=400)
    # Stock completed compensation retained content-like names/errors. Whole
    # completion must scrub those records without restarting their expiry clock.
    keeper_name, _ = namespace()
    keeper_id = admin.reserve_managed(keeper_name)["id"]
    sql(f"INSERT INTO skill_storage_delete_compensation(skill_id,namespace,slug,storage_keys_json,status,last_error,updated_at) VALUES ({native_id},'legacy-space','private-title','[\"skills/{native_id}/old/private-file.txt\"]','COMPLETED','private-file.txt failed',CURRENT_TIMESTAMP-INTERVAL '35 days'),({keeper_id},'keep-space','keep-title','[\"skills/{keeper_id}/keep.txt\"]','COMPLETED','keep error',CURRENT_TIMESTAMP-INTERVAL '35 days')")
    legacy_completed_at = sql(f"select updated_at::text from skill_storage_delete_compensation where skill_id={native_id} and not platformclaw_whole_skill and status='COMPLETED'")
    deletion = rotated.request(f"/api/v1/admin/platformclaw/skills/{native_id}/artifact?namespace={name}&slug=managed-rollback-proof", "DELETE")
    assert deletion["state"] == "completed", deletion
    assert not stored_files(native_id)
    assert rotated.request(f"/api/v1/admin/platformclaw/skills/{native_id}/artifact-deletion")["state"] == "completed"
    assert sql(f"select count(*) from skill_storage_delete_compensation where skill_id={native_id} and status='COMPLETED' and (namespace<>'' or slug<>'' or storage_keys_json<>'[]' or last_error is not null)") == "0"
    assert sql(f"select updated_at::text from skill_storage_delete_compensation where skill_id={native_id} and not platformclaw_whole_skill and status='COMPLETED'") == legacy_completed_at
    assert sql(f"select namespace from skill_storage_delete_compensation where skill_id={keeper_id} and status='COMPLETED'") == "keep-space"
    completed_at = sql(f"select updated_at::text from skill_storage_delete_compensation where skill_id={native_id} and platformclaw_whole_skill")
    sql(f"INSERT INTO skill_storage_delete_compensation(skill_id,namespace,slug,storage_keys_json,status,last_error,updated_at) VALUES ({native_id},'legacy-backfill','private-title','[\"old-private-file.txt\"]','COMPLETED','old payload',CURRENT_TIMESTAMP-INTERVAL '10 days')")
    backfill_at = sql(f"select updated_at::text from skill_storage_delete_compensation where skill_id={native_id} and namespace='legacy-backfill'")
    migration = (Path(__file__).parent / "overlay/server/skillhub-app/src/main/resources/db/migration/R__platformclaw_skill_retention.sql").read_text()
    for _ in range(2):
        applied = subprocess.run(["docker", "exec", "-i", pg, "psql", "-U", "skillhub", "-d", "skillhub", "-v", "ON_ERROR_STOP=1"], input=migration, capture_output=True, text=True)
        assert applied.returncode == 0, applied.stderr
    assert sql(f"select count(*) from skill_storage_delete_compensation where skill_id={native_id} and status='COMPLETED' and (namespace<>'' or slug<>'' or storage_keys_json<>'[]' or last_error is not null)") == "0"
    assert sql(f"select updated_at::text from skill_storage_delete_compensation where skill_id={native_id} and platformclaw_whole_skill") == completed_at
    assert sql(f"select count(*) from skill_storage_delete_compensation where skill_id={native_id} and not platformclaw_whole_skill and updated_at::text='{backfill_at}'") == "1"
    assert sql(f"select namespace from skill_storage_delete_compensation where skill_id={keeper_id} and status='COMPLETED'") == "keep-space"


    # Never-completed first publication has no retained version metadata, but its
    # committed identity still owns every orphan byte and permits verified erasure.
    never_name, never_operation = namespace()
    fail_after_file_puts()
    admin.publish_managed(never_name, expected=500)
    never = coordinate(never_name)
    never_id = never["id"]
    assert sql(f"select count(*) from skill_version where skill_id={never_id}") == "0"
    assert sql(f"select platformclaw_managed_publication_id from skill where id={never_id}") == never_operation
    assert len(stored_files(never_id)) >= 3
    clear_fault()
    deletion = rotated.request(f"/api/v1/admin/platformclaw/skills/{never_id}/artifact?namespace={never_name}&slug=managed-rollback-proof", "DELETE")
    assert deletion["state"] == "completed" and not stored_files(never_id)

    for state in ("FROZEN", "ARCHIVED"):
        fresh, _ = namespace()
        sql(f"update namespace set status='{state}' where slug='{fresh}'")
        admin.reserve_managed(fresh, expected=400)
        assert sql(f"select count(*) from skill s join namespace n on n.id=s.namespace_id where n.slug='{fresh}'") == "0"

    return {"ok": True, "proof": ["real PostgreSQL/Spring pre-effect committed identity",
        "post-file-put outbox rollback leaves discoverable origin and no version rows",
        "rotated service replay preserves exact native ID", "byte-identical original ZIP",
        "warnings accepted", "unmarked/different coordinate cannot be adopted", "duplicate version rejected",
        "FROZEN/ARCHIVED namespace exact-ID updates and private read/version/export",
        "portal ACL preserved", "archived Skill publication rejected without revival",
        "archived Skill exact-ID deletion", "prefix cleanup erases rolled-back orphan versions",
        "never-completed first publication receives verified physical deletion receipt",
        "fresh reservations retain active-namespace gate", "lightweight pre-archive identity reservation and empty-artifact verified purge", "fresh creator anti-adoption after principal rotation", "legacy completed cleanup payloads erased at whole completion", "repeatable retention backfill preserves completion clocks and sibling records"]}


try:
    docker("network", "create", PREFIX)
    password = secrets.token_hex(20)
    pg = start("postgres", "platformclaw-skillhub-postgres:44c4ee9810ef", "-e", "POSTGRES_DB=skillhub", "-e", "POSTGRES_USER=skillhub", "-e", "POSTGRES_PASSWORD=" + password)
    redis = start("redis", "platformclaw-skillhub-redis:e7723ff73d96")
    scanner = start("scanner", "platformclaw-skillhub-scanner:6e133c006e49")
    for _ in range(40):
        if "accepting connections" in docker("exec", pg, "pg_isready", "-U", "skillhub", check=False):
            break
        time.sleep(1)
    server = start("server", IMAGE, "-p", "127.0.0.1::8080",
                   "-e", "SPRING_DATASOURCE_URL=jdbc:postgresql://" + pg + ":5432/skillhub",
                   "-e", "SPRING_DATASOURCE_USERNAME=skillhub", "-e", "SPRING_DATASOURCE_PASSWORD=" + password,
                   "-e", "SPRING_DATA_REDIS_HOST=" + redis,
                   "-e", "SKILLHUB_DOWNLOAD_ANON_COOKIE_SECRET=" + secrets.token_hex(32),
                   "-e", "BOOTSTRAP_ADMIN_ENABLED=true", "-e", "BOOTSTRAP_ADMIN_USERNAME=proofadmin",
                   "-e", "BOOTSTRAP_ADMIN_PASSWORD=" + password,
                   "-e", "SKILLHUB_AUTH_DIRECT_ENABLED=true", "-e", "SKILLHUB_SECURITY_SCANNER_ENABLED=true",
                   "-e", "SKILLHUB_SECURITY_SCANNER_MODE=upload", "-e", "SKILLHUB_SECURITY_SCANNER_URL=http://" + scanner + ":8000",
                   "-e", "SKILLHUB_SCANNER_USE_BEHAVIORAL=false",
                   "-e", "STORAGE_BASE_PATH=/var/lib/skillhub/storage",
                   "-e", "SKILLHUB_BUILTIN_SKILLS_ENABLED=false", "-e", "SKILLHUB_SEARCH_SEMANTIC_ENABLED=false")
    port = docker("port", server, "8080/tcp").split(":")[-1]
    base = "http://127.0.0.1:" + port
    for _ in range(90):
        try:
            urllib.request.urlopen(base + "/actuator/health", timeout=2).close()
            break
        except (urllib.error.URLError, TimeoutError, http.client.RemoteDisconnected):
            if docker("inspect", server, "--format", "{{.State.Running}}") != "true":
                raise RuntimeError("Registry exited during startup")
            time.sleep(2)
    else:
        raise RuntimeError("Registry did not become healthy")

    def sql(statement):
        return docker("exec", pg, "psql", "-U", "skillhub", "-d", "skillhub", "-At", "-v", "ON_ERROR_STOP=1", "-c", statement)

    admin = Client(base)
    admin.request("/api/v1/auth/methods")
    admin.request("/api/v1/auth/direct/login", "POST", {"provider": "local", "username": "proofadmin", "password": password})
    if MANAGED_ONLY:
        print(json.dumps(managed_publication_proof(admin, base, password, sql, server)))
        raise SystemExit(0)
    for namespace in ("proof-source", "proof-target", "proof-collision"):
        admin.request("/api/v1/namespaces", "POST", {"slug": namespace, "displayName": namespace, "description": "Registry edit proof"})
    published = admin.publish("proof-source")
    skill_id = published["skillId"]
    before = admin.request("/api/v1/admin/platformclaw/skills/proof-source/edit-proof")
    path = f"/api/v1/admin/platformclaw/skills/{skill_id}"
    edit = {"operationId": str(uuid.uuid4()), "skillId": skill_id, "namespace": "proof-source", "slug": "edit-proof",
            "expectedRevision": before["revision"], "targetNamespace": "proof-target", "displayName": "Edited registry title",
            "summary": "Edited registry summary", "visibility": "PRIVATE"}
    Client(base).request(path, "PATCH", edit, expected=401)
    admin.request(path, "PATCH", edit, expected=403, csrf=False)
    archive_before = admin.request("/api/v1/skills/proof-source/edit-proof/versions/1.0.0/download", raw=True)
    version_before = sql(f"select id from skill_version where skill_id={skill_id}")

    # Inject an actual commit-path fault: neither metadata, index nor receipt may leak.
    sql("CREATE FUNCTION pc_edit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'proof receipt fault'; END $$; CREATE TRIGGER pc_edit_fail BEFORE INSERT ON platformclaw_skill_edit_receipt FOR EACH ROW EXECUTE FUNCTION pc_edit_fail();")
    admin.request(path, "PATCH", edit, expected=500)
    assert admin.request("/api/v1/admin/platformclaw/skills/proof-source/edit-proof") == before
    assert sql(f"select namespace_slug from skill_search_document where skill_id={skill_id}") == "proof-source"
    assert sql("select count(*) from platformclaw_skill_edit_receipt") == "0"
    sql("DROP TRIGGER pc_edit_fail ON platformclaw_skill_edit_receipt; DROP FUNCTION pc_edit_fail();")
    moved = admin.request(path, "PATCH", edit)
    assert moved["id"] == skill_id and moved["namespace"] == "proof-target" and moved["slug"] == "edit-proof"
    assert moved["revision"] != before["revision"]
    # Durable replay must survive a trusted governance administrator rotation.
    rotated_registration = Client(base)
    rotated_registration.request("/api/v1/auth/methods")
    registered = rotated_registration.request("/api/v1/auth/local/register", "POST", {"username": "proofrotatedadmin", "password": password + "Aa1!", "email": "proofrotatedadmin@example.invalid"})
    rotated_registration.request(path, "PATCH", edit, expected=403)
    original_audit = sql(f"select actor_user_id||':'||count(*) from audit_log where request_id='{edit['operationId']}' group by actor_user_id")
    admin.request(f"/api/v1/admin/users/{registered['userId']}/role", "PUT", {"role": "SUPER_ADMIN"})
    rotated_admin = Client(base)
    rotated_admin.request("/api/v1/auth/methods")
    rotated_admin.request("/api/v1/auth/direct/login", "POST", {"provider": "local", "username": "proofrotatedadmin", "password": password + "Aa1!"})
    assert rotated_admin.request(path, "PATCH", edit) == moved
    rotated_admin.request(path, "PATCH", {**edit, "summary": "Changed rotated-admin request"}, expected=409)
    assert sql(f"select actor_user_id||':'||count(*) from audit_log where request_id='{edit['operationId']}' group by actor_user_id") == original_audit
    assert admin.request(path, "PATCH", edit) == moved
    admin.request(path, "PATCH", {**edit, "summary": "Different payload"}, expected=409)
    admin.request(path, "PATCH", {**edit, "operationId": str(uuid.uuid4())}, expected=409)
    admin.request("/api/v1/admin/platformclaw/skills/proof-source/edit-proof", expected=404)
    assert sql(f"select namespace_slug || ':' || title || ':' || summary from skill_search_document where skill_id={skill_id}") == "proof-target:Edited registry title:Edited registry summary"
    assert sql(f"select id from skill_version where skill_id={skill_id}") == version_before
    assert sql("select count(*) from skill") == "1"
    archive_after = admin.request("/api/v1/skills/proof-target/edit-proof/versions/1.0.0/download", raw=True)
    assert archive_after == archive_before
    with zipfile.ZipFile(io.BytesIO(archive_after)) as archive:
        assert "name: edit-proof" in archive.read("SKILL.md").decode()
    admin.publish("proof-target", "1.1.0")
    persisted = admin.request("/api/v1/admin/platformclaw/skills/proof-target/edit-proof")
    assert persisted["displayName"] == moved["displayName"] and persisted["summary"] == moved["summary"]
    admin.publish("proof-target", "1.2.0", "PUBLIC", expected=409)
    freeze = subprocess.Popen(["docker", "exec", "-e", "PGAPPNAME=pc_edit_freeze", pg, "psql", "-U", "skillhub", "-d", "skillhub", "-c", "BEGIN; UPDATE namespace SET status='FROZEN' WHERE slug='proof-target'; SELECT pg_sleep(3); COMMIT;"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    for _ in range(40):
        if sql("select count(*) from pg_stat_activity where application_name='pc_edit_freeze' and wait_event='PgSleep'") == "1":
            break
        time.sleep(0.05)
    else:
        raise AssertionError("Freeze writer did not hold the namespace lock")
    try:
        admin.publish("proof-target", "1.3.0", expected=400)
    finally:
        freeze.communicate(timeout=10)
        sql("update namespace set status='ACTIVE' where slug='proof-target'")
    admin.publish("proof-collision")
    collision = {**edit, "operationId": str(uuid.uuid4()), "namespace": "proof-target", "targetNamespace": "proof-collision", "expectedRevision": persisted["revision"]}
    admin.request(path, "PATCH", collision, expected=409)
    assert admin.request("/api/v1/admin/platformclaw/skills/proof-target/edit-proof") == persisted

    for _ in range(90):
        if sql(f"select count(*) from skill_version v where v.skill_id={skill_id} and not exists(select 1 from security_audit a where a.skill_version_id=v.id and a.deleted_at is null and a.scanned_at is not null)") == "0":
            break
        time.sleep(1)
    else:
        raise AssertionError("Real scanner did not complete the private version audits")

    # Seed a valid pending-review snapshot for the second version; its durable
    # identity must follow a move while the released first-version bytes stay put.
    sql(f"update skill set latest_version_id=(select id from skill_version where skill_id={skill_id} and version='1.0.0') where id={skill_id}; update skill_version set status='PENDING_REVIEW' where skill_id={skill_id} and version='1.1.0'; insert into review_task(skill_version_id,namespace_id,submitted_by) select v.id,s.namespace_id,'docker-admin' from skill_version v join skill s on s.id=v.skill_id where s.id={skill_id} and v.version='1.1.0';")
    review_id = sql(f"select r.id from review_task r join skill_version v on v.id=r.skill_version_id where v.skill_id={skill_id}")

    # Concurrent replay on independent sessions returns exactly one committed result.
    replay = {**collision, "operationId": str(uuid.uuid4()), "targetNamespace": "proof-source"}
    def concurrent_edit(_):
        client = Client(base)
        client.request("/api/v1/auth/methods")
        client.request("/api/v1/auth/direct/login", "POST", {"provider": "local", "username": "proofadmin", "password": password})
        return client.request(path, "PATCH", replay)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(concurrent_edit, range(2)))
    assert results[0] == results[1]
    assert sql(f"select r.id || ':' || n.slug from review_task r join namespace n on n.id=r.namespace_id where r.id={review_id}") == review_id + ":proof-source"
    assert sql(f"select count(*) from platformclaw_skill_edit_receipt where operation_id='{replay['operationId']}'") == "1"
    exact_review = admin.request("/api/v1/admin/platformclaw/skills/proof-source/edit-proof/versions/1.1.0/review")
    assert str(exact_review["id"]) == review_id and exact_review["status"] == "PENDING"
    admin.request(f"/api/v1/reviews/{review_id}/approve", "POST", {"comment": "Private approval regression proof"})
    approved = admin.request("/api/v1/admin/platformclaw/skills/proof-source/edit-proof")
    assert approved["summary"] == moved["summary"] and approved["displayName"] == moved["displayName"]
    assert approved["effectiveVisibility"] == approved["visibility"] == "PRIVATE"

    outsider = Client(base)
    outsider.request("/api/v1/auth/methods")
    outsider.request("/api/v1/auth/local/register", "POST", {"username": "proofoutsider", "password": password + "Aa1!", "email": "proofoutsider@example.invalid"})
    outsider.request("/api/v1/skills/proof-source/edit-proof", expected=403)
    # A legacy private release without an active audit must use the real stored-bundle
    # upload scanner. Its immutable bytes and numeric version identity remain intact.
    sql(f"update security_audit set deleted_at=CURRENT_TIMESTAMP where skill_version_id in (select id from skill_version where skill_id={skill_id} and version='1.0.0')")
    sharing = {**edit, "operationId": str(uuid.uuid4()), "namespace": "proof-source", "targetNamespace": "proof-source", "expectedRevision": approved["revision"], "visibility": "PUBLIC"}
    audit_before = sql("select count(*) from security_audit")
    outbox_before = sql("select count(*) from scan_task_outbox")
    sql("CREATE FUNCTION pc_edit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'proof receipt fault'; END $$; CREATE TRIGGER pc_edit_fail BEFORE INSERT ON platformclaw_skill_edit_receipt FOR EACH ROW EXECUTE FUNCTION pc_edit_fail();")
    admin.request(path, "PATCH", sharing, expected=500)
    time.sleep(6)
    assert sql("select count(*) from security_audit") == audit_before
    assert sql("select count(*) from scan_task_outbox") == outbox_before
    assert admin.request("/api/v1/admin/platformclaw/skills/proof-source/edit-proof")["visibility"] == "PRIVATE"
    sql("DROP TRIGGER pc_edit_fail ON platformclaw_skill_edit_receipt; DROP FUNCTION pc_edit_fail();")
    pending = admin.request(path, "PATCH", sharing)
    assert pending["visibility"] == "PUBLIC" and pending["effectiveVisibility"] == "PRIVATE"
    assert pending["reviewVersions"] == ["1.0.0", "1.1.0"]
    outsider.request("/api/v1/skills/proof-source/edit-proof", expected=403)
    admin.publish("proof-source", "2.0.0", "PUBLIC", expected=409)
    for _ in range(90):
        if sql(f"select count(*) from skill_version where skill_id={skill_id} and status='SCANNING'") == "0":
            break
        time.sleep(1)
    else:
        raise AssertionError("Stored-bundle scan did not complete")
    assert sql(f"select count(*) from security_audit a join skill_version v on v.id=a.skill_version_id where v.skill_id={skill_id} and a.deleted_at is null and a.verdict='SAFE' and a.scanned_at is not null") == "2"
    review_one = sql(f"select r.id from review_task r join skill_version v on v.id=r.skill_version_id where v.skill_id={skill_id} and v.version='1.0.0' and r.status='PENDING'")
    review_two = sql(f"select r.id from review_task r join skill_version v on v.id=r.skill_version_id where v.skill_id={skill_id} and v.version='1.1.0' and r.status='PENDING'")
    # Inject the real persisted in-progress state independently of scanner speed.
    sql(f"update skill_version set status='SCANNING' where skill_id={skill_id} and version='1.1.0'")
    admin.request(f"/api/v1/reviews/{review_two}/approve", "POST", {"comment": "Must reject in-progress scan"}, expected=400)
    sql(f"update skill_version set status='PENDING_REVIEW' where skill_id={skill_id} and version='1.1.0'")
    # Older exact releases stay resolvable behind more than one page of unrelated
    # review history. The registry owns lookup; clients never scan global submissions.
    sql("insert into review_task(skill_version_id,namespace_id,submitted_by,status,reviewed_by,reviewed_at) select v.id,s.namespace_id,'docker-admin','APPROVED','docker-admin',CURRENT_TIMESTAMP from skill_version v join skill s on s.id=v.skill_id join namespace n on n.id=s.namespace_id cross join generate_series(1,101) where n.slug='proof-collision'")
    exact_review = admin.request("/api/v1/admin/platformclaw/skills/proof-source/edit-proof/versions/1.0.0/review")
    assert str(exact_review["id"]) == review_one and exact_review["status"] == "PENDING"
    admin.request(f"/api/v1/reviews/{review_one}/approve", "POST", {"comment": "Shared release approval proof"})
    outsider.request("/api/v1/skills/proof-source/edit-proof")
    admin.publish("proof-source", "1.2.0", "PUBLIC")
    retained_review = admin.request("/api/v1/admin/platformclaw/skills/proof-source/edit-proof/versions/1.1.0/review")
    assert str(retained_review["id"]) == review_two and retained_review["status"] == "PENDING"
    assert sql(f"select status from skill_version where skill_id={skill_id} and version='1.1.0'") == "PENDING_REVIEW"
    for _ in range(90):
        if sql(f"select status from skill_version where skill_id={skill_id} and version='1.2.0'") == "PENDING_REVIEW":
            break
        time.sleep(1)
    else:
        raise AssertionError("New shared version did not finish scanning beside retained historical review")
    admin.request("/api/v1/admin/platformclaw/skills/proof-source/edit-proof/versions/1.2.0/approve-safe", "POST", {"comment": "New version retains independent historical sharing review"})
    current = admin.request("/api/v1/admin/platformclaw/skills/proof-source/edit-proof")
    assert current["summary"] == moved["summary"] and current["effectiveVisibility"] == "PUBLIC"
    assert sql(f"select status from skill_version where skill_id={skill_id} and version='1.1.0'") == "PENDING_REVIEW"
    private = admin.request(path, "PATCH", {**sharing, "operationId": str(uuid.uuid4()), "expectedRevision": current["revision"], "visibility": "PRIVATE"})
    admin.request(f"/api/v1/reviews/{review_two}/approve", "POST", {"comment": "Approval after desired-private edit"})
    current = admin.request("/api/v1/admin/platformclaw/skills/proof-source/edit-proof")
    assert current["visibility"] == current["effectiveVisibility"] == "PRIVATE"
    outsider.request("/api/v1/skills/proof-source/edit-proof", expected=403)
    audit_count = sql("select count(*) from security_audit")
    resharing = admin.request(path, "PATCH", {**sharing, "operationId": str(uuid.uuid4()), "expectedRevision": current["revision"]})
    assert resharing["reviewVersions"] == ["1.1.0"] and resharing["effectiveVisibility"] == "PRIVATE"
    assert sql("select count(*) from security_audit") == audit_count
    review_two = sql(f"select r.id from review_task r join skill_version v on v.id=r.skill_version_id where v.skill_id={skill_id} and v.version='1.1.0' and r.status='PENDING'")
    # Native administrator approval is also the existing explicit-force seam.
    # An unsafe completed result remains approvable by that deliberate decision.
    sql(f"update security_audit set verdict='DANGEROUS',is_safe=false,max_severity='HIGH',findings_count=1 where deleted_at is null and skill_version_id in (select id from skill_version where skill_id={skill_id} and version='1.1.0')")
    admin.request("/api/v1/admin/platformclaw/skills/proof-source/edit-proof/versions/1.1.0/approve-safe", "POST", {"comment": "Stale SAFE observation cannot approve current unsafe audit"}, expected=409)
    admin.request(f"/api/v1/reviews/{review_two}/approve", "POST", {"comment": "Explicit operator force approval of injected unsafe audit"})
    exact_review = admin.request("/api/v1/admin/platformclaw/skills/proof-source/edit-proof/versions/1.1.0/review")
    assert str(exact_review["id"]) == review_two and exact_review["status"] == "APPROVED"
    current = admin.request("/api/v1/admin/platformclaw/skills/proof-source/edit-proof")
    private = admin.request(path, "PATCH", {**sharing, "operationId": str(uuid.uuid4()), "expectedRevision": current["revision"], "visibility": "PRIVATE"})
    restored = admin.request(path, "PATCH", {**sharing, "operationId": str(uuid.uuid4()), "expectedRevision": private["revision"]})
    assert restored["effectiveVisibility"] == "PUBLIC" and restored["reviewVersions"] == []
    assert sql("select count(*) from security_audit") == audit_count
    relocated = admin.request(path, "PATCH", {**sharing, "operationId": str(uuid.uuid4()), "expectedRevision": restored["revision"], "targetNamespace": "proof-target"})
    exact_review = admin.request("/api/v1/admin/platformclaw/skills/proof-target/edit-proof/versions/1.1.0/review")
    assert str(exact_review["id"]) == review_two and exact_review["namespace"] == "proof-target"
    # Managed shared publication through the bootstrap admin token must still
    # enter canonical scanning/review, and the production Node clients consume it.
    admin.publish("proof-target", "3.0.0", "PUBLIC")
    status = sql(f"select status from skill_version where skill_id={skill_id} and version='3.0.0'")
    assert status in ("SCANNING", "PENDING_REVIEW"), status
    for _ in range(90):
        if sql(f"select status from skill_version where skill_id={skill_id} and version='3.0.0'") == "PENDING_REVIEW":
            break
        time.sleep(1)
    else:
        raise AssertionError("Managed shared publication did not reach review after real scan")
    token = admin.request("/api/v1/tokens", "POST", {"name": "native-contract-proof", "scopes": ["skill:read", "skill:publish"]})["token"]
    first_token = rotated_admin.request("/api/v1/tokens", "POST", {"name": "first-shared-contract-proof", "scopes": ["skill:read", "skill:publish"]})["token"]
    admin.request("/api/v1/namespaces", "POST", {"slug": "first-shared-proof", "displayName": "First shared proof", "description": "Default bearer publication proof"})
    first = Client(base).publish("first-shared-proof", visibility="PUBLIC", token=first_token)
    first_id = first["skillId"]
    assert sql(f"select status from skill_version where skill_id={first_id}") in ("SCANNING", "PENDING_REVIEW")
    assert sql(f"select count(*) from review_task r join skill_version v on v.id=r.skill_version_id where v.skill_id={first_id} and r.status='PENDING'") == "1"
    for _ in range(90):
        if sql(f"select status from skill_version where skill_id={first_id}") == "PENDING_REVIEW":
            break
        time.sleep(1)
    else:
        raise AssertionError("First bearer shared publication bypassed review or failed scanning")
    admin.request("/api/v1/admin/platformclaw/skills/first-shared-proof/edit-proof/versions/1.0.0/approve-safe", "POST", {"comment": "First bearer shared publication SAFE proof"})
    assert sql(f"select status from skill_version where skill_id={first_id}") == "PUBLISHED"
    # Native edit/approval remain explicit native API contracts. The employee
    # catalog no longer exposes governance wrappers for these operations.
    native_before = admin.request("/api/v1/admin/platformclaw/skills/proof-target/edit-proof")
    native_request = {"operationId": str(uuid.uuid4()), "skillId": native_before["id"], "namespace": native_before["namespace"],
        "slug": native_before["slug"], "expectedRevision": native_before["revision"], "targetNamespace": native_before["namespace"],
        "displayName": native_before["displayName"], "summary": native_before["summary"], "visibility": native_before["visibility"]}
    native_edited = admin.request(path, "PATCH", native_request)
    assert admin.request(path, "PATCH", native_request) == native_edited
    root = Path(__file__).resolve().parents[3]
    config = {"baseUrl": base, "username": "proofadmin", "password": password}
    node_script = "import assert from 'node:assert/strict';\nimport {createHash} from 'node:crypto';\n"
    node_script += "import {IflytekSkillHubGovernanceClient} from " + json.dumps((root / "packages/platformclaw-control-plane/src/skill-hub-governance-client.ts").as_uri()) + ";\n"
    node_script += "import {IflytekSkillHubAdapter} from " + json.dumps((root / "packages/platformclaw-control-plane/src/skill-hub-adapter.ts").as_uri()) + ";\n"
    node_script += "const client = new IflytekSkillHubGovernanceClient(" + json.dumps(config) + ");\n"
    node_script += "const adapter = new IflytekSkillHubAdapter(" + json.dumps({"baseUrl": base, "token": token, "maxArchiveBytes": 10485760}) + ");\n"
    node_script += "const expected = " + json.dumps({"skillId": skill_id, "versionId": int(sql(f"select id from skill_version where skill_id={skill_id} and version='3.0.0'")),
        "originalVersionId": int(version_before), "summary": native_before["summary"], "archiveSha256": hashlib.sha256(archive_before).hexdigest()}) + ";\n"
    node_script += """
const coordinate = {namespace:'proof-target',slug:'edit-proof'};
const before = await client.getArtifactSkill({...coordinate,expectedSkillId:expected.skillId});
assert.equal(before.id,expected.skillId);
assert.equal(before.summary,expected.summary);
const versions = await client.listArtifactVersions({...coordinate,skillId:before.id});
const current = versions.find(version => version.version === '3.0.0');
assert.equal(current?.id,expected.versionId);
assert.equal(current.status,expectedStatus);
const security = await client.getArtifactSecurity({...coordinate,skillId:before.id,versionId:current.id});
assert.equal(security.blocked,false);
assert.equal(security.artifactAvailable,true);
assert.ok(security.audits.some(audit => audit.verdict === 'SAFE' && audit.scannedAt));
const original = await client.downloadArtifact({...coordinate,skillId:before.id,versionId:expected.originalVersionId});
assert.equal(createHash('sha256').update(original).digest('hex'),expected.archiveSha256);
assert.equal(await client.getArtifactDeletion(before.id),null);
// This raw native adapter status is a separate retained upstream API contract.
assert.equal((await adapter.getVersionState(coordinate.namespace,coordinate.slug,'3.0.0')).status,expectedStatus);
assert.equal((await client.getArtifactSkill({...coordinate,expectedSkillId:before.id})).summary,before.summary);
console.log('production Node private artifact/native adapter HTTP contract passed');
"""
    def node_bridge(expected_status):
        script = "const expectedStatus = " + json.dumps(expected_status) + ";\n" + node_script
        bridge = subprocess.run(["node", "--import", arguments.node_import, "--input-type=module"], input=script, capture_output=True, text=True, cwd=root)
        assert bridge.returncode == 0, bridge.stderr
        assert bridge.stdout.strip() == "production Node private artifact/native adapter HTTP contract passed"

    node_bridge("PENDING_REVIEW")
    approved = admin.request("/api/v1/admin/platformclaw/skills/proof-target/edit-proof/versions/3.0.0/approve-safe", "POST", {"comment": "Native SAFE approval with production private-reader proof"})
    assert approved["status"] == "APPROVED"
    node_bridge("PUBLISHED")
    assert admin.request("/api/v1/admin/platformclaw/skills/proof-target/edit-proof")["summary"] == native_before["summary"]
    # Privacy compensation remains possible after native namespace lifecycle drift,
    # without turning frozen/archived namespaces into general edit capabilities.
    for lifecycle, version in (("FROZEN", "4.0.0"), ("ARCHIVED", "4.1.0")):
        current = admin.request("/api/v1/admin/platformclaw/skills/proof-target/edit-proof")
        if current["visibility"] != "PUBLIC":
            current = admin.request(path, "PATCH", {**sharing, "operationId": str(uuid.uuid4()), "namespace": "proof-target", "targetNamespace": "proof-target", "expectedRevision": current["revision"]})
            for pending_version in current["reviewVersions"]:
                review = admin.request(f"/api/v1/admin/platformclaw/skills/proof-target/edit-proof/versions/{pending_version}/review")
                admin.request(f"/api/v1/reviews/{review['id']}/approve", "POST", {"comment": "Explicit setup approval before inactive namespace privacy proof"})
        admin.publish("proof-target", version, "PUBLIC")
        for _ in range(90):
            if sql(f"select status from skill_version where skill_id={skill_id} and version='{version}'") == "PENDING_REVIEW":
                break
            time.sleep(1)
        else:
            raise AssertionError("Inactive namespace privacy setup did not finish scanning")
        current = admin.request("/api/v1/admin/platformclaw/skills/proof-target/edit-proof")
        restriction = {"operationId": str(uuid.uuid4()), "skillId": skill_id, "namespace": "proof-target", "slug": "edit-proof",
            "expectedRevision": current["revision"], "targetNamespace": "proof-target", "displayName": current["displayName"], "summary": current["summary"], "visibility": "PRIVATE"}
        sql(f"update namespace set status='{lifecycle}' where slug='proof-target'")
        try:
            for invalid in ({"displayName": "Forbidden inactive rename"}, {"summary": "Forbidden inactive summary"}, {"targetNamespace": "proof-source"}, {"visibility": "PUBLIC"}):
                admin.request(path, "PATCH", {**restriction, **invalid, "operationId": str(uuid.uuid4())}, expected=409)
            restricted = admin.request(path, "PATCH", restriction)
            assert restricted["visibility"] == restricted["effectiveVisibility"] == "PRIVATE"
            assert admin.request(path, "PATCH", restriction) == restricted
            outsider.request("/api/v1/skills/proof-target/edit-proof", expected=403)
        finally:
            sql("update namespace set status='ACTIVE' where slug='proof-target'")
        review = admin.request(f"/api/v1/admin/platformclaw/skills/proof-target/edit-proof/versions/{version}/review")
        admin.request(f"/api/v1/reviews/{review['id']}/approve", "POST", {"comment": "Explicit force approval after canonical privacy compensation"})
        after_force = admin.request("/api/v1/admin/platformclaw/skills/proof-target/edit-proof")
        assert after_force["visibility"] == after_force["effectiveVisibility"] == "PRIVATE"
    # Failed private rounds retain immutable bundles but require new durable tasks;
    # an existing unfinished audit must not be mistaken for a runnable scan.
    rotated_admin.request("/api/v1/namespaces", "POST", {"slug": "failed-round-proof", "displayName": "Failed round proof", "description": "Failed scan recovery proof"})
    failed_id = rotated_admin.publish("failed-round-proof")["skillId"]
    rotated_admin.publish("failed-round-proof", "1.1.0")
    for _ in range(90):
        if sql(f"select count(*) from security_audit a join skill_version v on v.id=a.skill_version_id where v.skill_id={failed_id} and a.scanned_at is null") == "0":
            break
        time.sleep(1)
    else:
        raise AssertionError("Failed round setup did not complete its initial scans")
    failed_versions = sql(f"select id||':'||version from skill_version where skill_id={failed_id} order by id")
    failed_archive = rotated_admin.request("/api/v1/skills/failed-round-proof/edit-proof/versions/1.0.0/download", raw=True)
    sql(f"update skill_version set status='SCAN_FAILED' where skill_id={failed_id}; update security_audit set scanned_at=null where skill_version_id in(select id from skill_version where skill_id={failed_id} and version='1.0.0'); update security_audit set deleted_at=CURRENT_TIMESTAMP where skill_version_id in(select id from skill_version where skill_id={failed_id} and version='1.1.0')")
    failed_path = f"/api/v1/admin/platformclaw/skills/{failed_id}"
    failed_current = rotated_admin.request("/api/v1/admin/platformclaw/skills/failed-round-proof/edit-proof")
    failed_edit = {"operationId": str(uuid.uuid4()), "skillId": failed_id, "namespace": "failed-round-proof", "slug": "edit-proof",
        "expectedRevision": failed_current["revision"], "targetNamespace": "failed-round-proof", "displayName": failed_current["displayName"], "summary": failed_current["summary"], "visibility": "PUBLIC"}
    failed_audits = sql("select count(*) from security_audit")
    failed_outbox = sql("select count(*) from scan_task_outbox")
    docker("pause", scanner)
    try:
        failed_shared = rotated_admin.request(failed_path, "PATCH", failed_edit)
        assert failed_shared["visibility"] == "PUBLIC" and failed_shared["effectiveVisibility"] == "PRIVATE"
        assert failed_shared["reviewVersions"] == ["1.0.0", "1.1.0"]
        assert int(sql("select count(*) from security_audit")) == int(failed_audits) + 2
        assert int(sql("select count(*) from scan_task_outbox")) == int(failed_outbox) + 2
        assert sql(f"select count(*) from skill_version where skill_id={failed_id} and status='SCANNING'") == "2"
        outsider.request("/api/v1/skills/failed-round-proof/edit-proof", expected=403)
        rotated_admin.request("/api/v1/admin/platformclaw/skills/failed-round-proof/edit-proof/versions/1.0.0/approve-safe", "POST", {"comment": "Failed scan cannot bypass a new durable round"}, expected=409)
    finally:
        docker("unpause", scanner)
    for _ in range(90):
        if sql(f"select count(*) from skill_version where skill_id={failed_id} and status='PENDING_REVIEW'") == "2":
            break
        time.sleep(1)
    else:
        raise AssertionError("Failed private scans did not finish their fresh durable round")
    for version in ("1.0.0", "1.1.0"):
        rotated_admin.request(f"/api/v1/admin/platformclaw/skills/failed-round-proof/edit-proof/versions/{version}/approve-safe", "POST", {"comment": "Fresh durable failed-round SAFE approval"})
    failed_current = rotated_admin.request("/api/v1/admin/platformclaw/skills/failed-round-proof/edit-proof")
    assert failed_current["visibility"] == failed_current["effectiveVisibility"] == "PUBLIC"
    outsider.request("/api/v1/skills/failed-round-proof/edit-proof")
    assert sql(f"select id||':'||version from skill_version where skill_id={failed_id} order by id") == failed_versions
    assert rotated_admin.request("/api/v1/skills/failed-round-proof/edit-proof/versions/1.0.0/download", raw=True) == failed_archive
    failed_private = rotated_admin.request(failed_path, "PATCH", {**failed_edit, "operationId": str(uuid.uuid4()), "expectedRevision": failed_current["revision"], "visibility": "PRIVATE"})
    for terminal_status in ("YANKED", "REJECTED", "DRAFT"):
        sql(f"update skill_version set status='{terminal_status}' where skill_id={failed_id}")
        receipt_count = sql("select count(*) from platformclaw_skill_edit_receipt")
        rotated_admin.request(failed_path, "PATCH", {**failed_edit, "operationId": str(uuid.uuid4()), "expectedRevision": failed_private["revision"]}, expected=422)
        assert rotated_admin.request("/api/v1/admin/platformclaw/skills/failed-round-proof/edit-proof") == failed_private
        assert sql("select count(*) from platformclaw_skill_edit_receipt") == receipt_count
    rotated_admin.publish("failed-round-proof", "2.0.0")
    repaired = rotated_admin.request("/api/v1/admin/platformclaw/skills/failed-round-proof/edit-proof")
    repaired = rotated_admin.request(failed_path, "PATCH", {**failed_edit, "operationId": str(uuid.uuid4()), "expectedRevision": repaired["revision"]})
    assert repaired["visibility"] == "PUBLIC" and repaired["effectiveVisibility"] == "PRIVATE"
    assert repaired["reviewVersions"] == ["2.0.0"]
    for _ in range(90):
        if sql(f"select status from skill_version where skill_id={failed_id} and version='2.0.0'") == "PENDING_REVIEW":
            break
        time.sleep(1)
    else:
        raise AssertionError("A new Private release did not repair the no-eligible-version sharing path")
    rotated_admin.request("/api/v1/admin/platformclaw/skills/failed-round-proof/edit-proof/versions/2.0.0/approve-safe", "POST", {"comment": "New Private release restores a valid sharing path"})
    assert rotated_admin.request("/api/v1/admin/platformclaw/skills/failed-round-proof/edit-proof")["effectiveVisibility"] == "PUBLIC"
    # Exercise both actual terminal-failure producers while PRIVATE auto-published
    # releases keep their recorded publication fact and immutable artifact rows.
    rotated_admin.request("/api/v1/namespaces", "POST", {"slug": "terminal-task-proof", "displayName": "Terminal task proof", "description": "Durable scanner failure proof"})
    docker("exec", redis, "redis-cli", "ACL", "SETUSER", "default", "-xadd")
    try:
        terminal_id = rotated_admin.publish("terminal-task-proof")["skillId"]
        unedited = rotated_admin.request("/api/v1/admin/platformclaw/skills/terminal-task-proof/edit-proof")
        assert sql(f"select platformclaw_managed_metadata from skill where id={terminal_id}") == "f"
        rotated_admin.publish("terminal-task-proof", "0.9.0", "PUBLIC", expected=409)
        assert rotated_admin.request("/api/v1/admin/platformclaw/skills/terminal-task-proof/edit-proof") == unedited
        assert sql(f"select count(*) from skill_version where skill_id={terminal_id}") == "1"
        delivery_version = sql(f"select id from skill_version where skill_id={terminal_id} and version='1.0.0'")
        # Put the real durable delivery on its last configured attempt; the actual
        # producer still receives Redis NOPERM and owns the terminal transition.
        sql(f"update scan_task_outbox set retry_count=9,next_attempt_at=CURRENT_TIMESTAMP where version_id={delivery_version} and status='PENDING'")
        for _ in range(90):
            if sql(f"select count(*) from security_audit where skill_version_id={delivery_version} and platformclaw_failed_at is not null") == "1":
                break
            time.sleep(1)
        else:
            raise AssertionError("Actual outbox failure did not record its terminal audit")
        assert sql(f"select status from scan_task_outbox where version_id={delivery_version}") == "FAILED"
        assert sql(f"select status from skill_version where id={delivery_version}") == "PUBLISHED"
        failed_audit = rotated_admin.request(f"/api/v1/skills/{terminal_id}/versions/{delivery_version}/security-audit")[0]
        assert failed_audit.get("failedAt") and not failed_audit.get("scannedAt")
    finally:
        docker("exec", redis, "redis-cli", "ACL", "SETUSER", "default", "+xadd")
    terminal_archive = rotated_admin.request("/api/v1/skills/terminal-task-proof/edit-proof/versions/1.0.0/download", raw=True)
    # Repair the exact persisted pre-fix PUBLISHED + FAILED outbox state without
    # guessing that every unfinished background audit has exhausted its task.
    sql(f"update security_audit set platformclaw_failed_at=null where skill_version_id={delivery_version}")
    failure_migration = (Path(__file__).parent / "overlay/server/skillhub-app/src/main/resources/db/migration/R__platformclaw_scan_task_identity.sql").read_text()
    for _ in range(2):
        reapplied = subprocess.run(["docker", "exec", "-i", pg, "psql", "-U", "skillhub", "-d", "skillhub", "-v", "ON_ERROR_STOP=1"], input=failure_migration, capture_output=True, text=True)
        assert reapplied.returncode == 0, reapplied.stderr
    assert sql(f"select count(*) from security_audit where skill_version_id={delivery_version} and platformclaw_failed_at is not null") == "1"
    docker("stop", "--time", "1", scanner)
    try:
        rotated_admin.publish("terminal-task-proof", "1.1.0")
        execution_version = sql(f"select id from skill_version where skill_id={terminal_id} and version='1.1.0'")
        for _ in range(90):
            if sql(f"select count(*) from security_audit where skill_version_id={execution_version} and platformclaw_failed_at is not null") == "1":
                break
            time.sleep(1)
        else:
            raise AssertionError("Actual scanner retry exhaustion did not record its terminal audit")
        assert sql(f"select status from skill_version where id={execution_version}") == "PUBLISHED"
        assert sql(f"select status from scan_task_outbox where version_id={execution_version}") == "SENT"
        terminal_versions = sql(f"select id||':'||version from skill_version where skill_id={terminal_id} order by id")
        terminal_metadata = rotated_admin.request("/api/v1/admin/platformclaw/skills/terminal-task-proof/edit-proof")
        terminal_path = f"/api/v1/admin/platformclaw/skills/{terminal_id}"
        terminal_edit = {"operationId": str(uuid.uuid4()), "skillId": terminal_id, "namespace": "terminal-task-proof", "slug": "edit-proof",
            "expectedRevision": terminal_metadata["revision"], "targetNamespace": "terminal-task-proof", "displayName": terminal_metadata["displayName"], "summary": terminal_metadata["summary"], "visibility": "PUBLIC"}
        terminal_shared = rotated_admin.request(terminal_path, "PATCH", terminal_edit)
        assert terminal_shared["visibility"] == "PUBLIC" and terminal_shared["effectiveVisibility"] == "PRIVATE"
        assert terminal_shared["reviewVersions"] == ["1.0.0", "1.1.0"]
        for _ in range(90):
            if sql(f"select count(*) from skill_version where skill_id={terminal_id} and status='SCAN_FAILED'") == "2":
                break
            time.sleep(1)
        else:
            raise AssertionError("Fresh shared scan rounds did not record the actual scanner outage")
        assert sql(f"select count(*) from skill_version where skill_id={terminal_id} and published_at is not null") == "2"
        collision_registration = Client(base)
        collision_registration.request("/api/v1/auth/methods")
        registered = collision_registration.request("/api/v1/auth/local/register", "POST", {"username": "proofcollisionadmin", "password": password + "Aa1!", "email": "proofcollisionadmin@example.invalid"})
        admin.request(f"/api/v1/admin/users/{registered['userId']}/role", "PUT", {"role": "SUPER_ADMIN"})
        collision_admin = Client(base)
        collision_admin.request("/api/v1/auth/methods")
        collision_admin.request("/api/v1/auth/direct/login", "POST", {"provider": "local", "username": "proofcollisionadmin", "password": password + "Aa1!"})
        collision_admin.publish("terminal-task-proof", "2.0.0", expected=400)
        assert sql("select count(*) from skill s join namespace n on n.id=s.namespace_id where n.slug='terminal-task-proof'") == "1"
        terminal_private = rotated_admin.request(terminal_path, "PATCH", {**terminal_edit, "operationId": str(uuid.uuid4()), "expectedRevision": terminal_shared["revision"], "visibility": "PRIVATE"})
        rotated_admin.publish("terminal-task-proof", "1.0.0", expected=400)
        assert sql(f"select id||':'||version from skill_version where skill_id={terminal_id} order by id") == terminal_versions
    finally:
        docker("start", scanner)
    for _ in range(90):
        if docker("inspect", scanner, "--format", "{{.State.Health.Status}}") == "healthy":
            break
        time.sleep(1)
    else:
        raise AssertionError("Scanner did not recover after the owned outage")
    terminal_shared = rotated_admin.request(terminal_path, "PATCH", {**terminal_edit, "operationId": str(uuid.uuid4()), "expectedRevision": terminal_private["revision"]})
    assert terminal_shared["effectiveVisibility"] == "PRIVATE" and terminal_shared["reviewVersions"] == ["1.0.0", "1.1.0"]
    for _ in range(90):
        if sql(f"select count(*) from skill_version where skill_id={terminal_id} and status='PENDING_REVIEW'") == "2":
            break
        time.sleep(1)
    else:
        raise AssertionError("Terminal audit facts did not prepare recoverable durable SAFE rounds")
    for version in ("1.0.0", "1.1.0"):
        rotated_admin.request(f"/api/v1/admin/platformclaw/skills/terminal-task-proof/edit-proof/versions/{version}/approve-safe", "POST", {"comment": "Actual terminal failure recovered through fresh SAFE round"})
    assert rotated_admin.request("/api/v1/admin/platformclaw/skills/terminal-task-proof/edit-proof")["effectiveVisibility"] == "PUBLIC"
    assert sql(f"select id||':'||version from skill_version where skill_id={terminal_id} order by id") == terminal_versions
    assert rotated_admin.request("/api/v1/skills/terminal-task-proof/edit-proof/versions/1.0.0/download", raw=True) == terminal_archive
    # Upgrade real v0.2.16 schema/data with both PRIVATE and PUBLISHED pending
    # audit rounds. The patched Flyway migration repairs their durable task identity.
    sql("CREATE DATABASE legacy OWNER skillhub")
    volume = PREFIX + "-legacy-storage"
    docker("volume", "create", volume)
    volumes.append(volume)
    docker("run", "--rm", "--name", PREFIX + "-volume-init", "--user", "0", "-v", volume + ":/data", "--entrypoint", "sh", IMAGE, "-c", "chown app:app /data")
    # Separate deployments require independent Redis state as well as databases;
    # otherwise unrelated publication quotas and sessions contaminate upgrade proof.
    legacy_redis = start("legacy-redis", "platformclaw-skillhub-redis:e7723ff73d96")
    legacy_args = ["-p", "127.0.0.1::8080", "-v", volume + ":/tmp/skillhub-storage",
        "-e", "SPRING_DATASOURCE_URL=jdbc:postgresql://" + pg + ":5432/legacy",
        "-e", "SPRING_DATASOURCE_USERNAME=skillhub", "-e", "SPRING_DATASOURCE_PASSWORD=" + password,
        "-e", "SPRING_DATA_REDIS_HOST=" + legacy_redis,
        "-e", "SKILLHUB_SCAN_STREAM_KEY=" + PREFIX + ":legacy-scans",
        "-e", "SKILLHUB_DOWNLOAD_ANON_COOKIE_SECRET=" + secrets.token_hex(32),
        "-e", "BOOTSTRAP_ADMIN_ENABLED=true", "-e", "BOOTSTRAP_ADMIN_USERNAME=proofadmin",
        "-e", "BOOTSTRAP_ADMIN_PASSWORD=" + password, "-e", "SKILLHUB_AUTH_DIRECT_ENABLED=true",
        "-e", "SKILLHUB_SECURITY_SCANNER_ENABLED=true", "-e", "SKILLHUB_SECURITY_SCANNER_MODE=upload",
        "-e", "SKILLHUB_SECURITY_SCANNER_URL=http://" + scanner + ":8000", "-e", "SKILLHUB_SCANNER_USE_BEHAVIORAL=false",
        "-e", "SKILLHUB_BUILTIN_SKILLS_ENABLED=false", "-e", "SKILLHUB_SEARCH_SEMANTIC_ENABLED=false"]
    def ready_client(container):
        url = "http://127.0.0.1:" + docker("port", container, "8080/tcp").split(":")[-1]
        for _ in range(90):
            try:
                urllib.request.urlopen(url + "/actuator/health", timeout=2).close()
                client = Client(url)
                client.request("/api/v1/auth/methods")
                client.request("/api/v1/auth/direct/login", "POST", {"provider": "local", "username": "proofadmin", "password": password})
                return client
            except (urllib.error.URLError, TimeoutError, http.client.RemoteDisconnected):
                time.sleep(1)
        raise AssertionError("Legacy upgrade server did not become ready")
    def legacy_sql(statement):
        return docker("exec", pg, "psql", "-U", "skillhub", "-d", "legacy", "-At", "-v", "ON_ERROR_STOP=1", "-c", statement)
    docker("pause", scanner)
    old_server = start("legacy-old", "platformclaw-skillhub-server:6e133c006e49", *legacy_args)
    old_client = ready_client(old_server)
    old_client.request("/api/v1/namespaces", "POST", {"slug": "legacy-proof", "displayName": "legacy-proof", "description": "Upgrade proof"})
    old_client.publish("legacy-proof")
    old_client.publish("legacy-proof", "1.1.0")
    assert legacy_sql("select count(*) from security_audit where scanned_at is null") == "2"
    legacy_sql("update skill_version set status='SCANNING' where version='1.0.0'")
    legacy_ids = legacy_sql("select id||':'||version from skill_version order by id")
    legacy_package = old_client.request("/api/v1/skills/legacy-proof/edit-proof/versions/1.1.0/download", raw=True)
    legacy_backup = docker("exec", pg, "pg_dump", "-U", "skillhub", "--no-owner", "legacy")
    docker("stop", "--time", "1", old_server)
    upgraded_server = start("legacy-upgraded", IMAGE, *legacy_args)
    upgraded_client = ready_client(upgraded_server)
    assert legacy_sql("select count(*) from security_audit where task_id='platformclaw-legacy-'||id and scanned_at is null") == "2"
    assert legacy_sql("select count(*) from scan_task_outbox") == "2"
    migration = (Path(__file__).parent / "overlay/server/skillhub-app/src/main/resources/db/migration/R__platformclaw_scan_task_identity.sql").read_text()
    for _ in range(2):
        reapplied = subprocess.run(["docker", "exec", "-i", pg, "psql", "-U", "skillhub", "-d", "legacy", "-v", "ON_ERROR_STOP=1"], input=migration, capture_output=True, text=True)
        assert reapplied.returncode == 0, reapplied.stderr
    assert legacy_sql("select count(*) from scan_task_outbox") == "2"
    # Pre-upgrade Redis messages cannot claim the newly authoritative audit.
    docker("exec", legacy_redis, "redis-cli", "XADD", PREFIX + ":legacy-scans", "*", "taskId", "obsolete-v16-delivery", "versionId", "1", "bundleKey", "packages/1/1/bundle.zip", "scannerType", "skill-scanner")
    docker("unpause", scanner)
    for _ in range(90):
        if legacy_sql("select count(*) from security_audit where scanned_at is not null") == "2":
            break
        time.sleep(1)
    else:
        raise AssertionError("Legacy durable scans did not complete after upgrade")
    assert legacy_sql("select status from skill_version where version='1.1.0'") == "PUBLISHED"
    assert legacy_sql("select status from skill_version where version='1.0.0'") == "UPLOADED"
    for _ in range(20):
        if "obsolete-v16-delivery" in docker("logs", upgraded_server):
            break
        time.sleep(0.25)
    else:
        raise AssertionError("Obsolete v16 delivery did not produce an intentional skip record")
    assert legacy_sql("select id||':'||version from skill_version order by id") == legacy_ids
    sql("CREATE DATABASE legacyrestore OWNER skillhub")
    restore = subprocess.run(["docker", "exec", "-i", pg, "psql", "-U", "skillhub", "-d", "legacyrestore", "-v", "ON_ERROR_STOP=1"], input=legacy_backup, capture_output=True, text=True)
    assert restore.returncode == 0, restore.stderr
    restore_args = [arg.replace(":5432/legacy", ":5432/legacyrestore").replace(PREFIX + ":legacy-scans", PREFIX + ":restored-scans") for arg in legacy_args]
    restored_server = start("legacy-restored", "platformclaw-skillhub-server:6e133c006e49", *restore_args)
    restored_client = ready_client(restored_server)
    restored_ids = docker("exec", pg, "psql", "-U", "skillhub", "-d", "legacyrestore", "-At", "-c", "select id||':'||version from skill_version order by id")
    assert restored_ids == legacy_ids
    assert restored_client.request("/api/v1/skills/legacy-proof/edit-proof/versions/1.1.0/download", raw=True) == legacy_package
    assert docker("exec", pg, "psql", "-U", "skillhub", "-d", "legacyrestore", "-At", "-c", "select max(version::integer) from flyway_schema_history where version is not null") == "43"
    print(json.dumps({"ok": True, "proof": ["session/CSRF", "atomic rollback", "metadata", "namespace move", "immutable IDs/package bytes", "receipt replay", "conflicting replay/stale revision", "search projection", "later publication persistence", "visibility conflict", "target collision", "concurrent replay", "pending review identity/namespace", "publication freeze ordering", "approval preserves edited metadata", "real stored-bundle scanner", "private-to-shared review gate", "older private versions gated", "PRIVATE edit before approval", "approved sharing reuse without rescanning", "exact older-version review beyond global page", "latest approved review identity", "historical review uses current coordinate", "SCANNING approval rejected", "explicit native force of non-SAFE audit", "scan outbox rollback", "atomic SAFE approval rejects stale unsafe state", "managed shared publication requires review", "production Node governance/adapter HTTP transport", "real v0.2.16 Flyway pending-scan upgrade", "legacy PUBLISHED autoscan retained", "obsolete Redis delivery intentionally skipped", "legacy scan repair SQL idempotent", "first shared bearer publication requires scanner/review", "real PostgreSQL backup restore to stock v0.2.16", "rollback retains immutable release bytes and numeric IDs", "FROZEN namespace permits exact privacy restriction", "ARCHIVED namespace permits exact privacy restriction", "inactive namespace rejects profile/move/broaden edits", "PRIVATE compensation receipt replay", "native force approval after compensation stays PRIVATE", "rotated trusted admin replays exact receipt", "regular user cannot replay privileged receipt", "rotated admin changed-body replay rejected", "receipt replay preserves original audit actor", "failed private scans create fresh durable tasks", "failed scans remain private until SAFE review", "terminal-only releases reject sharing atomically", "new Private release restores sharing path", "unedited audience changes require metadata edit", "published delivery failure records terminal audit", "published scanner failure records terminal audit", "failed outbox audit repair is idempotent", "ever-published versions reject replacement after failed rescan", "managed historical publication reserves coordinate", "terminal scan rounds recover through fresh durable tasks", "new publication retains historical prepared review"]}))
except Exception:
    if "server" in globals():
        print(docker("logs", "--tail", "45", server, check=False), file=sys.stderr)
    raise
finally:
    for container in reversed(containers):
        docker("rm", "-f", "-v", container, check=False)
    for volume in volumes:
        docker("volume", "rm", volume, check=False)
    docker("network", "rm", PREFIX, check=False)
