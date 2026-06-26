# World Champions Draft - Ultra-Light SSR

Versi ini dibuat untuk HP low-end: frontend dibuat sangat ringan, sedangkan proses berat dipindahkan ke backend Node.js.

## Arsitektur

- Backend: Node.js native `http` server.
- Frontend: Vanilla JS kecil di `public/app.js`.
- Rendering berat: server-side HTML partial rendering dari `server.js`.
- CSS/design: `public/style.css` tidak diubah dari ZIP sumber.

## Yang dipindahkan ke server

- Render daftar pemain.
- Render pitch slot.
- Render role slot picker.
- Filter/search pemain.
- Validasi role compatibility.
- Validasi slot kosong/penuh.
- State draft aktif.
- Simulasi turnamen.
- Render hasil campaign.

Frontend sekarang hanya menangani klik, request ke server, dan menempel HTML fragment ke DOM.

## Cara menjalankan local

Pastikan Node.js sudah terinstall.

```bash
cd football-draft-world-champions
node server.js
```

Buka browser:

```text
http://localhost:3000
```

Atau di Windows bisa klik dua kali:

```text
start-windows.bat
```

Jika port 3000 bentrok:

```bash
set PORT=3001
node server.js
```

Lalu buka:

```text
http://localhost:3001
```

## Catatan deploy

Versi ini butuh backend Node.js. Cocok untuk VPS, Railway, Render, Fly.io, atau cPanel yang support Node.js App. Untuk Vercel serverless perlu refactor session ke Redis/KV.
