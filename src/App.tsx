import "./App.css";
const milestones = [
  "Workspace Shell",
  "Local Terminal",
  "SSH V1",
  "Portable Data & Credentials",
  "SFTP",
];
function App() {
  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">RH</span>
          <div>
            <strong>RemoteHand</strong>
            <span>Portable workstation manager</span>
          </div>
        </div>
        <span className="phase-badge">Foundation</span>
      </header>
      <section className="workspace">
        <aside className="sidebar">
          <div className="sidebar-heading">Connections</div>
          <button className="new-connection" type="button">
            + New connection
          </button>
          <div className="empty-state">Saved connections will appear here.</div>
        </aside>

        <section className="canvas">
          <div className="welcome-card">
            <p className="eyebrow">Milestone 0</p>
            <h1>RemoteHand foundation is running.</h1>
            <p>
              The desktop shell is ready for the dockable workspace, local
              terminal, SSH, portable credentials, and SFTP milestones.
            </p>
            <div className="milestone-grid">
              {milestones.map((milestone, index) => (
                <div className="milestone" key={milestone}>
                  <span>{index + 1}</span>
                  <strong>{milestone}</strong>
                </div>
              ))}
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}
export default App;
