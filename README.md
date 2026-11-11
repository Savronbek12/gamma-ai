# Gamma AI — Gamma-AI.uz

> Suhbatlashadigan va fanlar bo'yicha mutaxassis ustoz.
>
> Yaratuvchi: **Savronbek**

30 ta fan bo'yicha professor darajasidagi, rasmiy uslubda muloqot qiladigan sun'iy intellekt sayti.
Sun'iy intellekt: **Groq** (bepul, standart, model `openai/gpt-oss-120b`), **Google Gemini** (bepul) yoki **Claude** (pullik) — `AI_PROVIDER` sozlamasi bilan tanlanadi.

## Imkoniyatlar
- 30 ta fan (matematika, fizika, kimyo, tarix, huquq, tibbiyot, iqtisodiyot va boshqalar) bo'yicha savollarga javob
- Chap panelda suhbatlar ro'yxati: har bir suhbat mavzusiga qarab avtomatik nomlanadi va saqlanadi (qidirish, o'chirish mumkin)
- Rasmiy, akademik uslub, "Siz" deb murojaat; foydalanuvchi tilida javob (standart — o'zbek tili)
- Ochiq Wikipedia'dan (uz / ru / en) savolga oid ma'lumot avtomatik qidiriladi va modelga beriladi; manbalar javob ostida havola sifatida ko'rsatiladi (API kaliti kerak emas, `WIKIPEDIA=off` bilan o'chiriladi)
- Rasm yaratish: 🖼 tugmasi yoki «… rasmini chizib bering» kabi so‘rov. Google Gemini (`GEMINI_API_KEY`, billing yoqilgan bo‘lishi kerak) yoki ChatGPT rasm modeli (`OPENAI_API_KEY`). Ikkalasi bo‘lsa, `IMAGE_PROVIDER` birinchisini tanlaydi, ikkinchisi zaxira. Kalit bo‘lmasa, 🖼 tugmasi ko‘rinmaydi
- Javob real vaqtda yoziladi (streaming); Markdown, jadvallar va LaTeX formulalar qo'llab-quvvatlanadi
- Yorug' / qorong'i mavzu, telefon uchun moslashgan dizayn
- Suhbat tarixi foydalanuvchi brauzerida saqlanadi
- Daqiqasiga so'rovlar cheklovi (suiiste'moldan himoya)

## 1. Kompyuterda ishga tushirish
1. https://console.groq.com/keys saytida ro'yxatdan o'ting va bepul **Groq API kalit** oling (**Create API Key**).
2. `.env.example` faylini `.env` nomi bilan nusxalang va `GROQ_API_KEY=` qatoriga kalitni yozing.
3. Terminalda:
   ```
   npm install
   npm start
   ```
4. Brauzerda oching: http://localhost:3000

> API kalitini hech kimga bermang va GitHub'ga yuklamang (`.env` fayli `.gitignore`da).

## 2. Internetga chiqarish (hosting)
Node.js qo'llab-quvvatlaydigan istalgan server mos keladi:
- **VPS** (masalan, O'zbekistondagi ahost.uz, uzhost.uz yoki xorijiy DigitalOcean/Hetzner): Ubuntu o'rnatib, Node.js 22+, `npm install`, so'ng `pm2 start server.js --node-args="--env-file=.env"` bilan doimiy ishlatiladi. Oldiga Nginx (reverse proxy) va Let's Encrypt (HTTPS) qo'yiladi.
- **Render.com / Railway.app**: loyihani GitHub'ga yuklab, "Web Service" yarating, `npm start` buyrug'ini va `GROQ_API_KEY` muhit o'zgaruvchisini kiriting.

Nginx uchun streaming ishlashi uchun muhim sozlama:
```
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

## 3. Gamma-AI.uz domenini ulash
1. `.uz` domenlari faqat akkreditatsiyadan o'tgan registratorlar orqali sotiladi (ro'yxat: **cctld.uz**). Masalan: ahost.uz, webname.uz, uzinfocom va boshqalar.
2. Avval `gamma-ai.uz` bo'shligini tekshiring va sotib oling (domenlar katta-kichik harfni farqlamaydi: Gamma-AI.uz = gamma-ai.uz).
3. Registrator panelida DNS yozuvlarini qo'shing:
   - `A` yozuv: `@` → serveringiz IP manzili
   - `A` yozuv: `www` → serveringiz IP manzili (yoki `CNAME www → gamma-ai.uz`)
   - Render/Railway ishlatsangiz — ular bergan `CNAME` manzilini kiriting.
4. HTTPS sertifikat: VPS'da `sudo certbot --nginx -d gamma-ai.uz -d www.gamma-ai.uz`.

## Sozlash
- Fanlar ro'yxati: `subjects.js`
- Gamma AI xulq-atvori va uslubi (tizim ko'rsatmasi): `server.js` ichidagi `BASE_SYSTEM`
- Provayder va model: `.env` faylida `AI_PROVIDER` (groq / gemini / claude) va `GAMMA_MODEL`. Mos ravishda `GROQ_API_KEY`, `GEMINI_API_KEY` yoki `ANTHROPIC_API_KEY` kerak.
