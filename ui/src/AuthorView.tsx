export function AuthorView({returnTo}: {returnTo: string}) {
  return <main id="author" aria-label="Author" className="author-view">
    <article>
      <header>
        <p className="author-role">Open ECU Studio author</p>
        <h1>Animesh Roy</h1>
        <span className="author-handle">@anir0y</span>
      </header>
      <p className="author-bio">Animesh is a security researcher and consultant with over a decade of experience. He builds interactive labs and teaches workshops on hardware and radio security. He also founded the Vapra Shiksha Foundation.</p>
      <ul aria-label="Public profiles">
        <li><a href="https://anir0y.in/" target="_blank" rel="noreferrer">Personal website <span aria-hidden="true">↗</span></a></li>
        <li><a href="https://classroom.anir0y.in/" target="_blank" rel="noreferrer">Training and labs <span aria-hidden="true">↗</span></a></li>
        <li><a href="https://github.com/anir0y" target="_blank" rel="noreferrer">GitHub <span aria-hidden="true">↗</span></a></li>
      </ul>
      <a className="author-return" href={returnTo}>Return to lab</a>
    </article>
  </main>;
}
