# World Champions Draft — Railway Backend-Heavy Version

Versi ini dibuat supaya frontend tetap ultra-light untuk HP low-end.

## Inti arsitektur

- `public/app.js` hanya menangani klik, fetch request, patch HTML, dan animasi ringan.
- Semua logic game berada di backend `server.js`.
- Database pemain berada di `data/players.json`, bukan di folder `public`.
- Folder `data/` dan `server.js` tidak diserve ke browser.
- CSS dan desain tidak diubah.

## Jalankan lokal

```bash
npm start
```

Buka:

```text
http://localhost:3000
```

Atau Windows:

```text
start-windows.bat
```

## Deploy ke Railway

1. Buat repo GitHub private.
2. Upload semua file di folder ini ke root repo, jadi `package.json` harus sejajar dengan `server.js`.
3. Railway → New Project → Deploy from GitHub Repo.
4. Pilih repo.
5. Railway otomatis memakai `railway.json` dan menjalankan `npm start`.
6. Setelah deploy selesai: Settings → Networking → Generate Domain.

Struktur repo yang benar:

```text
repo-root/
  package.json
  railway.json
  server.js
  data/
    players.json
  public/
    app.js
    index.html
    style.css
    assets/
```

Jangan upload dengan struktur seperti ini:

```text
repo-root/
  football-draft-world-champions/
    package.json
    server.js
```

Kalau tetap pakai folder dalam repo, set Railway Root Directory ke folder tersebut.

## Catatan penting tentang hidden logic

Logic game tidak terlihat dari browser karena tidak ada formula, data penuh, atau simulasi di folder `public`.

Kalau repo GitHub dibuat public, source backend tetap bisa dilihat dari GitHub. Jadi gunakan GitHub private agar logic tidak terlihat publik.
