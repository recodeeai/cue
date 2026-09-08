import { useState } from "react";
import styles from "./Welcome.module.css";

export function Welcome({ onBrowse }: { onBrowse: () => void }) {
  const [notice, setNotice] = useState("");
  async function copy(command: string) {
    setNotice("Copy requested. If your browser does not allow it, select and copy the displayed command manually.");
    try {
      await navigator.clipboard.writeText(command);
      setNotice("Command copied. Review it, then run it in your terminal.");
    } catch {
      setNotice("Clipboard unavailable. Select and copy the command below.");
    }
  }
  return (
    <main className={styles.page}>
      <p className={styles.eyebrow}>CUECARDS · THE CUE COMMUNITY</p>
      <h1>Find your next<br /><span>agent profile.</span></h1>
      <p className={styles.intro}>Cue gives each project the skills, tools and instructions its coding agent needs. Discover how other people work, inspect their profiles, and try them with the Cue CLI on your own machine.</p>
      <div className={styles.actions}>
        <button className="de-btn primary" onClick={onBrowse}>Browse community profiles →</button>
        <a href="https://github.com/opencue/cuecards" target="_blank" rel="noopener noreferrer">Explore Cue on GitHub ↗</a>
      </div>
      <div className={styles.steps}>
        <section><span className={styles.number}>01 / SET UP</span><h2>Bring Cue to your project</h2><p>Install the CLI, then run setup inside your project. Setup helps you choose your agent and profile.</p><code>npm install -g cue-ai</code><button className="de-btn" onClick={() => void copy("npm install -g cue-ai")}>Copy install command</button><code>cue setup</code></section>
        <section><span className={styles.number}>02 / EXPLORE</span><h2>Review before you run</h2><p>Browse shared profiles and inspect their source. Copy a profile’s install command into your terminal. Community hooks, skills and MCP servers can execute code: only use sources you trust.</p><button className="de-btn" onClick={onBrowse}>Find a profile</button></section>
        <section><span className={styles.number}>03 / MAKE IT YOURS</span><h2>Open your local Studio</h2><p>Run this in your project to manage your actual profiles. This public site does not connect to or control your computer.</p><code>cue dashboard</code><button className="de-btn" onClick={() => void copy("cue dashboard")}>Copy dashboard command</button><a href="http://127.0.0.1:7891" target="_blank" rel="noopener noreferrer">Open local Studio after starting Cue ↗</a></section>
      </div>
      <p className={styles.note}>Share a profile from Marketplace using its public GitHub source. Community publishing needs an account; browsing does not. Studio previews show sample data, not your machine.</p>
      <p role="status">{notice}</p>
    </main>
  );
}
