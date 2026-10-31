# Frame — Video Library

A small self-hosted video site with season selection, episode selection, browser playback, and chunked uploads. It uses only Node.js built-in modules, so there are no packages to install.

## Run it

1. Install Node.js 18 or newer.
2. In this folder, run `npm start` (or `node server.js`).
3. Open [http://localhost:3000](http://localhost:3000).

The first run creates `data/episodes.json`, `data/videos/`, and a temporary uploads folder. Episode videos are stored on the same machine as the server. Back up the `data/` folder to preserve your library.

## Large video uploads

The browser sends each video in sequential 5 MB pieces. The server assembles them on disk and streams playback with byte-range support, so uploads larger than 200 MB work without raising a traditional single-request body limit. The accepted file types are MP4, WebM, MOV, M4V, and OGV. Available disk space is the practical size limit.

To make the site reachable over the internet, host it on a machine with enough storage and bandwidth, and use HTTPS. Configure any reverse proxy in front of it to allow request bodies of at least 8 MB, since each request contains one upload piece. Keep the server private or add authentication before exposing it publicly; this starter is intended for a trusted local network or personal use.
