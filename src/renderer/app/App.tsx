export function App() {
  return (
    <div className="app">
      <header className="tabs">
        <span className="brand">PACT</span>
        <button className="tab">Accueil</button>
        <button aria-label="Nouvel onglet">＋</button>
        <span className="spacer" />
        <button aria-label="Réglages">⚙</button>
      </header>
      <nav className="toolbar">
        <button>Tuiles</button>
        <button disabled>Comparer</button>
        <button disabled>Revue</button>
        <span className="spacer" />
        <button>
          À faire <b>0</b>
        </button>
        <button className="primary">＋ Agents</button>
      </nav>
      <main className="stage">
        <section className="home">
          <div className="hero">
            <p className="legend">◆ attend · ✓ prêt · ✕ erreur · ⎇ branche</p>
            <h1>
              Vos agents.
              <br />
              Un espace de travail.
            </h1>
            <p className="lede">
              Ouvrez un dépôt Git, lancez vos agents en parallèle et gardez chaque terminal sous
              contrôle.
            </p>
            <div className="drop">
              <h2>Déposez un dépôt Git ici</h2>
              <p>ou choisissez un dossier existant</p>
              <button className="primary">Choisir un dépôt Git…</button>
              <p>
                <button>Cloner depuis une URL…</button>
              </p>
            </div>
            <div className="detected">
              <span>
                <b className="dot">●</b> Claude Code
              </span>
              <span>
                <b className="dot">●</b> Codex
              </span>
              <span>＋ Autre CLI</span>
            </div>
          </div>
        </section>
        <aside className="todo">
          <h2>À faire</h2>
          <div className="empty">
            <div>
              <div style={{ fontSize: 32 }}>✓</div>
              <p>Rien à faire</p>
              <small>Vous serez prévenu ici.</small>
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}
