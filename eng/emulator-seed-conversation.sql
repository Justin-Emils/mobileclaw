-- Seed a conversation row so the history screen can be verified on a device.
--
-- The app writes `conversation:<id>` -> JSON(Conversation) into kv_store. Writing a row
-- by hand tests the read path (list + hydrate) without needing a working model, which is
-- exactly the half of "history survives a restart" that a device can show.
--
-- Shape mirrors Conversation in packages/core/src/types.ts. If that interface changes,
-- update this too.
DELETE FROM kv_store WHERE key LIKE 'conversation:%';

INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (
  'conversation:conv_seed_device_test',
  '{"id":"conv_seed_device_test","title":"设备验证：请列出下载目录","createdAt":1791000000000,"updatedAt":1791000500000,"model":"mock-model","messages":[{"role":"user","content":"请列出下载目录里的文件","at":1791000000000},{"role":"assistant","content":"## 已完成的检查\n\n我把 `/storage/emulated/0/Download` 走了一遍：\n\n| 文件 | 大小 | 类型 |\n| :--- | ---: | :---: |\n| report.pdf | 2048 | PDF |\n| notes.md | 44 | 文本 |\n\n**结论**：共 2 个文件，没有异常大的。\n\n- 没有发现日志文件","at":1791000500000}],"entries":[{"kind":"message","id":"entry_1","at":1791000000000,"role":"user","text":"请列出下载目录里的文件"},{"kind":"tool","id":"entry_2","at":1791000200000,"callId":"call_seed","name":"fs_list","input":{"path":"/storage/emulated/0/Download"},"status":"ok","durationMs":12},{"kind":"message","id":"entry_3","at":1791000500000,"role":"assistant","text":"已列出"}],"allowlist":["fs_list"],"workspace":"/data/user/0/dev.mobileclaw.app/files/workspaces/conv_seed_device_test"}',
  1791000500000
);
