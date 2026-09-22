from pathlib import Path
path = Path('client/src/components/VercelControlPlane.tsx')
text = path.read_text()
for name in ['Observability', 'Domains', 'Connect', 'Storage', 'Usage', 'WorkspaceSettings', 'SecurityCenter']:
    text = text.replace(f'function {name}(', f'export function {name}(', 1)
path.write_text(text)
