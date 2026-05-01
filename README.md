# Progressive 360

A browser demo that plays **equirectangular 360° video** with **Three.js**: a sphere with an inner **VideoTexture** and **OrbitControls** for drag-to-look. Static files can be served by **Nginx** for local and LAN testing.

---

## Requirements

- **Linux** (validated on Linux / WSL)
- **Nginx** (optional, for static hosting closer to production) — see [nginx.org](https://nginx.org/en/)

---

## Quick start (local static server)

From the project root, run any static HTTP server, for example:

```bash
python3 -m http.server 8080
```
Open in a browser: `http://127.0.0.1:8080/` (use the port you chose).
---

## Nginx

1. Point `root` at this repository (or copy/sync under `/var/www/...`) and set `listen` to your port (e.g. `8088`).
2. Run `sudo nginx -t`, then `sudo systemctl reload nginx`.
3. Open `http://127.0.0.1:8088/` locally. 

Keep the video filename and format in sync with what you reference in `main.js` / `index.html`.

---

## LAN access

On the same Wi‑Fi, other devices can use the host’s **LAN IPv4** (e.g. from `ipconfig` on Windows) plus the port, e.g. `http://192.168.x.x:8088/`. If only `127.0.0.1` works but the LAN IP does not, check firewall rules and WSL port forwarding / mirrored networking.

---

*2026-05-01 — JinyangLi*
