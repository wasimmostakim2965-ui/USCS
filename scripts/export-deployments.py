from pathlib import Path
path = Path('client/src/components/VercelControlPlane.tsx')
text = path.read_text().replace('function Deployments(', 'export function Deployments(', 1)
path.write_text(text)
