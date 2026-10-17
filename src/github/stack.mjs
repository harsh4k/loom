// Builds a readable tech stack ("React 19, Vite 6, Tailwind CSS 4, TypeScript") from a repo's
// manifest files and GitHub's language list. Only known names are used, so nothing is made up.

// Dependency name -> readable name. Versions are added for JavaScript packages when the major
// version can be read from package.json.
const JS = {
  next: 'Next.js', react: 'React', vue: 'Vue', svelte: 'Svelte', '@sveltejs/kit': 'SvelteKit', astro: 'Astro',
  nuxt: 'Nuxt', '@angular/core': 'Angular', 'solid-js': 'Solid', 'react-native': 'React Native', expo: 'Expo',
  electron: 'Electron', '@tauri-apps/api': 'Tauri', vite: 'Vite', webpack: 'webpack',
  tailwindcss: 'Tailwind CSS', 'styled-components': 'styled-components', sass: 'Sass', bootstrap: 'Bootstrap',
  '@mui/material': 'Material UI', '@chakra-ui/react': 'Chakra UI', 'framer-motion': 'Framer Motion', motion: 'Motion', gsap: 'GSAP',
  three: 'Three.js', '@react-three/fiber': 'React Three Fiber', '@react-three/drei': 'Drei', lenis: 'Lenis', '@studio-freight/lenis': 'Lenis',
  express: 'Express', fastify: 'Fastify', hono: 'Hono', koa: 'Koa', '@nestjs/core': 'NestJS', 'socket.io': 'Socket.IO',
  prisma: 'Prisma', '@prisma/client': 'Prisma', 'drizzle-orm': 'Drizzle', mongoose: 'MongoDB', mongodb: 'MongoDB', pg: 'PostgreSQL',
  mysql2: 'MySQL', redis: 'Redis', ioredis: 'Redis', '@supabase/supabase-js': 'Supabase', firebase: 'Firebase', 'firebase-admin': 'Firebase',
  stripe: 'Stripe', 'next-auth': 'NextAuth', '@clerk/nextjs': 'Clerk', zustand: 'Zustand', '@reduxjs/toolkit': 'Redux', 'redux': 'Redux',
  '@tanstack/react-query': 'TanStack Query', 'react-router-dom': 'React Router', 'react-router': 'React Router', zod: 'Zod', trpc: 'tRPC', '@trpc/server': 'tRPC',
  openai: 'OpenAI API', '@anthropic-ai/sdk': 'Anthropic API', '@google/generative-ai': 'Gemini API', '@google/genai': 'Gemini API', ai: 'Vercel AI SDK', langchain: 'LangChain',
  'chart.js': 'Chart.js', recharts: 'Recharts', d3: 'D3', '@playwright/test': 'Playwright', playwright: 'Playwright', jest: 'Jest', vitest: 'Vitest',
  typescript: 'TypeScript', wrangler: 'Cloudflare Workers', '@vercel/analytics': 'Vercel Analytics',
};
const VERSIONED = new Set(['Next.js', 'React', 'Vue', 'Svelte', 'Astro', 'Nuxt', 'Angular', 'Vite', 'Tailwind CSS', 'Express', 'Electron', 'Three.js']);
const PY = {
  django: 'Django', flask: 'Flask', fastapi: 'FastAPI', streamlit: 'Streamlit', torch: 'PyTorch', tensorflow: 'TensorFlow',
  numpy: 'NumPy', pandas: 'pandas', 'scikit-learn': 'scikit-learn', sklearn: 'scikit-learn', opencv: 'OpenCV', 'opencv-python': 'OpenCV',
  psutil: 'psutil', requests: 'Requests', sqlalchemy: 'SQLAlchemy', pydantic: 'Pydantic', openai: 'OpenAI API', anthropic: 'Anthropic API',
  langchain: 'LangChain', transformers: 'Transformers', pyqt5: 'PyQt', pyqt6: 'PyQt', pyside6: 'Qt for Python', tkinter: 'Tkinter', customtkinter: 'CustomTkinter',
  'gputil': 'GPUtil', 'nvidia-ml-py': 'NVML', pynvml: 'NVML', selenium: 'Selenium', playwright: 'Playwright', 'beautifulsoup4': 'Beautiful Soup',
};
const RUST = { tokio: 'Tokio', axum: 'Axum', 'actix-web': 'Actix Web', serde: 'Serde', tauri: 'Tauri', bevy: 'Bevy', clap: 'clap', reqwest: 'reqwest', sqlx: 'SQLx' };
const LANGUAGE_SHARE = 0.03;
const MAX_ITEMS = 12;

function majorVersion(spec) {
  const match = /^[\^~>=v\s]*(\d+)\./.exec(String(spec ?? ''));
  return match && Number(match[1]) > 0 ? match[1] : null;
}

function fromPackageJson(text) {
  let pkg;
  try { pkg = JSON.parse(text); } catch { return []; }
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const names = [];
  for (const [name, spec] of Object.entries(deps)) {
    const label = JS[name];
    if (!label) continue;
    const version = VERSIONED.has(label) ? majorVersion(spec) : null;
    names.push(version ? `${label} ${version}` : label);
  }
  return names;
}

function pythonNames(lines) {
  const names = [];
  for (const line of lines) {
    const name = /^\s*["']?([A-Za-z0-9_.-]+)/.exec(line)?.[1]?.toLowerCase();
    if (name && PY[name]) names.push(PY[name]);
  }
  return names;
}

function fromPyproject(text) {
  // Dependencies are listed one per line as "name>=1.0", inside dependencies = [...] or a
  // [tool.poetry.dependencies] table; both are read line by line.
  return pythonNames(text.split(/\r?\n/).map((line) => line.replace(/^\s*-\s*/, '')));
}

function fromCargo(text) {
  const names = [];
  let inDeps = false;
  for (const line of text.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]/.exec(line)?.[1];
    if (section) { inDeps = /dependencies$/.test(section); continue; }
    const name = inDeps ? /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1] : null;
    if (name && RUST[name]) names.push(RUST[name]);
  }
  return ['Rust', ...names];
}

// `languages` is GitHub's { Language: bytes } map. `files` maps a manifest name to its text.
export function buildTechStack({ languages = {}, files = {} } = {}) {
  const items = [];
  if (files['package.json']) items.push(...fromPackageJson(files['package.json']));
  if (files['Cargo.toml']) items.push(...fromCargo(files['Cargo.toml']));
  if (files['pyproject.toml']) items.push(...fromPyproject(files['pyproject.toml']));
  if (files['requirements.txt']) items.push(...pythonNames(files['requirements.txt'].split(/\r?\n/)));
  const total = Object.values(languages).reduce((sum, bytes) => sum + (Number(bytes) || 0), 0);
  const languageNames = Object.entries(languages)
    .filter(([, bytes]) => total > 0 && Number(bytes) / total >= LANGUAGE_SHARE)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
  items.push(...languageNames);
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const key = item.replace(/\s+\d+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique.slice(0, MAX_ITEMS).join(', ');
}
