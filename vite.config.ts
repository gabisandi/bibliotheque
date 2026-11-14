import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Build a static reader; editorial credentials never enter its client bundle. */
export default defineConfig({ plugins: [react()], server: { port: 5173 } });
