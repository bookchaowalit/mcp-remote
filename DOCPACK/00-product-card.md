---
title: solo-mcp-remote — Product Card
doc_id: CARD-solo-mcp-remote
doc_type: product-card
verdict: invest
version: 0.1
date: 2026-10-11
status: ร่างเพื่อพิจารณา
owner: Product owner (Book Dev)
---

# solo-mcp-remote — Product Card

## 1. สรุปคุณค่าในหนึ่งประโยค

ให้ agent เรียก API ของ Solo Empire ผ่าน MCP endpoint ถาวรบน Cloudflare โดยไม่ต้องเปิดเครื่องหลักค้างไว้

## 2. ปัญหาและผู้ใช้เป้าหมาย

agent ต้องการ endpoint MCP ที่ URL คงที่ข้ามแชตและ restart ผู้ใช้คือเจ้าของและ agent

## 3. สิ่งที่ทำได้จริงตอนนี้

- Worker ใน `src/` เสิร์ฟ `/mcp`; ไม่มี token ตอบ 401 (ตาม README ที่ตรวจเมื่อ 2026-10-04)
- `bridge.mjs`, `verify.py`, `smoke.mjs` สำหรับ smoke และเชื่อม Codex
- README ระบุ AI, Agency CRM, Income CRM ตอบ health 200 ตอนตรวจ; เทสต์ 2 ไฟล์

## 4. หลักฐานสถานะ

| รายการ | ค่า |
|---|---|
| Stack | TypeScript (Cloudflare Workers), MCP |
| Commit | 3 ครั้ง (2026-10-04 ถึง 2026-10-11) |
| ซอร์สโค้ด | 6 ไฟล์ / 710 บรรทัด |
| เทสต์ | 2 ไฟล์ (ไม่ได้รันในงานนี้) |
| CI | ไม่มี workflow |
| Deploy config | `wrangler.toml` (Cloudflare Workers) |
| Live URL | https://solo-empire-mcp-remote.bookchaowalit.workers.dev/mcp (ตามที่ตรวจใน README 2026-10-04; ไม่ได้ probe ซ้ำ) |

## 5. คุณค่าและจุดต่าง

- เป็นช่องทาง agent ถาวรแทนการ tunnel เครื่อง
- **[สมมติฐาน]** ไม่มีมูลค่าขาย

## 6. ช่องว่างสำคัญ

- ผลตรวจใน README เก่ากว่าทะเบียนที่เปลี่ยนวันนี้ **[ต้องยืนยัน]** ว่า tool list ยังตรงกัน
- ไม่มี CI

## 7. คำตัดสิน

**`invest`** — เป็นช่องทางที่ agent ใช้เข้าถึงระบบ และมี smoke ตรวจจริง จะเปลี่ยนเป็น `showcase` หากเปลี่ยนไปใช้ MCP แบบอื่น

## 8. ขั้นต่อไป

1. รัน `verify.py`/`smoke.mjs` ใหม่หลังย้าย cell วันนี้

## การอนุมัติ

| บทบาท | สถานะ | วันที่ | ลงนาม |
|---|---|---|---|
| Product owner (Book Dev) | รอพิจารณา | — | ________ |

## แหล่งข้อมูล

- `README.md`
- `src/`, `verify.py`, `wrangler.toml`
