# Progressive 360

Browser demo for **equirectangular 360° video**: a **Three.js** sphere with inner **VideoTexture** and **OrbitControls** (drag to look around). Static files can be served locally or with **Nginx**.

## Requirements

| Item | Notes |
|------|--------|
| OS | **Linux** (incl. WSL); paths and commands assume a Unix shell |
| Browser | WebGL + modern ES modules |
| Nginx | Optional — [nginx.org](https://nginx.org/en/) |

## Getting started

### 1. Local static server

From the repository root:

```bash
python3 -m http.server 8080
```
Then open **`http://127.0.0.1:8080/`** in a browser (change the port if you use another).

### 2. Sample video (`video.mp4`)

The app expects **`video.mp4`** in the **same directory** as `index.html` (see `main.js` → `video.src`).

- Place your own file there for development.

### 3. Nginx (optional)

1. Set `root` to this project (or a copy under `/var/www/...`) and `listen` on your port (e.g. `8088`).
2. Check config and reload:

   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

3. Open **`http://127.0.0.1:8088/`** (or your chosen port).

Keep filenames in sync with `main.js` / `index.html`.

## LAN access & WSL

- Other devices on the same Wi‑Fi: use the host **LAN IPv4** (e.g. Windows `ipconfig`) and port, e.g. `http://192.168.x.x:8088/`.
- If **`127.0.0.1` works but the LAN IP does not**, check **Windows firewall** inbound rules.

---

**Author:** JinyangLi · **Date:** 2026-05-01
