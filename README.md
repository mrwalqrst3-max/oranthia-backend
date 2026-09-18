# أترايثيا (Oranthia) — عالـم الأساطير 🗺️

خادم لعبة كامل ومستقل مبني بنفس معمارية Clash of Legends المثبتة (Stateless) مع **عالم خرائط نصية** بنظام Last-Fight وبوابة دخول عند **المستوى 25**.

## البنية المعمارية

| الجزء | التفصيل |
|---|---|
| الخادم | Node.js، عديم الحالة (Stateless)، مناسب لـ Render/Falix |
| الحفظ | `database.json` بكتابات ذرّية (tmp + fsync + rename) + نسخة احتياطية `.bak` |
| الإدارة | `POST /admin_commands` (تحديث لاعب، قبائل، حظر أجهزة) |
| السجلات | `server_logs` بتلخيص عربي للطلبات |
| الاسترجاع | `_server_backup` من أجهزة اللاعبين يعيد البيانات العالمية المفقودة (آمن مع إعادة النشر) |
| العالم | خرائط نصية بصيغة Last-Fight في مجلد `worlds/` |

## بوابة العالم (المستوى 25)

لا يستطيع أي لاعب دخول عالم أترايثيا قبل بلوغ **المستوى 25** — يُفرض من السيرفر (ليست مجرد واجهة):

```
POST /world/enter   { username, map }
→ قبل 25:  403  { locked: true, required: 25, ... }
→ بعد 25:  200  { success: true, mapdata: "<الخريطة النصية>", online: [...] }
```

غير ذلك للخادم كافٍ لتغييرها عبر متغير `WORLD_GATE_LEVEL`.

## واجهات العالم

| الطريقة | المسار | الوصف |
|---|---|---|
| POST | `/world/enter` | دخول العالم (بوابة 25) ويعيد الخريطة والحاضرين |
| POST | `/world/move` | حركة server-authoritative `{username,map,x,y,z}` |
| POST | `/world/message` | دردشة الخريطة |
| GET | `/world/status` | البوابات + قائمة الخرائط + المتصلون |
| GET | `/world/map/<name>` | جلب نص الخريطة |
| GET | `/world/presence/<map>` | الحاضرون داخل خريطة |
| GET | `/world/chat/<map>` | آخر رسائل الخريطة |
| GET | `/healthz` | فحص صحة + مستوى البوابة |

## صيغة الخريطة (Last-Fight)

```text
mapname: أترايثيا — العاصمة الأسطورية
maxx: 200
maxy: 200
maxz: 40
platform:minx:maxx:miny:maxy:minz:maxz:type
staircase:minx:maxx:miny:maxy:minz:maxz:type:dir:reverse
zone:minx:maxx:miny:maxy:minz:maxz:اسم:trackable
sign:x:y:z:النص
door:...:exitdoor
music: amb_city
amb: amb_city
reverb: ...
```

## التشغيل المحلي

```bash
npm start        # تعمل على المنفذ 3000 (أو PORT)
npm test         # 18 اختباراً شاملاً (البوابة، الحركة، الدردشة، REST، الحفظ)
```

على Render: استخدم `render.yaml`، وضع `ADMIN_TOKEN` سراً، و`WORLD_GATE_LEVEL=25`.

## ملاحظة أمان

أي توكن GitHub يُرسل في دردشة يعتبر مكشوفاً — يُنصح بإلغائه فوراً من GitHub Settings → Developer settings → Personal access tokens، بعد الانتهاء من الرفع.