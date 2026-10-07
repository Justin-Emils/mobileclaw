-- Point the app at the local mock OpenAI endpoint.
--
-- Used by the device-testing flow. Written as a file rather than an inline
-- `adb shell sqlite3 "..."` because nesting quotes through adb shell mangles the SQL,
-- and the device's sqlite3 has no json_set() (only core functions), so the whole value
-- is replaced instead of patched.
--
-- The JSON mirrors the shape the app writes, with only the provider block changed. If
-- AppConfig gains a field, re-read the row and extend this rather than guessing.
UPDATE kv_store
SET value = '{"provider":{"baseUrl":"http://10.0.2.2:8787/v1","model":"mock-model","temperature":0.2,"maxSteps":12,"label":"Mock (local)"},"permissions":{"defaultMode":"ask","riskModes":{"read":"allow","network":"allow","write":"ask","execute":"ask","system":"ask"},"rules":[{"tool":"shizuku_run","decision":"deny"}],"alwaysAskRisks":["execute","system"]},"roots":["/data/user/0/dev.mobileclaw.app/files/","/data/user/0/dev.mobileclaw.app/cache/","/storage/emulated/0/Download","/storage/emulated/0/Documents","/storage/emulated/0/DCIM","/storage/emulated/0/Pictures"],"useMockProvider":false}',
    updated_at = 1791000000000
WHERE key = 'mobileclaw.config';

-- Let the permission dialog appear again on the next launch.
DELETE FROM kv_store WHERE key = 'flag:storage.permissionPrompted';
