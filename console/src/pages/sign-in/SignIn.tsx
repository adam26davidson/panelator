import { Icon } from "../../shared/ui/Icon.tsx";
import { SCREENS, type ScreenName } from "../../widgets/nav/nav.tsx";

/** Sign-in card: after GitHub accepts the maintainer's login the app returns to the screen named here. */
export function SignIn({ screen, returnTo = "/" }: { screen: ScreenName; returnTo?: string }) {
  const label = SCREENS.find((s) => s.id === screen)?.label ?? screen;
  return (
    <div className="c-root">
      <div className="c-signin">
        <div className="c-card">
          <div className="c-eyebrow">panelator · maintainer console</div>
          <h1>Sign in to see {label}</h1>
          <p className="c-muted">
            Your session has ended or you have not signed in on this device. Only the maintainer's GitHub login can sign
            in.
          </p>
          <a className="c-btn c-gh" href={`/auth/login?return=${encodeURIComponent(returnTo)}`}>
            {Icon.github()} Sign in with GitHub
          </a>
          <p className="c-sm c-muted">After sign-in you return to {label}.</p>
        </div>
      </div>
    </div>
  );
}

/** Shown when GitHub returned another login or the `state` did not match; the API has recorded the attempt. */
export function SignInRefused({ login }: { login?: string }) {
  return (
    <div className="c-root">
      <div className="c-signin">
        <div className="c-card">
          <div className="c-eyebrow">panelator · maintainer console</div>
          <h1>This login can't use the console</h1>
          <div className="c-note refused" style={{ textAlign: "left" }}>
            {Icon.x()}
            <span>
              GitHub signed you in as <b>{login ? `@${login}` : "another account"}</b>. The console admits only the
              maintainer's login, and this attempt has been recorded.
            </span>
          </div>
          <a className="c-btn" href="/auth/login">
            {Icon.github()} Sign in with a different GitHub account
          </a>
        </div>
      </div>
    </div>
  );
}
