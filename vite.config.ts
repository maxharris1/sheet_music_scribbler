/// <reference types="vitest/config" />
import { createReadStream, cpSync, existsSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// ngrok / tunnel hosts allowed to reach the dev + preview servers.
const TUNNEL_HOSTS = ['.ngrok-free.app', '.ngrok.app', '.ngrok.dev', '.trycloudflare.com'];

const PDFJS_WASM_SRC = fileURLToPath(new URL('./node_modules/pdfjs-dist/wasm', import.meta.url));
const PDFJS_WASM_PUBLIC = '/pdfjs-wasm';

/** Serve / copy pdf.js WASM decoders (JBIG2 / OpenJPEG) required by pdf.js 5.x. */
const pdfjsWasmPlugin = (): Plugin => ({
    name: 'pdfjs-wasm',
    configureServer(server) {
        server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith(`${PDFJS_WASM_PUBLIC}/`)) {
                next();
                return;
            }
            // Strip query string (cache busters) and map onto node_modules/pdfjs-dist/wasm.
            const rel = req.url.slice(PDFJS_WASM_PUBLIC.length + 1).split('?')[0] ?? '';
            const filePath = fileURLToPath(new URL(rel, `file://${PDFJS_WASM_SRC}/`));
            if (!filePath.startsWith(PDFJS_WASM_SRC) || !existsSync(filePath)) {
                res.statusCode = 404;
                res.end('Not found');
                return;
            }
            if (filePath.endsWith('.wasm')) {
                res.setHeader('Content-Type', 'application/wasm');
            } else if (filePath.endsWith('.js')) {
                res.setHeader('Content-Type', 'application/javascript');
            }
            createReadStream(filePath).pipe(res);
        });
    },
    writeBundle(outputOptions) {
        const outDir = outputOptions.dir ?? 'dist';
        cpSync(PDFJS_WASM_SRC, `${outDir}${PDFJS_WASM_PUBLIC}`, { recursive: true });
    },
});

export default defineConfig({
    plugins: [
        react(),
        tailwindcss(),
        pdfjsWasmPlugin(),
        VitePWA({
            registerType: 'autoUpdate',
            includeAssets: ['icons/apple-touch-icon.png', 'favicon.svg'],
            manifest: {
                name: 'Cleffy',
                short_name: 'Cleffy',
                description: 'Real-time collaborative sheet music annotation',
                // Keep in sync with the @theme palette in src/index.css (accent / paper)
                // and the theme-color meta in index.html.
                theme_color: '#4338ca',
                background_color: '#f7f5ef',
                display: 'standalone',
                orientation: 'any',
                icons: [
                    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
                    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
                    { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
                ],
            },
            workbox: {
                // App shell only. Supabase traffic must never be cached by the SW;
                // PDFs are cached as blobs in IndexedDB (see plan §sync), not here.
                globPatterns: ['**/*.{js,css,html,png,svg,woff2,wasm}'],
                navigateFallback: '/index.html',
                navigateFallbackDenylist: [/^\/auth\/callback/],
                maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
                // Piano samples (~2.8 MB, 87 files) are deliberately NOT precached —
                // they load on first Play and then replay (and work offline) from here.
                runtimeCaching: [
                    {
                        urlPattern: /\/audio\/piano\//,
                        handler: 'CacheFirst',
                        options: {
                            cacheName: 'piano-samples',
                            expiration: { maxEntries: 100 },
                        },
                    },
                ],
            },
        }),
    ],
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
        },
    },
    server: {
        allowedHosts: TUNNEL_HOSTS,
    },
    preview: {
        allowedHosts: TUNNEL_HOSTS,
    },
    test: {
        environment: 'jsdom',
        setupFiles: ['./src/test/setup.ts'],
        include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    },
});
