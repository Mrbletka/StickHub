# Notebook

StickHub app `notebook` (engine `node-server`). Made with `node hub/cli.mjs new`.

## Rules
- Listen on `process.env.PORT` at 127.0.0.1 (the hub picks the port).
- Keep saves in `process.env.HUB_DATA_DIR` through this server (`PUT /api/save` in the starter). They sync with the stick.
- Browser storage (localStorage, IndexedDB) is NOT synced: do not keep saves there.
- Stop cleanly on SIGTERM (the hub kills after 3 s).
- Node built-ins only. Run alone: `PORT=4100 node server.mjs`.
- Opens full screen in the hub player (an iframe on its own port). Phone first: about 423x930 CSS px, touch, no hover.
- Replace `icon.svg` with your own icon (svg, png or webp).
