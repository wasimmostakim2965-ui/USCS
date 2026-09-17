const metadata = {
  app: 'sovereign-vault-ocm2bx',
  version: '1789648935761',
}

function App() {
  return (
    <main className="shell">
      <section className="card" aria-labelledby="title">
        <div className="eyebrow">Sovereign Vault</div>
        <h1 id="title">Source snapshot connected</h1>
        <p className="lead">
          This repository is now Vercel-ready. The uploaded archive contained
          metadata placeholders rather than the original application screens or
          business logic.
        </p>
        <div className="details">
          <div><span>AppDeploy app</span><strong>{metadata.app}</strong></div>
          <div><span>Snapshot version</span><strong>{metadata.version}</strong></div>
          <div><span>Build system</span><strong>Vite + React + TypeScript</strong></div>
        </div>
        <p className="note">
          Replace this screen with the complete AppDeploy source when it is
          available; the project structure and production build command are
          already configured.
        </p>
      </section>
    </main>
  )
}

export default App
