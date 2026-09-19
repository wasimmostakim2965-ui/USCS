import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const dist = new URL('../dist/', import.meta.url);
const base = await readFile(new URL('index.html', dist), 'utf8');

const routes = {
  platform: { title: 'Paywai Platform — Payments, Balances & Financial Control', description: 'Explore the Paywai platform for payments, balances, cashflow visibility and financial controls.', canonical: 'https://xonomo.site/platform', robots: 'index,follow,max-image-preview:large' },
  signin: { title: 'Sign in to Paywai — Global Financial Account', description: 'Sign in to your Paywai account.', canonical: 'https://xonomo.site/signin', robots: 'noindex,nofollow' },
  signup: { title: 'Create your Paywai account — Global Financial Platform', description: 'Create your Paywai account.', canonical: 'https://xonomo.site/signup', robots: 'noindex,nofollow' },
  dashboard: { title: 'Paywai Dashboard — Your Financial Workspace', description: 'Paywai account dashboard.', canonical: 'https://xonomo.site/dashboard', robots: 'noindex,nofollow' }
};

for (const [route, meta] of Object.entries(routes)) {
  const html = base
    .replace(/<title>[^<]*<\\/title>/, '<title>' + meta.title + '</title>')
    .replace(/<meta name="description" content="[^"]*" \/>/, '<meta name="description" content="' + meta.description + '" />')
    .replace(/<meta name="robots" content="[^"]*" \/>/, '<meta name="robots" content="' + meta.robots + '" />')
    .replace(/<link rel="canonical" href="[^"]*" \/>/, '<link rel="canonical" href="' + meta.canonical + '" />')
    .replace(/<meta property="og:title" content="[^"]*" \/>/, '<meta property="og:title" content="' + meta.title + '" />')
    .replace(/<meta property="og:description" content="[^"]*" \/>/, '<meta property="og:description" content="' + meta.description + '" />')
    .replace(/<meta property="og:url" content="[^"]*" \/>/, '<meta property="og:url" content="' + meta.canonical + '" />');
  const target = join(dist.pathname, route, 'index.html');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, html, 'utf8');
};
