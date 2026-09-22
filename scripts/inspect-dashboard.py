from pathlib import Path
import re
source = Path('client/src/components/VercelControlPlane.tsx').read_text()
for match in re.finditer(r'^function\s+(\w+)', source, re.M):
    print(match.group(1), source[:match.start()].count('\n') + 1)
