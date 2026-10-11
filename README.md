# Solo Empire remote MCP

ปลายทาง MCP แบบ Streamable HTTP บน Cloudflare Workers ใช้ URL เดิมข้ามการเปิด
แชตและการ restart โดยไม่ต้องเปิดเครื่องหลักค้างไว้ บริการนี้เป็นช่องทาง agent
สำหรับเรียก API ที่มีเจ้าของและโฮสต์ของตนเอง ไม่ย้าย SQLite หรือรวม business
runtime เข้าด้วยกัน

## สถานะที่ตรวจจริง — 4 ตุลาคม 2026

- Hosted endpoint: `https://solo-empire-mcp-remote.bookchaowalit.workers.dev/mcp`
- SDK client ใหม่เชื่อมต่อ, list และ call ได้; ไม่มี token ตอบ `401`
- Codex bridge process ใหม่เรียก remote ได้ และตั้งค่า user-level config แล้ว
- AI, Agency CRM และ Income CRM ตอบ health `200`; อ่าน workspace ของ CRM
  ทั้งสองได้ การอ่าน AI status ยัง `not_configured` หากไม่มี token ที่ gateway ยอมรับ
- พบ Income read timeout หนึ่งรอบใน smoke test แรก จึงเพิ่ม deadline จาก 8 เป็น
  15 วินาที หลัง deploy รุ่นแก้ไข อ่าน CRM ทั้งสองผ่านจาก client SDK ใหม่สองชุด
  และ bridge process ใหม่ที่ดึงสิทธิ์จาก Infisical โดยไม่ใส่ token ใน config
- ยังไม่ได้สังเกต uptime ต่อเนื่อง 24 ชั่วโมง และยังไม่ครอบคลุม local MCP ทุก tool

ตรวจซ้ำโดยพิมพ์เฉพาะผล protocol/สถานะ ไม่พิมพ์ข้อมูล workspace:

```bash
python3 verify.py
python3 verify.py --bridge
```

## ขอบเขต

| Tool | บริการ | สิทธิ์ |
|---|---|---|
| `list_remote_services` | รายการ upstream และสถานะการตั้งค่า | metadata |
| `check_remote_services` | health ของ AI, Agency CRM และ Income CRM | GET; ไม่คืน body |
| `get_ai_status` | Central AI Gateway | GET `/api/ai/status` |
| `get_agency_workspace` | Agency CRM | GET workspace |
| `get_income_workspace` | Income CRM | GET workspace |

MCP เดิมใน `solo-empire/infra/mcp-server/` ยังเป็น local และมีเครื่องมือเพิ่มเติมที่พึ่ง
SQLite, filesystem และ Python เครื่องมือเหล่านั้นไม่ได้กลายเป็น hosted โดย
อัตโนมัติ การเพิ่ม upstream ต้องมี API ที่ deploy แล้วและผ่านการตรวจสิทธิ์ก่อน
ไม่มี arbitrary HTTP proxy, remote shell, การส่งข้อความ หรือ AI generation
ในปลายทาง remote รุ่นนี้

## การยืนยันตัวตนและ client

เก็บ `SOLO_MCP_REMOTE_TOKEN` ใน Infisical `/mcp` เท่านั้น Worker รับเพียง
SHA-256 hash ใน binding `MCP_TOKEN_SHA256` ข้อมูล discovery ไม่มี secret
`PUBLIC_ORIGIN` ต้องตรงกับ origin ที่ deploy; browser Origin ถูกปฏิเสธหาก
ไม่ได้ allowlist เครื่องมืออ่านข้อมูลต้องมี upstream token ที่ service นั้น
ยอมรับ จึงต้องทดสอบ read endpoint เพิ่มจาก public health

Codex ใช้ `launch.py` และ `bridge.mjs` เป็นตัวเชื่อม protocol ที่ดึง token จาก
Infisical เมื่อเริ่ม client ไม่มี `npx` และไม่มี token ฝังใน config งานและข้อมูล
อยู่บน hosted APIs เครื่องใหม่ต้องติดตั้ง package นี้และยืนยันตัวตน Infisical
ครั้งแรก หลังจากนั้นใช้ config เดิมได้จนกว่าสิทธิ์ของ secret manager จะหมดอายุ
หาก session หมดอายุยังต้อง login secret manager ใหม่; ไม่อ้างว่า auth ไม่มีวัน
หมดอายุ Client ที่รองรับ HTTPS โดยตรงใช้ endpoint `/mcp` กับ Bearer token จาก
secret manager ของ client ได้

## ตรวจและ deploy

```bash
npm ci
npm test
npm run typecheck
npm run build
python3 tests/manage_test.py
python3 manage.py status
python3 manage.py bootstrap
python3 manage.py deploy
python3 manage.py configure --endpoint https://solo-empire-mcp-remote.bookchaowalit.workers.dev/mcp
```

`status` ตรวจ provider และพิมพ์ชื่อ plan/สถานะโดยไม่เปิดเผยค่า secret
`bootstrap` สร้าง key เฉพาะเมื่อยืนยันได้ว่าไม่มีอยู่ และบันทึกใน Infisical
พร้อม readback ก่อนนำไปใช้ `deploy` ใช้ Cloudflare account/token ผ่าน runtime
resolver; secrets ส่งให้ Wrangler ผ่าน stdin ไม่ผ่าน command arguments
deploy แรกยังตอบ `503` จนกว่าจะมี auth hash บริการนี้ไม่มี storage binding,
cron หรือการ provision VPS และไม่เปลี่ยน service เดิม

Upstream credentials ที่ยังอ่านไม่ได้จะแสดง `not_configured` ไม่มีการสมมติว่า
public health `200` ยืนยันการเข้าถึงข้อมูล เครื่องมือรอได้สูงสุด 15 วินาทีต่อ
upstream จำกัด input 64 KiB และ output 512 KiB ไม่ติดตาม redirect และไม่คืน
error body ของ provider

การตรวจ URL จริงต้องครอบคลุมไม่มี token `401`, SDK initialize/list/call,
client ใหม่ที่ URL เดิม และการอ่าน upstream ที่มี token บันทึกผลเฉพาะ metadata
การสังเกตความพร้อมต่อเนื่อง 24 ชั่วโมงต้องมีหลักฐานแยกจาก smoke test รอบเดียว

Rollback: ปิด client entry `solo-empire-remote` และย้อน Worker version ของ
`solo-empire-mcp-remote` ผ่าน Cloudflare deployment history การ rollback ไม่
ต้องเปลี่ยน database หรือ service ของ upstream


## ที่มา / การย้าย

ย้ายมาจาก `solo-empire/infra/mcp-remote/` (2026-10-11) พร้อมประวัติ git. Worker ที่ deploy แล้ว: `solo-empire-mcp-remote` บน Cloudflare Workers (`wrangler.toml` อยู่ที่ root ของ repo นี้; deploy ผ่าน `python3 manage.py deploy` เท่านั้น).

`manage.py` และ `launch.py` ใช้ `secret_resolver.py` จาก solo-empire (`$SOLO_EMPIRE_ROOT/infra/scripts/utils`, ค่าเริ่มต้น `~/solo-empire`).
ถ้า MCP client ตั้งค่าไว้ที่ `infra/mcp-remote/launch.py` ต้องแก้เป็น path ของ repo นี้ (`<clone>/launch.py`).
